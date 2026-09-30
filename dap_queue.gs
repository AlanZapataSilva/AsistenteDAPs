/**
 * @fileoverview dap_queue.gs - Gestor de la cola de procesamiento.
 * Cola FIFO de un solo DAP activo a la vez. El estado vive en el Sheet (no en el caché):
 *   PENDIENTE_OBJETIVO -> ESPERANDO_TELEGRAM (Paso_Conversacion) -> COMPLETADO | PENDIENTE_NOTION
 */

'use strict';

/**
 * Avanza la cola: si ya hay una conversación activa (fila ESPERANDO_TELEGRAM) reenvía la pregunta
 * cuando lleva demasiado tiempo sin respuesta; si no la hay, avisa por Telegram del primer DAP
 * pendiente. Es segura de llamar en cualquier momento (extractor, cierre de conversación,
 * watchdog): opera bajo el lock de script y nunca lanza excepciones.
 * @returns {void}
 */
function pingNextPendingDap() {
  try {
    const result = _withScriptLock(() => _advanceQueue(), 10000);
    if (!result.acquired) console.warn('⚠️ Cola ocupada: No se pudo obtener el Lock. Se reintentará luego.');
  } catch (error) {
    console.error(`❌ Error crítico en pingNextPendingDap: ${error.stack || error.message}`);
    _alertAdmin('QUEUE_ERROR', `Fallo al avanzar la cola: <code>${_escapeHtml(error.message)}</code>`);
  }
}

/**
 * Lógica de `pingNextPendingDap` (debe ejecutarse bajo el lock de script).
 * @private
 * @returns {void}
 */
function _advanceQueue() {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) {
    console.error('❌ Cola: Falta TELEGRAM_CHAT_ID en las propiedades.');
    return;
  }

  const sheet = _openDapSheet();
  const data = sheet.getDataRange().getValues();

  // 1. Si hay una conversación activa no se avanza (un DAP a la vez); solo se recuerda si se estancó.
  const active = _findActiveConversation(data);
  if (active) {
    _remindIfStale(chatId, sheet, active);
    return;
  }

  // 2. Sin conversación activa: activar el primer DAP pendiente (FIFO)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[DAP_COLS.Estado_Cola - 1] !== CONFIG.STATES.PENDIENTE_OBJETIVO) continue;

    const rowIndex = i + 1;
    const idInterno = row[DAP_COLS.ID_Interno - 1];

    // Prevención de concurrencia: el estado se muta en Sheets ANTES de avisar
    sheet.getRange(rowIndex, DAP_COLS.Estado_Cola).setValue(CONFIG.STATES.ESPERANDO_TELEGRAM);
    sheet.getRange(rowIndex, DAP_COLS.Paso_Conversacion).setValue(CONFIG.STEPS.OBJETIVO);
    sheet.getRange(rowIndex, DAP_COLS.Ultimo_Aviso).setValue(new Date().toISOString());
    sheet.getRange(rowIndex, DAP_COLS.Avisos_Enviados).setValue(1);
    SpreadsheetApp.flush();

    if (sendTelegramMessage(chatId, _buildNewDapMessage(row))) {
      console.info(`✅ Cola: Notificación enviada para DAP [${idInterno}]. Esperando respuesta.`);
    } else {
      // Si el aviso no se entregó, el DAP vuelve a la cola (el watchdog lo reintentará)
      sheet.getRange(rowIndex, DAP_COLS.Estado_Cola).setValue(CONFIG.STATES.PENDIENTE_OBJETIVO);
      sheet.getRange(rowIndex, DAP_COLS.Paso_Conversacion).setValue('');
      sheet.getRange(rowIndex, DAP_COLS.Avisos_Enviados).setValue(0);
      SpreadsheetApp.flush();
      console.error(`❌ Cola: No se pudo enviar el aviso del DAP [${idInterno}]; vuelve a PENDIENTE_OBJETIVO.`);
      _alertAdmin('QUEUE_SEND', `No se pudo enviar por Telegram el aviso del DAP ${_escapeHtml(idInterno)}. Reintentaré en la próxima revisión.`);
    }

    // Solo se avisa de UN DAP a la vez para no saturar al usuario
    return;
  }
}

/**
 * Reenvía la pregunta pendiente si la conversación activa lleva más de
 * `CONFIG.FSM.REMINDER_HOURS` sin respuesta (máximo `CONFIG.FSM.MAX_REMINDERS` recordatorios;
 * después alerta al administrador). Una fila sin `Ultimo_Aviso` (anterior a esta columna) se
 * considera estancada y se reenvía de inmediato.
 * @private
 * @param {string} chatId - ID del chat autorizado.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @param {{rowIndex: number, row: Array}} active - Conversación activa.
 * @returns {void}
 */
function _remindIfStale(chatId, sheet, active) {
  const row = active.row;
  const idInterno = row[DAP_COLS.ID_Interno - 1];
  const lastMs = _toEpochMs(row[DAP_COLS.Ultimo_Aviso - 1]);
  const sent = Number(row[DAP_COLS.Avisos_Enviados - 1]) || 0;

  if (lastMs && Date.now() - lastMs < CONFIG.FSM.REMINDER_HOURS * 3600000) return;

  if (sent > CONFIG.FSM.MAX_REMINDERS) {
    _alertAdmin(`FSM_STALE_${idInterno}`, `El DAP ${_escapeHtml(idInterno)} lleva mucho tiempo sin respuesta en Telegram (${sent} avisos).`);
    return;
  }

  const step = _getConversationStep(row);
  const question = step === CONFIG.STEPS.LIQUIDACION ? _buildLiquidationPrompt(row) : _buildNewDapMessage(row);
  if (sendTelegramMessage(chatId, `⏰ <b>Recordatorio: DAP pendiente de respuesta</b>\n\n${question}`)) {
    sheet.getRange(active.rowIndex, DAP_COLS.Ultimo_Aviso).setValue(new Date().toISOString());
    sheet.getRange(active.rowIndex, DAP_COLS.Avisos_Enviados).setValue(sent + 1);
    console.info(`⏰ Cola: Recordatorio ${sent} enviado para el DAP [${idInterno}].`);
  }
}

/**
 * Arma el mensaje HTML de Telegram que presenta un DAP pendiente y pide su Objetivo.
 * @private
 * @param {Array} row - Fila completa de la hoja DAPs (valores de getValues).
 * @param {string} [todayIso] - Fecha de hoy (ISO); por defecto la actual. Solo afecta a DAP renovables.
 * @returns {string} Mensaje en HTML de Telegram.
 */
function _buildNewDapMessage(row, todayIso) {
  const idInterno = row[DAP_COLS.ID_Interno - 1];
  const idOperacion = row[DAP_COLS.ID_Operacion - 1];
  const monto = row[DAP_COLS.Monto - 1];
  const tipoDap = row[DAP_COLS.Tipo_DAP - 1];
  const moneda = row[DAP_COLS.Moneda - 1];
  const montoOriginal = row[DAP_COLS.Monto_Original - 1];
  const valorUF = row[DAP_COLS.Valor_UF - 1];
  const fechaInicio = _toIsoDate(row[DAP_COLS.Fecha_Inicio - 1]);

  let montoStr = `$${new Intl.NumberFormat('es-CL').format(monto)}`;
  if (moneda === 'UF' && montoOriginal && valorUF) {
    const ufStr = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 4 }).format(montoOriginal);
    const valorUfStr = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(valorUF);
    const fechaCorta = fechaInicio.split('-').reverse().join('/');
    montoStr = `UF ${ufStr} ≈ ${montoStr} <i>(UF del ${fechaCorta}: $${valorUfStr})</i>`;
  }

  let msg = `🔔 <b>¡Nuevo Depósito a Plazo Detectado!</b>\n\n`;
  msg += `🆔 <b>${_escapeHtml(idInterno)}</b>\n`;
  msg += `🔢 <b>N° operación:</b> ${_escapeHtml(idOperacion)}\n`;
  msg += `💰 <b>Monto:</b> ${montoStr}\n`;
  msg += `💱 <b>Moneda original:</b> ${moneda === 'UF' ? 'UF (convertida a pesos)' : 'Pesos chilenos (CLP)'}\n`;
  msg += `⚙️ <b>Tipo:</b> ${_escapeHtml(tipoDap)}\n`;
  msg += `📅 <b>Fecha de captación:</b> ${_formatDateLong(fechaInicio)}\n`;

  // Si el correo de liquidación llegó antes que tu respuesta, el DAP ya está liquidado: no tiene sentido proponer ventanas
  const liquidated = _isChecked(row[DAP_COLS.Liquidado - 1]);
  const renewal = tipoDap === 'RENOVABLE' && !liquidated ? _getRenewalInfo(row) : null;
  if (renewal) {
    // Un DAP renovable no "vence": se renueva cada `plazo` días y se puede liquidar en la ventana de renovación
    const nextWindow = _nextRenewalWindow(renewal.fecha1, renewal.plazo, todayIso || _todayIso());
    msg += `🔄 <b>Plazo de renovación:</b> ${renewal.plazo} días\n`;
    msg += `🗓️ <b>Próxima ventana de renovación:</b> ${_formatRenewalWindow(nextWindow)}\n\n`;
  } else {
    msg += `📅 <b>Fecha de vencimiento:</b> ${_formatDateLong(row[DAP_COLS.Fecha_Vencimiento - 1])}\n`;
    if (liquidated) {
      const montoFinal = _numberOrNull(row[DAP_COLS.Monto_Final - 1]);
      msg += `✅ <b>Ya liquidado</b> el ${_formatDateLong(row[DAP_COLS.Fecha_Liquidacion - 1])}`;
      if (montoFinal !== null) msg += ` — monto final $${new Intl.NumberFormat('es-CL').format(montoFinal)}`;
      msg += `\n`;
    }
    msg += `\n`;
  }

  msg += `<i>Por favor, responde este mensaje indicando el <b>Objetivo</b> de este dinero (Ej: Vacaciones 2027, Fondo de Emergencia):</i>`;
  return msg;
}
