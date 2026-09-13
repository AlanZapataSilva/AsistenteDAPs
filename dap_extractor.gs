/**
 * @fileoverview dap_extractor.gs - Orquestador de búsqueda y guardado en cola.
 */

'use strict';

/**
 * Busca nuevos correos de DAPs, los procesa y los encola en la BD remota.
 * Diseñado para ser ejecutado mediante un Cron Job (Time-driven trigger).
 */
function processDapEmails() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  
  if (!spreadsheetId) {
    console.error('❌ ERROR: No se encontró SHARED_SPREADSHEET_ID en las propiedades.');
    return;
  }

  const labelName = CONFIG.GMAIL.LABEL_DAP_PROCESSED;
  const query = `from:bci.cl subject:"${DAP_BCI_LOGIC.SUBJECT}" -label:${labelName} newer_than:30d`;
  
  const threads = GmailApp.search(query, 0, 10);
  
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
    for (const thread of threads) {
      const messages = thread.getMessages();
      
      for (const msg of messages) {
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
      }
      
      // Aplicar etiqueta de idempotencia al hilo completo
      const label = GmailApp.getUserLabelByName(labelName);
      if (label) thread.addLabel(label);
    }
    
    // Forzamos la escritura inmediata en el documento antes de llamar al siguiente paso
    SpreadsheetApp.flush();
    
    if (dapsProcesados > 0) {
      console.info(`🚀 Lote completado: ${dapsProcesados} DAPs nuevos. Llamando al lector de cola...`);
      pingNextPendingDap();
    }
    
  } catch (error) {
    console.error(`❌ Error CRÍTICO en processDapEmails: ${error.stack || error.message}`);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Calcula secuencialmente el siguiente ID Interno disponible en la base de datos.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de cálculo de DAPs.
 * @returns {string} ID formateado (Ej: DAP-001, DAP-042).
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