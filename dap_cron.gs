/**
 * @fileoverview dap_cron.gs - Motor de revisión diaria de vencimientos.
 */

'use strict';

/**
 * Demonio de ejecución diaria. Revisa los DAPs cuya fecha de liquidación haya madurado,
 * los marca como liquidados en Notion y luego en Google Sheets, y envía un reporte consolidado
 * por Telegram. Si Notion falla para un DAP, ese DAP NO se marca (así el Sheet nunca queda por
 * delante de Notion) y se reintenta en la próxima ejecución diaria.
 * @returns {void}
 */
function checkAndLiquidateDaps() {
  try {
    const result = _withScriptLock(() => _liquidateMaturedDaps(), 10000);
    if (!result.acquired) console.warn('⚠️ Cron Job ocupado: No se pudo obtener el Lock. Se reintentará en la próxima ejecución.');
  } catch (error) {
    console.error(`❌ Error CRÍTICO en checkAndLiquidateDaps: ${error.stack || error.message}`);
    _alertAdmin('CRON_ERROR', `Fallo en la liquidación diaria: <code>${_escapeHtml(error.message)}</code>`);
  }
}

/**
 * Lógica de `checkAndLiquidateDaps` (debe ejecutarse bajo el lock de script).
 * @private
 * @returns {void}
 */
function _liquidateMaturedDaps() {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) {
    console.error('❌ Cron Job: Falta TELEGRAM_CHAT_ID en las propiedades.');
    return;
  }

  const sheet = _openDapSheet();
  const data = sheet.getDataRange().getValues();
  const todayStr = _todayIso();

  const liquidated = [];
  const failed = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const idInterno = row[DAP_COLS.ID_Interno - 1];

    // Solo DAPs COMPLETADOS, sin liquidar y con fecha de liquidación llegada o pasada
    if (row[DAP_COLS.Estado_Cola - 1] !== CONFIG.STATES.COMPLETADO || _isChecked(row[DAP_COLS.Liquidado - 1])) continue;
    const fechaLiqStr = _toIsoDate(row[DAP_COLS.Fecha_Liquidacion - 1]);
    if (!fechaLiqStr || fechaLiqStr > todayStr) continue;

    const info = {
      id: idInterno,
      objetivo: row[DAP_COLS.Objetivo - 1] || 'Sin Objetivo',
      monto: row[DAP_COLS.Monto - 1]
    };

    try {
      // 1. Notion primero: si falla, no se marca el Sheet y se reintenta mañana
      const notionPageId = row[DAP_COLS.Notion_Page_ID - 1];
      if (notionPageId) {
        if (!updateNotionDapStatus(notionPageId)) {
          failed.push(info);
          continue;
        }
      } else {
        console.warn(`⚠️ Cron Job: DAP [${idInterno}] no posee Notion_Page_ID. Se marca solo en el Sheet.`);
      }

      // 2. Google Sheets (columna Liquidado)
      sheet.getRange(i + 1, DAP_COLS.Liquidado).setValue(true);
      liquidated.push(Object.assign({ notion: Boolean(notionPageId) }, info));
    } catch (error) {
      console.error(`❌ Cron Job: error liquidando el DAP [${idInterno}]: ${error.stack || error.message}`);
      failed.push(info);
    }
  }

  // Forzar la escritura física en la hoja
  SpreadsheetApp.flush();

  if (liquidated.length === 0 && failed.length === 0) {
    console.info('ℹ️ Cron Job: Sin DAPs maduros pendientes de liquidación el día de hoy.');
    return;
  }

  const formatMonto = (monto) => new Intl.NumberFormat('es-CL').format(monto || 0);
  let msg = '';

  if (liquidated.length > 0) {
    msg += `✅ <b>Reporte Diario: DAPs Liquidados</b>\n\n`;
    msg += `Se han detectado y marcado como liquidados los siguientes DAPs maduros:\n\n`;
    liquidated.forEach((d) => {
      msg += `🔹 [${_escapeHtml(d.id)}] <b>${_escapeHtml(d.objetivo)}</b> ($${formatMonto(d.monto)})\n`;
      msg += `   Notion: ${d.notion ? '✅ Actualizado' : 'ℹ️ Sin página en Notion'}\n\n`;
    });
  }

  if (failed.length > 0) {
    msg += `⚠️ <b>No pude actualizar Notion para estos DAPs maduros</b> (no se marcaron; se reintentará mañana):\n\n`;
    failed.forEach((d) => {
      msg += `🔸 [${_escapeHtml(d.id)}] <b>${_escapeHtml(d.objetivo)}</b> ($${formatMonto(d.monto)})\n`;
    });
  }

  sendTelegramMessage(chatId, msg);
  console.info(`✅ Cron Job: Reporte diario enviado (${liquidated.length} liquidado(s), ${failed.length} con error).`);
}
