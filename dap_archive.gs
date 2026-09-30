// ================================================================================
// dap_archive.gs - ARCHIVO DE FUNCIONES PUNTUALES DE COMPLETADO Y REPARACIÓN DE DATOS
// ================================================================================
// Este archivo NO ejecuta nada: todo el código está comentado línea a línea (prefijo "// ").
//
// Contiene las funciones que se crearon para COMPLETAR y REPARAR las bases de datos (Google Sheets
// y Notion) de forma puntual, y que se archivaron al llevar el proyecto a producción. El estado
// anterior completo del proyecto está en la etiqueta git `pre-produccion` (commit eecce51).
//
// Antes de archivarlas se corrigieron sus problemas (ver "Correcciones" en cada ficha) y quedaron
// probadas: el test local `tests/archive.test.js` descomenta este archivo en memoria y ejecuta sus
// escenarios, así que el código archivado sigue siendo válido y reactivable.
//
// CÓMO REACTIVAR UNA FUNCIÓN
//   1. Lee su ficha: cuándo usarla, dependencias que deben existir y orden de ejecución.
//   2. Selecciona SOLO las líneas entre `>>> CODE BEGIN <grupo>` y `<<< CODE END <grupo>` y quita
//      el comentario (en el editor de Apps Script: Ctrl+/ o Cmd+/ alterna comentarios de línea;
//      equivalente: buscar `^// ` y reemplazar por nada dentro de la selección).
//   3. Guarda, ejecuta y, al terminar, VUELVE A COMENTAR (o borra) el bloque: así no quedan
//      nombres globales duplicados ni funciones que modifican datos dentro del proyecto en producción.
//   4. Las funciones "Apply" MODIFICAN datos. Ejecuta primero la versión de simulación (solo log) y
//      revisa el resultado. Todas son idempotentes: repetirlas no repite cambios ya hechos.
//   5. Las ejecuciones largas tienen presupuesto de tiempo (4,5 min): si el log dice "truncado" o
//      "reejecuta", vuelve a ejecutar la misma función y continuará donde quedó.
//
// ARCHIVOS BORRADOS COMPLETOS (recuperables desde la etiqueta git `pre-produccion`)
//   - dap_repair.gs        -> BORRADO COMPLETO. Contenía auditCompletedDaps, repairCompletedDapsApply,
//                             _planSheetFixes y _repairCompletedDaps (ahora en el Grupo 4).
//   - dap_maintenance.gs   -> BORRADO COMPLETO. Contenía auditPendingDapOperaciones (Grupo 2),
//                             repairUfDapAmounts / repairUfDapAmountsApply / _repairUfDapAmounts
//                             (Grupo 3) y releaseDapQueue, que NO se archivó: sigue activa y se movió
//                             a dap_ops.gs (con la versión que usa el estado durable del Sheet).
// FUNCIONES MOVIDAS DESDE ARCHIVOS QUE SIGUEN EXISTIENDO
//   - dap_extractor.gs: backfillDapEmails (Grupo 1).
//   - notion.gs: _listAllNotionPages, _notionPageToDap, _planNotionDedupe, archiveNotionPage y
//     updateNotionDapAmount (Grupo 5).
//
// ÍNDICE Y ORDEN SI HUBIERA QUE REPETIR UN COMPLETADO COMPLETO (ej. migración a otra cuenta)
//   1. Grupo 1  backfillDapEmails()                    - encola los DAP históricos desde Gmail.
//   2. installDapApp() y responder las preguntas de Telegram (releaseDapQueue() si hay atascos).
//   3. Grupo 2  auditPendingDapOperaciones() y luego auditPendingDapOperacionesApply()
//                                                      - solo si el parser tuvo un bug de N° de operación.
//   4. Grupo 3  repairUfDapAmounts() y luego repairUfDapAmountsApply()
//                                                      - solo si hubo un bug de conversión de UF.
//   5. Grupo 4  auditCompletedDaps() y luego repairCompletedDapsApply()
//                                                      - completa y deduplica Sheet <-> Notion.
//   El Grupo 5 (ayudantes de Notion) no se ejecuta directamente: se reactiva junto con el Grupo 3 y el 4.
//
// TIPOS COMPARTIDOS (typedefs) - se incluyen en los grupos donde se usan
//   ExtractionSummary (definido en dap_extractor.gs, sigue activo).
//
// ================================================================================
// GRUPO 1 - backfillDapEmails
// ================================================================================
//   Nombre ............ backfillDapEmails(monthsBack?, maxThreads?)
//   Ubicación original  dap_extractor.gs, líneas 19-45 (commit eecce51), justo bajo processDapEmails().
//   Para qué servía ... Reprocesar correos históricos fuera de la ventana de 30 días del trigger, para
//                       poblar el Sheet con los DAP anteriores a la instalación (se usó con 18 meses).
//   Cuándo reutilizarla Al migrar a otro Sheet/cuenta, o tras corregir el parser para recuperar correos
//                       que quedaron con la etiqueta de error (quita antes esa etiqueta de esos hilos).
//   Dependencias ...... Activas y con el esquema validado: _runDapEmailExtraction, _buildDapSearchQuery
//                       (dap_extractor.gs), CONFIG.LIMITS.RUNTIME_BUDGET_MS, Utilities, Session.
//                       Propiedades: SHARED_SPREADSHEET_ID (y CMF_API_KEY si hay DAP en UF).
//   Orden de ejecución  ANTES: installDapApp(). DESPUÉS: responder Telegram (releaseDapQueue() si hace
//                       falta) y, opcionalmente, los Grupos 2-4.
//   Correcciones ...... Valida argumentos (meses 1-60, hilos 1-500); corrige el desborde de mes al
//                       restar meses (31 de marzo - 1 mes daba 3 de marzo); usa la consulta común (valida
//                       remitente y excluye correos ya procesados o con error); presupuesto de tiempo;
//                       devuelve un resumen. Idempotente: etiqueta + ID de mensaje + N° de operación.
//
// >>> CODE BEGIN grupo1-backfillDapEmails
// /**
//  * Reprocesa correos históricos de DAPs fuera de la ventana normal de 30 días. Ejecución manual.
//  * Es segura de re-ejecutar: nunca duplica DAP ya encolados (etiqueta de Gmail, ID de mensaje y
//  * N° de operación). Si hay más correos que `maxThreads` o se agota el tiempo, vuelve a ejecutarla.
//  * @param {number} [monthsBack=18] - Meses hacia atrás desde hoy (entero 1-60).
//  * @param {number} [maxThreads=500] - Máximo de hilos a traer en esta ejecución (entero 1-500).
//  * @returns {ExtractionSummary|null} Resumen de la corrida, o null si los argumentos no son válidos.
//  */
// function backfillDapEmails(monthsBack, maxThreads) {
//   const months = monthsBack === undefined ? 18 : monthsBack;
//   const limit = maxThreads === undefined ? 500 : maxThreads;
//
//   if (!Number.isInteger(months) || months < 1 || months > 60) {
//     console.error(`❌ Backfill: monthsBack debe ser un entero entre 1 y 60 (recibido: ${months}).`);
//     return null;
//   }
//   if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
//     console.error(`❌ Backfill: maxThreads debe ser un entero entre 1 y 500 (recibido: ${limit}).`);
//     return null;
//   }
//
//   // Se resta por meses sin desbordar (31 de marzo - 1 mes = 28/29 de febrero, no 3 de marzo)
//   const sinceDate = new Date();
//   const targetDay = sinceDate.getDate();
//   sinceDate.setDate(1);
//   sinceDate.setMonth(sinceDate.getMonth() - months);
//   const lastDayOfMonth = new Date(sinceDate.getFullYear(), sinceDate.getMonth() + 1, 0).getDate();
//   sinceDate.setDate(Math.min(targetDay, lastDayOfMonth));
//   const sinceStr = Utilities.formatDate(sinceDate, Session.getScriptTimeZone(), 'yyyy/MM/dd');
//
//   console.info(`🕓 Backfill: buscando DAPs desde ${sinceStr} (${months} meses atrás).`);
//
//   const summary = _runDapEmailExtraction({
//     query: _buildDapSearchQuery(`after:${sinceStr}`),
//     maxThreads: limit,
//     flushEveryThreads: 10,
//     maxRuntimeMs: CONFIG.LIMITS.RUNTIME_BUDGET_MS
//   });
//
//   console.info(`📊 Backfill: ${JSON.stringify(summary)}${summary.truncated ? ' — se agotó el tiempo: vuelve a ejecutar para continuar.' : ''}`);
//   return summary;
// }
// <<< CODE END grupo1-backfillDapEmails
//
// ================================================================================
// GRUPO 2 - auditPendingDapOperaciones
// ================================================================================
//   Nombre ............ auditPendingDapOperaciones() [simulación] y auditPendingDapOperacionesApply()
//                       (+ el núcleo privado _auditPendingDapOperaciones(apply))
//   Ubicación original  dap_maintenance.gs (BORRADO COMPLETO), líneas 22-78 (commit eecce51).
//   Para qué servía ... Reparar el N° de operación (ID_Operacion) de las filas que aún no llegaban a
//                       COMPLETADO, tras corregir un bug del parser que capturaba el N° de Transacción
//                       en vez del N° de Depósito: re-lee el correo original (ID_Mensaje_Email) con el
//                       parser actual y corrige el valor guardado.
//   Cuándo reutilizarla Solo tras corregir un bug del parser que haya dejado N° de operación errados en
//                       filas pendientes. No toca filas COMPLETADO (ya pueden estar en Notion).
//   Dependencias ...... Activas: parseBciDapEmailDetailed (dap_parser.gs), _openDapSheet,
//                       _normalizeOperationId, _withScriptLock, _hasTimeLeft (utils.gs), CONFIG.STATES,
//                       GmailApp.getMessageById.
//   Orden de ejecución  ANTES: haber desplegado el parser corregido y creado una nueva versión del Web App.
//                       DESPUÉS: continuar/retomar la cola de Telegram (releaseDapQueue()).
//   Correcciones ...... Compara como NÚMERO (antes comparaba texto con ceros a la izquierda contra un
//                       número y "corregía" todas las filas); simulación por defecto y versión Apply;
//                       valida la hoja/esquema; try por fila; lock y presupuesto de tiempo.
//
// >>> CODE BEGIN grupo2-auditPendingDapOperaciones
// /**
//  * @typedef {Object} AuditOperationSummary
//  * @property {number} revisadas - Filas pendientes con correo asociado revisadas.
//  * @property {number} corregidas - Filas cuyo N° de operación difería del que da el parser actual.
//  * @property {number} sinCorreo - Filas pendientes sin ID_Mensaje_Email.
//  * @property {number} errores - Correos que no se pudieron abrir o interpretar.
//  * @property {boolean} truncated - true si se agotó el presupuesto de tiempo.
//  */
//
// /**
//  * SIMULACIÓN: muestra en el log qué N° de operación se corregirían, sin modificar nada.
//  * @returns {AuditOperationSummary|null} Resumen, o null si no se obtuvo el lock.
//  */
// function auditPendingDapOperaciones() {
//   return _auditPendingDapOperaciones(false);
// }
//
// /**
//  * APLICA la corrección de N° de operación de las filas pendientes.
//  * @returns {AuditOperationSummary|null} Resumen, o null si no se obtuvo el lock.
//  */
// function auditPendingDapOperacionesApply() {
//   return _auditPendingDapOperaciones(true);
// }
//
// /**
//  * Núcleo de la auditoría de N° de operación de filas no COMPLETADAS.
//  * @private
//  * @param {boolean} apply - true para escribir los cambios; false solo para reportarlos.
//  * @returns {AuditOperationSummary|null} Resumen, o null si no se obtuvo el lock.
//  */
// function _auditPendingDapOperaciones(apply) {
//   const modo = apply ? 'APLICANDO' : 'SIMULACIÓN';
//   const summary = { revisadas: 0, corregidas: 0, sinCorreo: 0, errores: 0, truncated: false };
//
//   const result = _withScriptLock(() => {
//     const startMs = Date.now();
//     const sheet = _openDapSheet();
//     const data = sheet.getDataRange().getValues();
//
//     for (let i = 1; i < data.length; i++) {
//       const row = data[i];
//       if (row[DAP_COLS.Estado_Cola - 1] === CONFIG.STATES.COMPLETADO) continue;
//       if (!_hasTimeLeft(startMs)) {
//         summary.truncated = true;
//         break;
//       }
//
//       const idInterno = row[DAP_COLS.ID_Interno - 1];
//       const idMensaje = row[DAP_COLS.ID_Mensaje_Email - 1];
//       if (!idMensaje) {
//         summary.sinCorreo++;
//         continue;
//       }
//       summary.revisadas++;
//
//       try {
//         const parsed = parseBciDapEmailDetailed(GmailApp.getMessageById(idMensaje));
//         if (!parsed.ok) {
//           summary.errores++;
//           console.warn(`⚠️ [${modo}] DAP [${idInterno}]: el parser actual no pudo re-extraerlo (${parsed.error.code}). Revísalo manualmente.`);
//           continue;
//         }
//
//         const guardado = _normalizeOperationId(row[DAP_COLS.ID_Operacion - 1]);
//         const correcto = _normalizeOperationId(parsed.dto.ID_Operacion);
//         if (guardado !== correcto) {
//           summary.corregidas++;
//           console.info(`✏️ [${modo}] DAP [${idInterno}]: ID_Operacion ${guardado} → ${correcto}`);
//           if (apply) sheet.getRange(i + 1, DAP_COLS.ID_Operacion).setValue(correcto);
//         }
//       } catch (error) {
//         summary.errores++;
//         console.warn(`⚠️ [${modo}] DAP [${idInterno}]: no se pudo revisar el correo ${idMensaje}: ${error.message}`);
//       }
//     }
//
//     if (apply) SpreadsheetApp.flush();
//   }, 10000);
//
//   if (!result.acquired) {
//     console.warn('⚠️ Auditoría de N° de operación: No se pudo obtener el Lock. Reintenta en unos segundos.');
//     return null;
//   }
//
//   console.info(`✅ Auditoría de N° de operación [${modo}]: ${JSON.stringify(summary)}${summary.truncated ? ' — reejecuta para continuar.' : ''}`);
//   return summary;
// }
// <<< CODE END grupo2-auditPendingDapOperaciones
//
// ================================================================================
// GRUPO 3 - repairUfDapAmounts (reparación de montos de DAP en UF)
// ================================================================================
//   Nombre ............ repairUfDapAmounts() [simulación], repairUfDapAmountsApply()
//                       (+ el núcleo privado _repairUfDapAmounts(apply))
//   Ubicación original  dap_maintenance.gs (BORRADO COMPLETO), líneas 129-222 (commit eecce51).
//   Para qué servía ... Los DAP en UF se registraron como pesos (UF 4,4379 → $44.379). Esta función
//                       re-lee el correo de cada fila, detecta los que son UF, recalcula el monto en CLP
//                       con el valor de la UF a la fecha de captación y corrige Sheet y Notion.
//   Cuándo reutilizarla Solo si un bug de moneda/conversión volviera a dejar montos de UF mal guardados
//                       (incluye filas ya COMPLETADO, porque también corrige Notion).
//   Dependencias ...... Activas: parseBciDapEmailDetailed, _enrichWithClpAmount y getUfValue (uf.gs),
//                       _openDapSheet, _withScriptLock, _hasTimeLeft, CONFIG.STATES.
//                       ARCHIVADA (reactivar junto): updateNotionDapAmount (Grupo 5).
//                       Propiedades: CMF_API_KEY, NOTION_API_TOKEN.
//   Orden de ejecución  ANTES: parser y conversión de UF corregidos y desplegados. Ejecutar la
//                       simulación, revisar el log y recién entonces ...Apply().
//   Correcciones ...... Compara montos UF y valores con tolerancia (los floats exactos daban
//                       diferencias espurias); valida la hoja/esquema; try por fila; lock y
//                       presupuesto de tiempo; cuenta los fallos de Notion.
//
// >>> CODE BEGIN grupo3-repairUfDapAmounts
// /**
//  * @typedef {Object} UfRepairSummary
//  * @property {number} revisadas - Filas con correo asociado revisadas.
//  * @property {number} uf - Filas cuyo correo es un DAP en UF.
//  * @property {number} aCorregir - Filas de UF con valores distintos de los recalculados.
//  * @property {number} errores - Correos/conversiones/actualizaciones de Notion que fallaron.
//  * @property {boolean} truncated - true si se agotó el presupuesto de tiempo.
//  */
//
// /**
//  * SIMULACIÓN: muestra en el log qué montos de DAP en UF se corregirían, sin modificar nada.
//  * @returns {UfRepairSummary|null} Resumen, o null si no se obtuvo el lock.
//  */
// function repairUfDapAmounts() {
//   return _repairUfDapAmounts(false);
// }
//
// /**
//  * APLICA la reparación de DAP en UF: corrige en el Sheet Monto/Moneda/Monto_Original/Valor_UF y,
//  * si la fila tiene página en Notion, sobrescribe su campo "Monto" con el valor en CLP correcto.
//  * @returns {UfRepairSummary|null} Resumen, o null si no se obtuvo el lock.
//  */
// function repairUfDapAmountsApply() {
//   return _repairUfDapAmounts(true);
// }
//
// /**
//  * Núcleo de la reparación de montos en UF. Recorre TODAS las filas (incluidas COMPLETADO) con
//  * ID_Mensaje_Email, re-parsea el correo y recalcula el monto en CLP con el valor de la UF a la
//  * fecha de captación.
//  * @private
//  * @param {boolean} apply - true para escribir los cambios; false solo para reportarlos.
//  * @returns {UfRepairSummary|null} Resumen, o null si no se obtuvo el lock.
//  */
// function _repairUfDapAmounts(apply) {
//   const modo = apply ? 'APLICANDO' : 'SIMULACIÓN';
//   const summary = { revisadas: 0, uf: 0, aCorregir: 0, errores: 0, truncated: false };
//   const sameNumber = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
//
//   const result = _withScriptLock(() => {
//     const startMs = Date.now();
//     const sheet = _openDapSheet();
//     const data = sheet.getDataRange().getValues();
//
//     for (let i = 1; i < data.length; i++) {
//       const row = data[i];
//       const idMensaje = row[DAP_COLS.ID_Mensaje_Email - 1];
//       if (!idMensaje) continue;
//       if (!_hasTimeLeft(startMs)) {
//         summary.truncated = true;
//         break;
//       }
//
//       const idInterno = row[DAP_COLS.ID_Interno - 1];
//       summary.revisadas++;
//
//       try {
//         const parsed = parseBciDapEmailDetailed(GmailApp.getMessageById(idMensaje));
//         if (!parsed.ok) {
//           summary.errores++;
//           console.warn(`⚠️ [${modo}] DAP [${idInterno}]: no se pudo re-extraer (${parsed.error.code}). Revísalo manualmente.`);
//           continue;
//         }
//
//         const dapDto = parsed.dto;
//         if (dapDto.Moneda !== 'UF') continue;
//         summary.uf++;
//
//         if (!_enrichWithClpAmount(dapDto)) {
//           summary.errores++;
//           continue;
//         }
//
//         const yaCorrecto = Number(row[DAP_COLS.Monto - 1]) === dapDto.Monto
//           && row[DAP_COLS.Moneda - 1] === 'UF'
//           && sameNumber(row[DAP_COLS.Monto_Original - 1], dapDto.Monto_Original)
//           && sameNumber(row[DAP_COLS.Valor_UF - 1], dapDto.Valor_UF);
//         if (yaCorrecto) continue;
//
//         summary.aCorregir++;
//         console.info(`✏️ [${modo}] DAP [${idInterno}] (op ${dapDto.ID_Operacion}): Monto $${Number(row[DAP_COLS.Monto - 1])} → $${dapDto.Monto} (UF ${dapDto.Monto_Original} × $${dapDto.Valor_UF} del ${dapDto.Fecha_Inicio})`);
//         if (!apply) continue;
//
//         const rowIndex = i + 1;
//         sheet.getRange(rowIndex, DAP_COLS.Monto).setValue(dapDto.Monto);
//         sheet.getRange(rowIndex, DAP_COLS.Moneda).setValue('UF');
//         sheet.getRange(rowIndex, DAP_COLS.Monto_Original).setValue(dapDto.Monto_Original);
//         sheet.getRange(rowIndex, DAP_COLS.Valor_UF).setValue(dapDto.Valor_UF);
//
//         const notionPageId = row[DAP_COLS.Notion_Page_ID - 1];
//         if (notionPageId && !updateNotionDapAmount(notionPageId, dapDto.Monto)) {
//           summary.errores++;
//           console.warn(`⚠️ DAP [${idInterno}] corregido en el Sheet pero falló la actualización en Notion.`);
//         }
//       } catch (error) {
//         summary.errores++;
//         console.warn(`⚠️ [${modo}] DAP [${idInterno}]: error al revisar el correo ${idMensaje}: ${error.message}`);
//       }
//     }
//
//     if (apply) SpreadsheetApp.flush();
//   }, 10000);
//
//   if (!result.acquired) {
//     console.warn('⚠️ Reparación UF: No se pudo obtener el Lock. Reintenta en unos segundos.');
//     return null;
//   }
//
//   console.info(`✅ Reparación UF [${modo}]: ${JSON.stringify(summary)}${summary.truncated ? ' — reejecuta para continuar.' : ''}`);
//   return summary;
// }
// <<< CODE END grupo3-repairUfDapAmounts
//
// ================================================================================
// GRUPO 4 - auditCompletedDaps / repairCompletedDapsApply (completado y deduplicación Sheet <-> Notion)
// ================================================================================
//   Nombre ............ auditCompletedDaps() [simulación], repairCompletedDapsApply(),
//                       _planSheetFixes(data, todayIso, pagesById), _repairCompletedDaps(apply)
//   Ubicación original  dap_repair.gs (BORRADO COMPLETO), líneas 21-217 (commit eecce51).
//   Para qué servía ... Auditar y reparar de una vez Sheet y Notion, en este orden obligatorio:
//                       Sheet (a) marcar liquidados los DAP cuya fecha de liquidación ya pasó o que
//                       Notion ya marca liquidados; (b) DAP renovables sin liquidar con fecha tentativa
//                       fuera de ventana de renovación: se informan con 🚨 y se corrige la fecha a la
//                       válida más cercana; (c) COMPLETADOS sin página en Notion: se envían (upsert por
//                       ID operación). Notion (a) páginas duplicadas por ID operación: se conserva la más
//                       reciente (created_time), se complementa con lo que tenían las antiguas, se archivan
//                       las antiguas (recuperables desde la papelera de Notion), se re-enlazan las filas
//                       del Sheet y se reflejan en Notion los cambios de (a) y (b).
//   Cuándo reutilizarla Si el Sheet y Notion vuelven a desincronizarse (ej. tras usar código desplegado
//                       antiguo, o después de un backfill masivo). Hoy el outbox (PENDIENTE_NOTION +
//                       retryNotionSync) y el healthCheck evitan la mayoría de esos casos.
//   Dependencias ...... Activas: _complementExistingNotionPage, pushDapToNotion,
//                       patchNotionPageProperties, _readNotionProperty, _buildDapDtoFromRow
//                       (notion.gs), _getRenewalInfo, _validateRenewalDate, _formatRenewalWindow
//                       (renewal.gs), _openDapSheet, _withScriptLock, _hasTimeLeft, _todayIso, _isChecked,
//                       _toIsoDate, CONFIG.STATES, CONFIG.NOTION.PROPS.
//                       ARCHIVADAS (reactivar junto): _listAllNotionPages, _notionPageToDap,
//                       _planNotionDedupe, archiveNotionPage (Grupo 5).
//                       Propiedades: SHARED_SPREADSHEET_ID, NOTION_API_TOKEN, NOTION_DAP_DATABASE_ID.
//   Orden de ejecución  ANTES: nueva versión del Web App desplegada, cola de Telegram vacía o pausada.
//                       Ejecutar SIEMPRE auditCompletedDaps() (simulación), revisar los avisos 🚨 (fecha
//                       corregida), ↔️ (conflicto de Objetivo) y ⛔ (grupo omitido) y luego
//                       repairCompletedDapsApply().
//   Correcciones ...... Ya no archiva las páginas antiguas si el complemento de la conservada falló
//                       (antes se perdía esa información); el re-enlace del Sheet solo ocurre si el
//                       archivado tuvo éxito; presupuesto de tiempo y reanudable; omite la sincronización
//                       de una propiedad si la base de Notion ya no la tiene; usa CONFIG.STATES,
//                       CONFIG.NOTION.PROPS y _isChecked; lock también en la ejecución.
//
// >>> CODE BEGIN grupo4-repairCompletedDaps
// /**
//  * @typedef {Object} SheetFixes
//  * @property {{rowIndex: number, idInterno: (number|string), reason: string}[]} liquidate - Filas a marcar liquidadas.
//  * @property {{rowIndex: number, idInterno: (number|string), from: string, to: string, window: {k: number, start: string, end: string}}[]} dateFixes - Fechas fuera de ventana y su corrección.
//  * @property {{rowIndex: number, idInterno: (number|string)}[]} toPush - COMPLETADOS sin página en Notion.
//  */
//
// /**
//  * SIMULACIÓN: ejecuta la auditoría completa del Sheet y de Notion y muestra en el log todo lo que
//  * se haría, sin modificar nada. Revisar el log y luego ejecutar `repairCompletedDapsApply()`.
//  * @returns {void}
//  */
// function auditCompletedDaps() {
//   _repairCompletedDaps(false);
// }
//
// /**
//  * APLICA la reparación completa (ver la ficha del Grupo 4). Idempotente y reanudable.
//  * @returns {void}
//  */
// function repairCompletedDapsApply() {
//   _repairCompletedDaps(true);
// }
//
// /**
//  * Planifica (sin efectos) las correcciones del Sheet sobre las filas COMPLETADAS.
//  * @private
//  * @param {Array[]} data - Valores de la hoja, incluyendo la fila de encabezados.
//  * @param {string} todayIso - Fecha de hoy (ISO).
//  * @param {Object<string, Object>} pagesById - Páginas de Notion indexadas por id (puede estar vacío).
//  * @returns {SheetFixes} Acciones por fila (`rowIndex` es el número de fila en la hoja, base 1).
//  */
// function _planSheetFixes(data, todayIso, pagesById) {
//   const liquidate = [];
//   const dateFixes = [];
//   const toPush = [];
//
//   for (let i = 1; i < data.length; i++) {
//     const row = data[i];
//     if (row[DAP_COLS.Estado_Cola - 1] !== CONFIG.STATES.COMPLETADO) continue;
//
//     const rowIndex = i + 1;
//     const idInterno = row[DAP_COLS.ID_Interno - 1];
//     const fechaLiq = _toIsoDate(row[DAP_COLS.Fecha_Liquidacion - 1]);
//     const pageId = row[DAP_COLS.Notion_Page_ID - 1];
//
//     if (!_isChecked(row[DAP_COLS.Liquidado - 1])) {
//       const page = pageId ? pagesById[pageId] : null;
//       const porFecha = fechaLiq && fechaLiq <= todayIso;
//       const porNotion = page && _readNotionProperty(page, CONFIG.NOTION.PROPS.LIQUIDADO, 'checkbox') === true;
//
//       if (porFecha || porNotion) {
//         liquidate.push({ rowIndex: rowIndex, idInterno: idInterno, reason: porFecha ? `fecha de liquidación ${fechaLiq} ya pasó` : 'Notion lo marca como liquidado' });
//       } else if (row[DAP_COLS.Tipo_DAP - 1] === 'RENOVABLE' && fechaLiq) {
//         const renewal = _getRenewalInfo(row);
//         const check = renewal ? _validateRenewalDate(fechaLiq, renewal.fecha1, renewal.plazo) : { valid: true };
//         if (!check.valid) {
//           dateFixes.push({ rowIndex: rowIndex, idInterno: idInterno, from: fechaLiq, to: check.suggested, window: check.window });
//         }
//       }
//     }
//
//     if (!pageId) toPush.push({ rowIndex: rowIndex, idInterno: idInterno });
//   }
//
//   return { liquidate: liquidate, dateFixes: dateFixes, toPush: toPush };
// }
//
// /**
//  * Núcleo del pipeline de auditoría/reparación (ver la ficha del Grupo 4).
//  * @private
//  * @param {boolean} apply - true para escribir en Sheet/Notion; false solo para reportar.
//  * @returns {void}
//  */
// function _repairCompletedDaps(apply) {
//   const P = CONFIG.NOTION.PROPS;
//   const token = getEnv('NOTION_API_TOKEN');
//   const dbId = getEnv('NOTION_DAP_DATABASE_ID');
//   if (!getEnv('SHARED_SPREADSHEET_ID') || !token || !dbId) {
//     console.error('❌ Reparación: Faltan SHARED_SPREADSHEET_ID, NOTION_API_TOKEN o NOTION_DAP_DATABASE_ID en las propiedades.');
//     return;
//   }
//
//   const modo = apply ? 'APLICANDO' : 'SIMULACIÓN';
//   const indexPages = (list) => list.reduce((acc, page) => { acc[page.id] = page; return acc; }, {});
//
//   const run = () => {
//     const startMs = Date.now();
//     let truncated = false;
//     const sheet = _openDapSheet();
//     const todayIso = _todayIso();
//
//     let pages = _listAllNotionPages(token, dbId);
//     if (!pages) {
//       console.error('❌ Reparación: No se pudieron listar las páginas de Notion; se aborta sin modificar nada.');
//       return;
//     }
//     let pagesById = indexPages(pages);
//     console.info(`🔎 [${modo}] Hoy: ${todayIso}. Notion: ${pages.length} página(s).`);
//
//     // ---------- Sheet: a) liquidados, b) fechas fuera de ventana ----------
//     let data = sheet.getDataRange().getValues();
//     const plan = _planSheetFixes(data, todayIso, pagesById);
//
//     plan.liquidate.forEach((fix) => {
//       console.info(`✅ [${modo}] DAP [${fix.idInterno}] ya liquidado (${fix.reason}) → Liquidado = TRUE.`);
//       if (apply) sheet.getRange(fix.rowIndex, DAP_COLS.Liquidado).setValue(true);
//     });
//
//     plan.dateFixes.forEach((fix) => {
//       console.warn(`🚨 [${modo}] DAP renovable [${fix.idInterno}]: fecha de liquidación tentativa FUERA de ventana de renovación: ${fix.from} → ${fix.to} (ventana ${_formatRenewalWindow(fix.window)}).`);
//       if (apply) sheet.getRange(fix.rowIndex, DAP_COLS.Fecha_Liquidacion).setValue(fix.to);
//     });
//
//     if (apply) {
//       SpreadsheetApp.flush();
//       data = sheet.getDataRange().getValues();
//     }
//
//     // ---------- Sheet: c) DAP sin página en Notion ----------
//     plan.toPush.forEach((item) => {
//       if (!_hasTimeLeft(startMs)) {
//         truncated = true;
//         return;
//       }
//       if (!apply) {
//         console.info(`📤 [${modo}] DAP [${item.idInterno}] no tiene página en Notion → se enviará (si ya existe una con el mismo ID de operación, se enlazará y complementará).`);
//         return;
//       }
//       const notionPageId = pushDapToNotion(_buildDapDtoFromRow(data[item.rowIndex - 1]));
//       if (notionPageId) {
//         sheet.getRange(item.rowIndex, DAP_COLS.Notion_Page_ID).setValue(notionPageId);
//         console.info(`📤 DAP [${item.idInterno}] enviado a Notion (página ${notionPageId}).`);
//       } else {
//         console.error(`❌ DAP [${item.idInterno}]: no se pudo enviar a Notion.`);
//       }
//     });
//
//     if (apply) {
//       SpreadsheetApp.flush();
//       pages = _listAllNotionPages(token, dbId) || pages;
//       pagesById = indexPages(pages);
//       data = sheet.getDataRange().getValues();
//     }
//
//     // ---------- Notion: a) duplicados ----------
//     const dedupe = _planNotionDedupe(pages);
//     const relink = {};
//     let archivadas = 0;
//     let omitidos = 0;
//
//     dedupe.forEach((group) => {
//       if (!_hasTimeLeft(startMs)) {
//         truncated = true;
//         return;
//       }
//
//       const detalle = (page) => `${page.id} ("${_readNotionProperty(page, P.OBJETIVO, 'title') || 'Sin Objetivo'}", creada ${page.created_time || '?'})`;
//       console.info(`🧹 [${modo}] ID operación ${group.idOperacion}: ${group.olds.length + 1} páginas → se conserva la más reciente ${detalle(group.survivor)}; antiguas: ${group.olds.map(detalle).join(' | ')}.`);
//       group.conflicts.forEach((conflict) => console.warn(`↔️ ID operación ${group.idOperacion}: ${conflict}.`));
//
//       if (group.skipReason) {
//         omitidos++;
//         console.warn(`⛔ ID operación ${group.idOperacion} OMITIDO (revisar a mano; podrían ser DAP distintos): ${group.skipReason}.`);
//         return;
//       }
//
//       if (!apply) {
//         group.olds.forEach((old) => { relink[old.id] = group.survivor.id; });
//         return;
//       }
//
//       // Si no se pudo complementar la página conservada, NO se archivan las antiguas (se perdería su información)
//       const complement = _complementExistingNotionPage(token, group.survivor, group.merged);
//       if (!complement.ok) {
//         omitidos++;
//         console.error(`❌ ID operación ${group.idOperacion}: falló el complemento de la página conservada; no se archivan las antiguas.`);
//         return;
//       }
//
//       group.olds.forEach((old) => {
//         if (archiveNotionPage(old.id)) {
//           archivadas++;
//           relink[old.id] = group.survivor.id;
//         } else {
//           console.error(`❌ No se pudo archivar la página antigua ${old.id}.`);
//         }
//       });
//     });
//
//     // ---------- Sheet: re-enlazar filas que apuntaban a páginas archivadas ----------
//     for (let i = 1; i < data.length; i++) {
//       const currentId = data[i][DAP_COLS.Notion_Page_ID - 1];
//       if (currentId && relink[currentId]) {
//         console.info(`🔗 [${modo}] DAP [${data[i][DAP_COLS.ID_Interno - 1]}]: Notion_Page_ID ${currentId} → ${relink[currentId]} (página conservada).`);
//         if (apply) sheet.getRange(i + 1, DAP_COLS.Notion_Page_ID).setValue(relink[currentId]);
//       }
//     }
//
//     // ---------- Notion: reflejar los cambios hechos en el Sheet (a y b) ----------
//     if (apply) {
//       SpreadsheetApp.flush();
//       data = sheet.getDataRange().getValues();
//     }
//     const changes = {};
//     plan.liquidate.forEach((fix) => { (changes[fix.rowIndex] = changes[fix.rowIndex] || {}).liquidado = true; });
//     plan.dateFixes.forEach((fix) => { (changes[fix.rowIndex] = changes[fix.rowIndex] || {}).fechaLiq = fix.to; });
//
//     Object.keys(changes).forEach((rowIndex) => {
//       const row = data[Number(rowIndex) - 1];
//       const idInterno = row[DAP_COLS.ID_Interno - 1];
//       const pageId = row[DAP_COLS.Notion_Page_ID - 1];
//       const page = pageId ? pagesById[pageId] : null;
//       const properties = {};
//       if (changes[rowIndex].liquidado) properties[P.LIQUIDADO] = { checkbox: true };
//       if (changes[rowIndex].fechaLiq) properties[P.FECHA_LIQUIDACION] = { date: { start: changes[rowIndex].fechaLiq } };
//
//       // Si la base de Notion ya no tiene una propiedad, no se intenta escribirla (daría 400)
//       Object.keys(properties).forEach((name) => {
//         if (page && !Object.prototype.hasOwnProperty.call(page.properties || {}, name)) {
//           console.warn(`⚠️ DAP [${idInterno}]: la página de Notion no tiene la propiedad "${name}"; no se sincroniza.`);
//           delete properties[name];
//         }
//       });
//       if (Object.keys(properties).length === 0) return;
//
//       console.info(`📝 [${modo}] DAP [${idInterno}]: se refleja en Notion (${Object.keys(properties).join(', ')}).`);
//       if (!apply) return;
//       if (!pageId || !patchNotionPageProperties(pageId, properties)) {
//         console.error(`❌ DAP [${idInterno}]: no se pudo reflejar el cambio en Notion (sin página o error de API).`);
//       }
//     });
//
//     console.info(`✅ Reparación [${modo}] terminada: ${plan.liquidate.length} DAP a marcar liquidados, ${plan.dateFixes.length} 🚨 fecha(s) fuera de ventana, ${plan.toPush.length} sin página en Notion, ${dedupe.length} ID(s) duplicado(s) (${omitidos} omitido(s)${apply ? `, ${archivadas} página(s) archivada(s)` : ''})${truncated ? ' — se agotó el tiempo: vuelve a ejecutar para continuar.' : ''}.`);
//   };
//
//   const result = apply ? _withScriptLock(run, 10000) : { acquired: true, value: run() };
//   if (!result.acquired) console.warn('⚠️ Reparación: No se pudo obtener el Lock (otro proceso está corriendo). Reintenta en unos segundos.');
// }
// <<< CODE END grupo4-repairCompletedDaps
//
// ================================================================================
// GRUPO 5 - Ayudantes de Notion de los Grupos 3 y 4
// ================================================================================
//   Nombres ........... _listAllNotionPages, _notionPageToDap, _planNotionDedupe, archiveNotionPage,
//                       updateNotionDapAmount
//   Ubicación original  notion.gs (el archivo SIGUE existiendo), líneas 87-121 (_listAllNotionPages),
//                       257-276 (updateNotionDapAmount), 333-361 (archiveNotionPage), 363-386
//                       (_notionPageToDap) y 388-430 (_planNotionDedupe) (commit eecce51).
//   Para qué servían .. Soporte del completado/reparación: listar toda la base de Notion (paginada),
//                       convertir una página a un DTO con los nombres del Sheet, planificar la
//                       deduplicación por ID operación (conservar la más reciente y fusionar lo que
//                       falte de las antiguas), archivar una página (recuperable desde la papelera de
//                       Notion) y sobrescribir el Monto de una página (reparación de UF).
//   Cuándo reutilizarlos Solo junto con los Grupos 3 y 4 (los usan directamente).
//   Dependencias ...... Activas: _fetchWithRetry (utils.gs), _getNotionHeaders, _readNotionProperty
//                       (notion.gs), patchNotionPageProperties, CONFIG.NOTION.PROPS.
//   Orden de ejecución  Se reactivan ANTES de ejecutar los Grupos 3 o 4 y se vuelven a comentar después.
//   Correcciones ...... _planNotionDedupe desempata de forma determinista por id cuando dos páginas
//                       tienen el mismo created_time (el orden dependía del orden de la API); usa
//                       CONFIG.NOTION.PROPS en vez de nombres de propiedad escritos a mano.
//
// >>> CODE BEGIN grupo5-notion-helpers
// /**
//  * Lista todas las páginas de la base de datos de Notion (paginado de a 100).
//  * @private
//  * @param {string} token - Token de integración de Notion.
//  * @param {string} dbId - ID de la base de datos de Notion.
//  * @returns {Object[]|null} Páginas (id, created_time, properties), o null si alguna consulta falla.
//  */
// function _listAllNotionPages(token, dbId) {
//   const url = `https://api.notion.com/v1/databases/${dbId}/query`;
//   const pages = [];
//   let cursor = null;
//
//   for (let i = 0; i < 100; i++) {
//     const payload = { page_size: 100 };
//     if (cursor) payload.start_cursor = cursor;
//
//     const res = _fetchWithRetry(url, {
//       method: 'post',
//       headers: _getNotionHeaders(token),
//       payload: JSON.stringify(payload),
//       muteHttpExceptions: true
//     });
//     if (!res || res.getResponseCode() !== 200) return null;
//
//     const json = JSON.parse(res.getContentText());
//     pages.push(...(json.results || []));
//     if (!json.has_more) return pages;
//     cursor = json.next_cursor;
//   }
//
//   return pages;
// }
//
// /**
//  * Sobrescribe el campo "Monto" (en CLP) de una página de Notion. Solo lo usa la reparación
//  * manual de DAP en UF; el upsert normal (`pushDapToNotion`) nunca pisa valores existentes.
//  * @param {string} pageId - El ID único de la página en Notion.
//  * @param {number} monto - Monto en CLP.
//  * @returns {boolean} true si la mutación fue exitosa, false si falló.
//  */
// function updateNotionDapAmount(pageId, monto) {
//   return patchNotionPageProperties(pageId, { [CONFIG.NOTION.PROPS.MONTO]: { number: monto } });
// }
//
// /**
//  * Archiva una página de Notion (queda en la papelera de Notion y es restaurable desde ahí;
//  * no se borra de forma permanente).
//  * @param {string} pageId - El ID único de la página en Notion.
//  * @returns {boolean} true si se archivó, false si falló.
//  */
// function archiveNotionPage(pageId) {
//   const token = getEnv('NOTION_API_TOKEN');
//   if (!token || !pageId) {
//     console.error('❌ Notion API: Falta Token o Page ID para archivar la página.');
//     return false;
//   }
//
//   const res = _fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
//     method: 'patch',
//     headers: _getNotionHeaders(token),
//     payload: JSON.stringify({ archived: true }),
//     muteHttpExceptions: true
//   });
//   if (!res) return false;
//
//   if (res.getResponseCode() === 200) {
//     console.info(`🗄️ Notion: página [${pageId}] archivada.`);
//     return true;
//   }
//   console.error(`❌ Error Notion API (archivar): Código ${res.getResponseCode()} - ${res.getContentText()}`);
//   return false;
// }
//
// /**
//  * Convierte una página de Notion a un DTO con los mismos nombres de campo que usa el Sheet.
//  * Los campos vacíos quedan en null (el Objetivo "Sin Objetivo" cuenta como vacío).
//  * @private
//  * @param {Object} page - Página de Notion (id + properties).
//  * @returns {{Objetivo: (string|null), Monto: (number|null), Tipo_DAP: (string|null), Fecha_Inicio: (string|null), Fecha_Vencimiento: (string|null), Fecha_Liquidacion: (string|null), Liquidado: boolean}} DTO de la página.
//  */
// function _notionPageToDap(page) {
//   const P = CONFIG.NOTION.PROPS;
//   const objetivo = _readNotionProperty(page, P.OBJETIVO, 'title');
//   return {
//     Objetivo: (objetivo && objetivo !== 'Sin Objetivo') ? objetivo : null,
//     Monto: _readNotionProperty(page, P.MONTO, 'number'),
//     Tipo_DAP: _readNotionProperty(page, P.TIPO, 'select'),
//     Fecha_Inicio: _readNotionProperty(page, P.FECHA_INICIO, 'date'),
//     Fecha_Vencimiento: _readNotionProperty(page, P.FECHA_VENCIMIENTO, 'date'),
//     Fecha_Liquidacion: _readNotionProperty(page, P.FECHA_LIQUIDACION, 'date'),
//     Liquidado: _readNotionProperty(page, P.LIQUIDADO, 'checkbox') === true
//   };
// }
//
// /**
//  * Planifica la deduplicación de páginas de Notion por "ID operación". Por cada grupo con más de
//  * una página: se conserva la MÁS RECIENTE (`created_time`; desempate por id), y de las antiguas se
//  * toma solo la información que a la conservada le falte (`merged`, en orden de la más nueva a la
//  * más vieja). Un grupo se marca con `skipReason` (y no debe archivarse automáticamente) si las
//  * páginas traen valores DISTINTOS de Monto, tipo o fechas de inicio/vencimiento, porque entonces
//  * probablemente no son el mismo DAP. Diferencias solo de Objetivo se informan en `conflicts` pero
//  * no bloquean (se conserva el Objetivo de la más reciente).
//  * @private
//  * @param {Object[]} pages - Páginas de Notion (id, created_time, properties).
//  * @returns {{idOperacion: number, survivor: Object, olds: Object[], merged: Object, conflicts: string[], skipReason: (string|null)}[]} Grupos duplicados.
//  */
// function _planNotionDedupe(pages) {
//   const P = CONFIG.NOTION.PROPS;
//   const groups = {};
//   pages.forEach((page) => {
//     const idOperacion = _readNotionProperty(page, P.ID_OPERACION, 'number');
//     if (idOperacion === null) return;
//     (groups[idOperacion] = groups[idOperacion] || []).push(page);
//   });
//
//   const hasValue = (v) => v !== null && v !== undefined && v !== '';
//
//   return Object.keys(groups)
//     .filter((key) => groups[key].length > 1)
//     .map((key) => {
//       const sorted = groups[key].slice().sort((a, b) =>
//         String(b.created_time || '').localeCompare(String(a.created_time || '')) || String(b.id).localeCompare(String(a.id)));
//       const survivor = sorted[0];
//       const olds = sorted.slice(1);
//       const survivorDap = _notionPageToDap(survivor);
//       const merged = { ID_Operacion: key };
//       const conflicts = [];
//       let skipReason = null;
//
//       olds.forEach((old) => {
//         const oldDap = _notionPageToDap(old);
//
//         ['Monto', 'Tipo_DAP', 'Fecha_Inicio', 'Fecha_Vencimiento'].forEach((field) => {
//           if (hasValue(survivorDap[field]) && hasValue(oldDap[field]) && survivorDap[field] !== oldDap[field]) {
//             skipReason = skipReason || `${field} distinto entre páginas (${survivorDap[field]} vs ${oldDap[field]})`;
//           }
//         });
//
//         if (hasValue(survivorDap.Objetivo) && hasValue(oldDap.Objetivo) && survivorDap.Objetivo !== oldDap.Objetivo) {
//           conflicts.push(`Objetivo "${oldDap.Objetivo}" se descarta; se conserva "${survivorDap.Objetivo}"`);
//         }
//
//         ['Objetivo', 'Monto', 'Tipo_DAP', 'Fecha_Inicio', 'Fecha_Vencimiento', 'Fecha_Liquidacion'].forEach((field) => {
//           if (!hasValue(merged[field]) && hasValue(oldDap[field])) merged[field] = oldDap[field];
//         });
//         if (oldDap.Liquidado) merged.Liquidado = true;
//       });
//
//       return { idOperacion: Number(key), survivor: survivor, olds: olds, merged: merged, conflicts: conflicts, skipReason: skipReason };
//     });
// }
// <<< CODE END grupo5-notion-helpers
//
