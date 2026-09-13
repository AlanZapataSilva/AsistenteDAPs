/**
 * @fileoverview dap_cron.gs - Motor de revisión diaria de vencimientos.
 */

'use strict';

/**
 * Demonio de ejecución diaria. Revisa los DAPs cuya fecha de liquidación haya madurado,
 * los marca como liquidados en Google Sheets y Notion, y envía un reporte consolidado por Telegram.
 */
function checkAndLiquidateDaps() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  
  if (!spreadsheetId || !chatId) {
    console.error('❌ Cron Job: Faltan variables de entorno (SHARED_SPREADSHEET_ID o TELEGRAM_CHAT_ID).');
    return;
  }

  // Protección de concurrencia
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('⚠️ Cron Job ocupado: No se pudo obtener el Lock. Se reintentará en la próxima ejecución.');
    return;
  }

  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
    
    if (!sheet) {
      console.error(`❌ Cron Job: No se encontró la hoja "${CONFIG.SHEETS.DAPS}".`);
      return;
    }

    const data = sheet.getDataRange().getValues();

    // Fecha de hoy estandarizada en la zona horaria del script
    const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

    const dapsLiquidados = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const idInterno = row[0];
      const monto = row[2];
      const objetivoDAP = row[6] || "Sin Objetivo";
      const fechaLiqRaw = row[7];
      const liquidado = row[8];
      const estadoCola = row[9];
      const notionPageId = row[11];

      // Saltamos registros no elegibles (ya liquidados, sin fecha de liquidación o con cola incompleta)
      if (liquidado === true || !fechaLiqRaw || estadoCola !== 'COMPLETADO') {
        continue;
      }

      // Estandarización de la fecha de liquidación
      let fechaLiqStr = "";
      if (fechaLiqRaw instanceof Date) {
        fechaLiqStr = Utilities.formatDate(fechaLiqRaw, Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else {
        fechaLiqStr = String(fechaLiqRaw).trim();
      }

      // Evaluación de maduración (si la fecha llegó o es del pasado)
      if (fechaLiqStr && fechaLiqStr <= todayStr) {
        // 1. Actualizar Notion remotamente
        let notionSuccess = false;
        if (notionPageId) {
          notionSuccess = updateNotionDapStatus(notionPageId);
        } else {
          console.warn(`⚠️ Cron Job: DAP [${idInterno}] no posee Notion_Page_ID. Omitiendo actualización en Notion.`);
        }

        // 2. Actualizar Google Sheets (Columna 9 -> Liquidado)
        const rowIndex = i + 1;
        sheet.getRange(rowIndex, 9).setValue(true);

        dapsLiquidados.push({
          id: idInterno,
          objetivo: objetivoDAP,
          monto: monto,
          notion: notionSuccess
        });
      }
    }

    // Forzar la escritura física en la hoja
    SpreadsheetApp.flush();

    // 3. Enviar Reporte Consolidado por Telegram
    if (dapsLiquidados.length > 0) {
      let msg = `✅ <b>Reporte Diario: DAPs Liquidados</b>\n\n`;
      msg += `Se han detectado y marcado como liquidados los siguientes DAPs maduros:\n\n`;
      
      for (const d of dapsLiquidados) {
        const montoFormateado = new Intl.NumberFormat('es-CL').format(d.monto);
        const estadoNotion = d.notion ? '✅ Actualizado' : '⚠️ Error / Omitido';
        
        msg += `🔹 [${d.id}] <b>${d.objetivo}</b> ($${montoFormateado})\n`;
        msg += `   Notion: ${estadoNotion}\n\n`;
      }
      
      sendTelegramMessage(chatId, msg);
      console.info(`✅ Cron Job: Reporte diario enviado a Telegram con ${dapsLiquidados.length} DAP(s) liquidado(s).`);
    } else {
      console.info('ℹ️ Cron Job: Sin DAPs maduros pendientes de liquidación el día de hoy.');
    }

  } catch (error) {
    console.error(`❌ Error CRÍTICO en checkAndLiquidateDaps: ${error.stack || error.message}`);
  } finally {
    lock.releaseLock();
  }
}