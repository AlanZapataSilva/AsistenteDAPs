/**
 * @fileoverview dap_extractor.gs - Orquestador de búsqueda y guardado en cola.
 */

'use strict';

/**
 * Busca nuevos correos de DAPs, los procesa y los encola en la BD remota.
 * Diseñado para ser ejecutado mediante un Cron Job (Time-driven trigger).
 */
function processDapEmails() {
  _runDapEmailExtraction({
    query: `from:bci.cl subject:"${DAP_BCI_LOGIC.SUBJECT}" -label:${CONFIG.GMAIL.LABEL_DAP_PROCESSED} newer_than:30d`,
    maxThreads: 10,
    flushEveryThreads: 0
  });
}

/**
 * Reprocesa correos históricos de DAPs fuera de la ventana normal de 30 días.
 * Pensada para una ejecución manual única (backfill), no para un trigger recurrente.
 * Es segura de re-ejecutar: la etiqueta de idempotencia de Gmail excluye automáticamente
 * los correos ya encolados, por lo que nunca duplica filas existentes en el Sheet. Si
 * hay más correos de los que trae en una sola pasada (límite `maxThreads`), simplemente
 * vuelve a ejecutar la función: retomará donde quedó, ya que los hilos recién etiquetados
 * quedan excluidos de la siguiente búsqueda.
 * @param {number} [monthsBack=18] - Meses hacia atrás desde hoy a incluir en la búsqueda.
 * @param {number} [maxThreads=500] - Máximo de hilos a traer en esta ejecución (tope de Gmail: 500).
 */
function backfillDapEmails(monthsBack, maxThreads) {
  const months = monthsBack || 18;
  const limit = maxThreads || 500;

  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - months);
  const sinceStr = Utilities.formatDate(sinceDate, Session.getScriptTimeZone(), 'yyyy/MM/dd');

  console.info(`🕓 Backfill: buscando DAPs desde ${sinceStr} (${months} meses atrás).`);

  _runDapEmailExtraction({
    query: `from:bci.cl subject:"${DAP_BCI_LOGIC.SUBJECT}" -label:${CONFIG.GMAIL.LABEL_DAP_PROCESSED} after:${sinceStr}`,
    maxThreads: limit,
    flushEveryThreads: 10
  });
}

/**
 * Núcleo compartido de extracción de correos: busca hilos según `query`, parsea cada
 * mensaje y encola los DAPs nuevos en el Sheet. Usado tanto por `processDapEmails()`
 * (ventana corta, trigger recurrente) como por `backfillDapEmails()` (ventana amplia,
 * ejecución manual).
 * @private
 * @param {Object} options
 * @param {string} options.query - Query de búsqueda de Gmail.
 * @param {number} options.maxThreads - Máximo de hilos a traer (pasado a GmailApp.search).
 * @param {number} options.flushEveryThreads - Si es > 0, fuerza SpreadsheetApp.flush() cada
 *   N hilos procesados, para no perder progreso si una ejecución larga se corta por timeout.
 */
function _runDapEmailExtraction({ query, maxThreads, flushEveryThreads }) {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');

  if (!spreadsheetId) {
    console.error('❌ ERROR: No se encontró SHARED_SPREADSHEET_ID en las propiedades.');
    return;
  }

  const labelName = CONFIG.GMAIL.LABEL_DAP_PROCESSED;
  const threads = GmailApp.search(query, 0, maxThreads);

  if (threads.length === 0) {
    console.info('ℹ️ Extracción: No hay correos nuevos de DAPs pendientes.');
    return;
  }

  console.info(`🔄 Iniciando procesamiento de ${threads.length} hilos de correo encontrados.`);

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('⚠️ Extractor ocupado: No se pudo obtener el Lock de seguridad. Se reintentará en la próxima ejecución.');
    return;
  }

  let dapsProcesados = 0;

  try {
    threads.forEach((thread, index) => {
      const messages = thread.getMessages();

      messages.forEach((msg) => {
        const dapDto = parseBciDapEmail(msg);

        if (dapDto) {
          const idInterno = _generateNextInternalId(sheet);

          // Inserción en Sheets respetando estrictamente el orden de los HEADERS
          sheet.appendRow([
            idInterno,
            dapDto.ID_Operacion,
            dapDto.Monto,
            dapDto.Tipo_DAP,
            dapDto.Fecha_Inicio,
            dapDto.Fecha_Vencimiento,
            "",                     // Objetivo (Pendiente)
            "",                     // Fecha_Liquidacion (Pendiente)
            false,                  // Liquidado
            "PENDIENTE_OBJETIVO",   // Estado_Cola
            msg.getId(),            // ID_Mensaje_Email
            ""                      // Notion_Page_ID
          ]);

          dapsProcesados++;
          console.info(`✅ DAP Encolado exitosamente: ${idInterno} | Operación: ${dapDto.ID_Operacion}`);
        } else {
          console.warn(`⚠️ Fallo de extracción: El parser retornó null para el mensaje ID: ${msg.getId()}`);
        }
      });

      // Aplicar etiqueta de idempotencia al hilo completo
      const label = GmailApp.getUserLabelByName(labelName);
      if (label) thread.addLabel(label);

      if (flushEveryThreads && (index + 1) % flushEveryThreads === 0) {
        SpreadsheetApp.flush();
        console.info(`💾 Progreso guardado (${index + 1}/${threads.length} hilos procesados).`);
      }
    });

    // Forzamos la escritura inmediata en el documento antes de llamar al siguiente paso
    SpreadsheetApp.flush();

    if (dapsProcesados > 0) {
      console.info(`🚀 Lote completado: ${dapsProcesados} DAPs nuevos. Llamando al lector de cola...`);
      pingNextPendingDap();
    }

  } catch (error) {
    console.error(`❌ Error CRÍTICO en _runDapEmailExtraction: ${error.stack || error.message}`);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Calcula secuencialmente el siguiente ID Interno disponible en la base de datos.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de cálculo de DAPs.
 * @returns {number} Entero secuencial simple (Ej: 1, 2, 42), sin prefijo.
 */
function _generateNextInternalId(sheet) {
  const lastRow = sheet.getLastRow();
  let nextNum = 1;

  if (lastRow > 1) {
    const lastId = sheet.getRange(lastRow, 1).getValue().toString();
    const match = lastId.match(/\d+/);
    if (match) {
      nextNum = parseInt(match[0], 10) + 1;
    }
  }

  return nextNum;
}