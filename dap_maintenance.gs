/**
 * @fileoverview dap_maintenance.gs - Herramientas de auditoría y reparación manual.
 * Funciones de ejecución manual (no forman parte del pipeline automático), pensadas para
 * remediar datos ya guardados cuando se corrige un bug en dap_parser.gs.
 */

'use strict';

/**
 * Audita las filas del Sheet que aún NO llegaron a "COMPLETADO" (el usuario todavía no
 * terminó su conversación de Telegram para esa fila): re-parsea el correo original de cada
 * una (vía `ID_Mensaje_Email`, ya guardado) con el parser ACTUAL de `dap_parser.gs`, y si el
 * `ID_Operacion` resultante no coincide con el que ya está escrito en el Sheet, lo corrige.
 *
 * No toca filas "COMPLETADO": esas ya pudieron sincronizarse con Notion, y corregir el Sheet
 * ahí no las actualizaría allá (para esas, hay que corregir manualmente en ambos lados).
 *
 * Pensada para ejecutarse manualmente UNA VEZ desde el editor de Apps Script después de un
 * fix en el parser (ej. el bug donde se capturaba el N° de Transacción en vez del N° de
 * Depósito) para reparar DAPs que ya se habían encolado con el bug antes del fix.
 */
function auditPendingDapOperaciones() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  if (!spreadsheetId) {
    console.error('❌ Auditoría: No se encontró SHARED_SPREADSHEET_ID en las propiedades.');
    return;
  }

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
  const data = sheet.getDataRange().getValues();

  let revisadas = 0;
  let corregidas = 0;
  let sinCorreo = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const estadoCola = row[DAP_COLS.Estado_Cola - 1];

    if (estadoCola === 'COMPLETADO') continue;

    const idInterno = row[DAP_COLS.ID_Interno - 1];
    const idOperacionActual = String(row[DAP_COLS.ID_Operacion - 1]);
    const idMensaje = row[DAP_COLS.ID_Mensaje_Email - 1];

    if (!idMensaje) {
      sinCorreo++;
      continue;
    }

    revisadas++;

    let message;
    try {
      message = GmailApp.getMessageById(idMensaje);
    } catch (error) {
      console.warn(`⚠️ Auditoría: No se pudo abrir el correo del DAP [${idInterno}] (ID_Mensaje_Email=${idMensaje}): ${error.message}`);
      continue;
    }

    const dapDto = parseBciDapEmail(message);
    if (!dapDto) {
      console.warn(`⚠️ Auditoría: El parser actual no pudo re-extraer el DAP [${idInterno}]. Revísalo manualmente.`);
      continue;
    }

    if (String(dapDto.ID_Operacion) !== idOperacionActual) {
      const rowIndex = i + 1;
      sheet.getRange(rowIndex, DAP_COLS.ID_Operacion).setValue(dapDto.ID_Operacion);
      corregidas++;
      console.info(`✏️ Auditoría: DAP [${idInterno}] corregido: ID_Operacion "${idOperacionActual}" → "${dapDto.ID_Operacion}"`);
    }
  }

  SpreadsheetApp.flush();
  console.info(`✅ Auditoría completa: ${revisadas} fila(s) revisada(s), ${corregidas} corregida(s), ${sinCorreo} sin correo asociado.`);
}

/**
 * Libera la cola de DAPs para retomar las preguntas de Telegram: borra el estado de la
 * conversación activa en caché (`ACTIVE_DAP`/`DAP_STEP`), devuelve a `PENDIENTE_OBJETIVO` toda
 * fila que haya quedado en `ESPERANDO_TELEGRAM` (huérfana) y vuelve a lanzar la cola.
 * Ejecutar manualmente cuando se interrumpió una conversación o se corrigieron datos.
 */
function releaseDapQueue() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!spreadsheetId || !chatId) {
    console.error('❌ Liberar cola: Faltan SHARED_SPREADSHEET_ID o TELEGRAM_CHAT_ID en las propiedades.');
    return;
  }

  const cache = CacheService.getScriptCache();
  cache.remove(`${chatId}_ACTIVE_DAP`);
  cache.remove(`${chatId}_DAP_STEP`);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('⚠️ Liberar cola: No se pudo obtener el Lock. Reintenta en unos segundos.');
    return;
  }

  let liberadas = 0;
  try {
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(CONFIG.SHEETS.DAPS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][DAP_COLS.Estado_Cola - 1] === 'ESPERANDO_TELEGRAM') {
        sheet.getRange(i + 1, DAP_COLS.Estado_Cola).setValue('PENDIENTE_OBJETIVO');
        liberadas++;
      }
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  console.info(`🔓 Cola liberada: caché limpiado y ${liberadas} fila(s) devuelta(s) a PENDIENTE_OBJETIVO. Reanudando...`);
  pingNextPendingDap();
}

/**
 * SIMULACIÓN: revisa todas las filas cuyo correo original es un DAP en UF y muestra en el log
 * qué se corregiría (monto en CLP, moneda, monto en UF, valor UF), sin modificar nada.
 * Revisar el log y, si es correcto, ejecutar `repairUfDapAmountsApply()`.
 */
function repairUfDapAmounts() {
  _repairUfDapAmounts(false);
}

/**
 * APLICA la reparación de DAP en UF: corrige en el Sheet Monto/Moneda/Monto_Original/Valor_UF y,
 * si la fila tiene página en Notion, sobrescribe su campo "Monto" con el valor en CLP correcto.
 */
function repairUfDapAmountsApply() {
  _repairUfDapAmounts(true);
}

/**
 * Núcleo de la reparación de montos en UF (ver `repairUfDapAmounts`/`repairUfDapAmountsApply`).
 * Recorre TODAS las filas (incluidas COMPLETADO) con `ID_Mensaje_Email`, re-parsea el correo y
 * recalcula el monto en CLP con el valor de la UF a la fecha de captación.
 * @private
 * @param {boolean} apply - true para escribir los cambios; false solo para reportarlos.
 */
function _repairUfDapAmounts(apply) {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  if (!spreadsheetId) {
    console.error('❌ Reparación UF: No se encontró SHARED_SPREADSHEET_ID en las propiedades.');
    return;
  }

  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(CONFIG.SHEETS.DAPS);
  const data = sheet.getDataRange().getValues();
  const modo = apply ? 'APLICANDO' : 'SIMULACIÓN';

  let revisadas = 0;
  let uf = 0;
  let aCorregir = 0;
  let errores = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const idMensaje = row[DAP_COLS.ID_Mensaje_Email - 1];
    if (!idMensaje) continue;

    const idInterno = row[DAP_COLS.ID_Interno - 1];
    revisadas++;

    let message;
    try {
      message = GmailApp.getMessageById(idMensaje);
    } catch (error) {
      console.warn(`⚠️ Reparación UF: No se pudo abrir el correo del DAP [${idInterno}]: ${error.message}`);
      errores++;
      continue;
    }

    const dapDto = parseBciDapEmail(message);
    if (!dapDto) {
      console.warn(`⚠️ Reparación UF: No se pudo re-extraer el DAP [${idInterno}]. Revísalo manualmente.`);
      errores++;
      continue;
    }
    if (dapDto.Moneda !== 'UF') continue;

    uf++;
    if (!_enrichWithClpAmount(dapDto)) {
      errores++;
      continue;
    }

    const montoActual = Number(row[DAP_COLS.Monto - 1]);
    const yaCorrecto = montoActual === dapDto.Monto
      && row[DAP_COLS.Moneda - 1] === 'UF'
      && Number(row[DAP_COLS.Monto_Original - 1]) === dapDto.Monto_Original
      && Number(row[DAP_COLS.Valor_UF - 1]) === dapDto.Valor_UF;
    if (yaCorrecto) continue;

    aCorregir++;
    console.info(`✏️ [${modo}] DAP [${idInterno}] (op ${dapDto.ID_Operacion}): Monto $${montoActual} → $${dapDto.Monto} (UF ${dapDto.Monto_Original} × $${dapDto.Valor_UF} del ${dapDto.Fecha_Inicio})`);

    if (!apply) continue;

    const rowIndex = i + 1;
    sheet.getRange(rowIndex, DAP_COLS.Monto).setValue(dapDto.Monto);
    sheet.getRange(rowIndex, DAP_COLS.Moneda).setValue('UF');
    sheet.getRange(rowIndex, DAP_COLS.Monto_Original).setValue(dapDto.Monto_Original);
    sheet.getRange(rowIndex, DAP_COLS.Valor_UF).setValue(dapDto.Valor_UF);

    const notionPageId = row[DAP_COLS.Notion_Page_ID - 1];
    if (notionPageId && !updateNotionDapAmount(notionPageId, dapDto.Monto)) {
      console.warn(`⚠️ Reparación UF: DAP [${idInterno}] corregido en el Sheet pero falló la actualización en Notion.`);
      errores++;
    }
  }

  SpreadsheetApp.flush();
  console.info(`✅ Reparación UF [${modo}]: ${revisadas} fila(s) revisada(s), ${uf} en UF, ${aCorregir} ${apply ? 'corregida(s)' : 'por corregir'}, ${errores} con error/advertencia.`);
}
