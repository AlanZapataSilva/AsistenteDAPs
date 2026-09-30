/**
 * @fileoverview telegram.gs - Webhook y Máquina de Estados (FSM) para DAPs.
 * El estado de la conversación vive en el Sheet (columnas Estado_Cola / Paso_Conversacion), no
 * en el caché: el caché puede evictarse antes de tiempo. El DAP activo es la fila en estado
 * ESPERANDO_TELEGRAM.
 */

'use strict';

/**
 * Configura la URL del Webhook en la API de Telegram.
 * Debe ejecutarse manualmente una vez tras un Nuevo Despliegue.
 * @returns {void}
 */
function setupWebhook() {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  const webAppUrl = getEnv('WEB_APP_URL');
  const secretToken = getEnv('TELEGRAM_SECRET_TOKEN');

  if (!webAppUrl) {
    console.error("❌ Falta WEB_APP_URL. Debes hacer un Nuevo Despliegue primero.");
    return;
  }

  const url = `${webAppUrl}?token=${secretToken}`;
  const telegramUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(url)}&drop_pending_updates=true&allowed_updates=${encodeURIComponent('["message"]')}`;

  try {
    const res = UrlFetchApp.fetch(telegramUrl, { muteHttpExceptions: true });
    // Si se cambia de bot, la numeración de update_id vuelve a empezar: se reinicia el dedupe
    PropertiesService.getScriptProperties().deleteProperty('LAST_UPDATE_ID');
    console.info(`✅ Webhook configurado: ${res.getContentText()}`);
  } catch (error) {
    console.error(`❌ Fallo al configurar Webhook: ${error.message}`);
  }
}

/**
 * Envía un POST a la API de Telegram.
 * @private
 * @param {string} url - Endpoint completo (contiene el token del bot: no loguear).
 * @param {Object} payload - Cuerpo JSON.
 * @returns {GoogleAppsScript.URL_Fetch.HTTPResponse|null} Respuesta o null si falló la red.
 */
function _postTelegram(url, payload) {
  return _fetchWithRetry(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/**
 * Envía un mensaje de texto (HTML) a un chat de Telegram. Trocea los mensajes que superen el
 * límite de Telegram, y si Telegram rechaza el HTML (400 "can't parse entities") reintenta como
 * texto plano para no perder el aviso.
 * @param {string|number} chatId - ID del chat destino.
 * @param {string} text - Contenido del mensaje (HTML de Telegram; escapa el texto del usuario con `_escapeHtml`).
 * @returns {boolean} true si TODAS las partes se entregaron; false si falló alguna.
 */
function sendTelegramMessage(chatId, text) {
  const cleanToken = (getEnv('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!cleanToken || !chatId) return false;

  const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
  const parts = _splitMessage(text, CONFIG.LIMITS.TELEGRAM_MESSAGE_MAX);
  if (parts.length === 0) return false;

  let allDelivered = true;
  parts.forEach((part) => {
    const res = _postTelegram(url, { chat_id: String(chatId), text: part, parse_mode: 'HTML' });
    if (res && res.getResponseCode() === 200) return;

    if (res && res.getResponseCode() === 400 && /parse entities/i.test(res.getContentText())) {
      const plain = _postTelegram(url, { chat_id: String(chatId), text: part.replace(/<[^>]+>/g, '') });
      if (plain && plain.getResponseCode() === 200) {
        console.warn('⚠️ Telegram rechazó el HTML del mensaje; se envió como texto plano.');
        return;
      }
    }

    allDelivered = false;
    console.error(`❌ Telegram no entregó el mensaje (código ${res ? res.getResponseCode() : 'sin respuesta'}): ${res ? _truncate(res.getContentText(), 300) : ''}`);
  });

  return allDelivered;
}

/**
 * Registra un update de Telegram para no procesarlo dos veces (Telegram reintenta el webhook
 * si tarda en responder). Los `update_id` son crecientes, así que basta con recordar el último.
 * @private
 * @param {number} updateId - `update_id` del update recibido.
 * @returns {boolean} true si el update es nuevo (y queda registrado); false si ya se procesó.
 */
function _registerUpdate(updateId) {
  if (typeof updateId !== 'number') return true;

  const props = PropertiesService.getScriptProperties();
  const last = parseInt(props.getProperty('LAST_UPDATE_ID') || '0', 10);
  if (updateId <= last) return false;

  props.setProperty('LAST_UPDATE_ID', String(updateId));
  return true;
}

/**
 * Endpoint de entrada (Webhook). Procesa todos los mensajes entrantes de Telegram. Siempre
 * responde 200 rápido para que Telegram no reintente; el trabajo se hace bajo el lock de script
 * y con dedupe por `update_id`.
 * @param {GoogleAppsScript.Events.DoPost} e - Evento POST proporcionado por Google Apps Script.
 * @returns {GoogleAppsScript.HTML.HtmlOutput} Respuesta vacía (ACK).
 */
function doPost(e) {
  const ACK = HtmlService.createHtmlOutput();

  try {
    const secretToken = getEnv('TELEGRAM_SECRET_TOKEN');

    // 1. Escudo de Seguridad: Token del Webhook
    if (!secretToken || !e.parameter || !e.parameter.token || e.parameter.token !== secretToken) {
      console.warn('❌ ERROR ESCUDO 1: Token de seguridad de URL inválido.');
      return ACK;
    }

    const update = JSON.parse(e.postData.contents);

    // Ignorar eventos que no sean mensajes de texto
    if (!update.message || !update.message.text) return ACK;

    const chatId = String(update.message.chat.id);
    const text = update.message.text.trim();

    // 2. Escudo de Seguridad: Chat ID Autorizado
    if (chatId !== String(getEnv('TELEGRAM_CHAT_ID'))) {
      console.warn(`❌ ERROR ESCUDO 2: Intento de acceso no autorizado desde Chat ID: ${chatId}`);
      return ACK;
    }

    const result = _withScriptLock(() => {
      if (!_registerUpdate(update.update_id)) {
        console.info(`ℹ️ Update ${update.update_id} ya procesado; se ignora (reintento de Telegram).`);
        return;
      }
      _routeMessage(chatId, text);
    }, 25000);

    if (!result.acquired) {
      sendTelegramMessage(chatId, '⏳ El sistema está ocupado procesando otra operación. Envía tu mensaje de nuevo en unos segundos.');
    }

  } catch (error) {
    console.error(`❌ Fallo crítico en doPost: ${error.stack || error.message}`);
    _alertAdmin('DOPOST_ERROR', `Fallo en el webhook: <code>${_escapeHtml(error.message)}</code>`);
  }

  return ACK;
}

/**
 * Endpoint de verificación: devuelve la versión del código que ejecuta el Web App desplegado
 * (solo con el token secreto). Lo usa `healthCheck()` para detectar despliegues desactualizados.
 * @param {GoogleAppsScript.Events.DoGet} e - Evento GET proporcionado por Google Apps Script.
 * @returns {GoogleAppsScript.Content.TextOutput} `APP_VERSION` o "forbidden".
 */
function doGet(e) {
  const secretToken = getEnv('TELEGRAM_SECRET_TOKEN');
  const authorized = secretToken && e && e.parameter && e.parameter.token === secretToken;
  return ContentService.createTextOutput(authorized ? APP_VERSION : 'forbidden');
}

/**
 * Enruta un mensaje ya autenticado: comandos o respuesta a la conversación activa.
 * Se ejecuta bajo el lock de script.
 * @private
 * @param {string} chatId - ID del chat autorizado.
 * @param {string} text - Texto del mensaje (sin espacios en los extremos).
 * @returns {void}
 */
function _routeMessage(chatId, text) {
  const lower = text.toLowerCase();

  if (text === '/start' || lower === 'hola') {
    sendTelegramMessage(chatId, "🤖 ¡Hola! Soy tu gestor de Inversiones. Cuando detecte un nuevo DAP, te avisaré por aquí.");
    return;
  }

  if (lower === '/version') {
    sendTelegramMessage(chatId, `🧩 Versión del código en ejecución: <code>${APP_VERSION}</code>`);
    return;
  }

  const liquidar = text.match(/^\/liquidar(?:@\w+)?(?:\s+(.*))?$/i);
  if (liquidar) {
    const argument = (liquidar[1] || '').trim();
    if (!/^\d+$/.test(argument)) {
      sendTelegramMessage(chatId, "⚠️ Formato incorrecto. Usa: <code>/liquidar 1</code> (el número es el ID interno del DAP).");
      return;
    }
    forceLiquidateDap(chatId, argument);
    return;
  }

  // Un comando desconocido no debe registrarse como respuesta de la conversación
  if (text.startsWith('/')) {
    sendTelegramMessage(chatId, "⚠️ Comando no reconocido. Comandos: <code>/liquidar N</code>, <code>/version</code>.");
    return;
  }

  // --- MÁQUINA DE ESTADOS (FSM): el DAP activo es la fila en ESPERANDO_TELEGRAM ---
  const sheet = _openDapSheet();
  const active = _findActiveConversation(sheet.getDataRange().getValues());
  if (!active) {
    sendTelegramMessage(chatId, "No hay ningún DAP pendiente de configuración en este momento.");
    return;
  }

  handleDapConversation(chatId, text, sheet, active.rowIndex, active.row);
}

/**
 * Marca el paso actual de la conversación de una fila y reinicia su reloj de recordatorios.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @param {number} rowIndex - Fila (base 1).
 * @param {string} step - Valor de CONFIG.STEPS.
 * @returns {void}
 */
function _setConversationStep(sheet, rowIndex, step) {
  sheet.getRange(rowIndex, DAP_COLS.Paso_Conversacion).setValue(step);
  sheet.getRange(rowIndex, DAP_COLS.Ultimo_Aviso).setValue(new Date().toISOString());
  sheet.getRange(rowIndex, DAP_COLS.Avisos_Enviados).setValue(1);
}

/**
 * Controla la lógica conversacional del bot para el DAP activo.
 * @param {string} chatId - ID del chat autorizado.
 * @param {string} text - Respuesta del usuario.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @param {number} rowIndex - Fila del DAP activo (base 1).
 * @param {Array} dapRow - Valores de la fila del DAP activo.
 * @returns {void}
 */
function handleDapConversation(chatId, text, sheet, rowIndex, dapRow) {
  const step = _getConversationStep(dapRow);
  // Un DAP en la cola solo puede estar Liquidado si su correo de liquidación llegó antes de que
  // respondieras: ya tiene la fecha real, así que no se pregunta ni se pisa (ver dap_liquidation.gs)
  const alreadyLiquidated = _isChecked(dapRow[DAP_COLS.Liquidado - 1]);

  if (step === CONFIG.STEPS.OBJETIVO) {
    const objetivo = _validateObjetivo(text);
    if (!objetivo.ok) {
      sendTelegramMessage(chatId, `⚠️ ${_escapeHtml(objetivo.error)} Intenta de nuevo.`);
      return;
    }

    _setPlainText(sheet, rowIndex, DAP_COLS.Objetivo, objetivo.value);

    if (alreadyLiquidated) {
      finalizeDap(chatId, sheet, rowIndex);
    } else if (dapRow[DAP_COLS.Tipo_DAP - 1] === 'RENOVABLE') {
      _setConversationStep(sheet, rowIndex, CONFIG.STEPS.LIQUIDACION);
      sendTelegramMessage(chatId, _buildLiquidationPrompt(dapRow));
    } else {
      // DAP Fijo: Fecha de liquidación hereda el vencimiento
      sheet.getRange(rowIndex, DAP_COLS.Fecha_Liquidacion).setValue(_toIsoDate(dapRow[DAP_COLS.Fecha_Vencimiento - 1]));
      finalizeDap(chatId, sheet, rowIndex);
    }
    return;
  }

  if (step === CONFIG.STEPS.LIQUIDACION) {
    if (alreadyLiquidated) {
      sendTelegramMessage(chatId, "ℹ️ Este DAP ya fue liquidado (según el correo del banco): no necesito la fecha tentativa.");
      finalizeDap(chatId, sheet, rowIndex);
      return;
    }

    if (text.toLowerCase() === 'saltar') {
      sheet.getRange(rowIndex, DAP_COLS.Fecha_Liquidacion).setValue("");
      finalizeDap(chatId, sheet, rowIndex);
      return;
    }

    const fechaIngresada = _parseUserDate(text);
    if (!fechaIngresada) {
      _setConversationStep(sheet, rowIndex, CONFIG.STEPS.LIQUIDACION);
      sendTelegramMessage(chatId, "⚠️ No entendí esa fecha. Usa el formato <code>YYYY-MM-DD</code> (ej. <code>2026-07-07</code>) o <code>DD-MM-YYYY</code>.\n<i>Si aún no tienes fecha, responde 'saltar'.</i>");
      return;
    }

    // La fecha debe caer dentro de alguna ventana de renovación; si no, se propone la más cercana y se vuelve a preguntar
    const renewal = _getRenewalInfo(dapRow);
    const check = renewal ? _validateRenewalDate(fechaIngresada, renewal.fecha1, renewal.plazo) : { valid: true };
    if (!check.valid) {
      _setConversationStep(sheet, rowIndex, CONFIG.STEPS.LIQUIDACION);
      sendTelegramMessage(chatId,
        `⚠️ La fecha <b>${_formatDateLong(fechaIngresada)}</b> no cae dentro de una ventana de renovación.\n` +
        `La fecha válida más cercana es <b>${_formatDateLong(check.suggested)}</b> (ventana: ${_formatRenewalWindow(check.window)}).\n\n` +
        `Ingresa nuevamente la fecha tentativa de liquidación, dentro de una ventana de renovación (o 'saltar').`);
      return;
    }

    sheet.getRange(rowIndex, DAP_COLS.Fecha_Liquidacion).setValue(fechaIngresada);
    finalizeDap(chatId, sheet, rowIndex);
    return;
  }

  console.error(`❌ FSM: paso desconocido "${step}" para la fila ${rowIndex}.`);
  sendTelegramMessage(chatId, "⚠️ Estado de la conversación desconocido. El administrador fue notificado.");
  _alertAdmin('FSM_STEP', `Paso de conversación desconocido: <code>${_escapeHtml(step)}</code> (fila ${rowIndex}).`);
}

/**
 * Mensaje que pide la fecha tentativa de liquidación de un DAP renovable, indicando la
 * próxima ventana de renovación en la que puede liquidarse.
 * @private
 * @param {Array} dapRow - Fila del DAP en la hoja.
 * @returns {string} Mensaje HTML de Telegram.
 */
function _buildLiquidationPrompt(dapRow) {
  let msg = "🔄 Como es un DAP <b>RENOVABLE</b>, indícame la <b>fecha tentativa de liquidación</b> (formato YYYY-MM-DD).\n";
  const renewal = _getRenewalInfo(dapRow);
  if (renewal) {
    const nextWindow = _nextRenewalWindow(renewal.fecha1, renewal.plazo, _todayIso());
    msg += `La fecha debe estar dentro de una ventana de renovación (cada ${renewal.plazo} días). Próxima ventana: ${_formatRenewalWindow(nextWindow)}.\n`;
  }
  msg += "<i>Si no tienes fecha aún, responde 'saltar'.</i>";
  return msg;
}

/**
 * Cierra la conversación, envía el DAP a Notion y libera la cola. Si Notion falla, el DAP queda
 * en PENDIENTE_NOTION y `retryNotionSync()` lo reintenta automáticamente (nunca se marca
 * COMPLETADO sin su página en Notion).
 * @param {string} chatId - ID del chat autorizado.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @param {number} rowIndex - Fila del DAP (base 1).
 * @returns {void}
 */
function finalizeDap(chatId, sheet, rowIndex) {
  sendTelegramMessage(chatId, "⏳ Guardando en la base de datos de Notion...");

  // Re-leer los datos actualizados para construir el DTO
  const row = sheet.getDataRange().getValues()[rowIndex - 1];
  const dapDto = _buildDapDtoFromRow(row);
  const idInterno = row[DAP_COLS.ID_Interno - 1];

  let notionPageId = null;
  try {
    notionPageId = pushDapToNotion(dapDto);
  } catch (error) {
    console.error(`❌ finalizeDap: excepción al enviar el DAP [${idInterno}] a Notion: ${error.stack || error.message}`);
  }

  sheet.getRange(rowIndex, DAP_COLS.Paso_Conversacion).setValue('');
  if (notionPageId) {
    sheet.getRange(rowIndex, DAP_COLS.Estado_Cola).setValue(CONFIG.STATES.COMPLETADO);
    sheet.getRange(rowIndex, DAP_COLS.Notion_Page_ID).setValue(notionPageId);
    sheet.getRange(rowIndex, DAP_COLS.Notion_Intentos).setValue(0);
    sendTelegramMessage(chatId, `✅ <b>¡DAP ${_escapeHtml(idInterno)} registrado exitosamente!</b>\nObjetivo: ${_escapeHtml(dapDto.Objetivo)}`);
  } else {
    sheet.getRange(rowIndex, DAP_COLS.Estado_Cola).setValue(CONFIG.STATES.PENDIENTE_NOTION);
    sheet.getRange(rowIndex, DAP_COLS.Notion_Intentos).setValue(1);
    sendTelegramMessage(chatId, `⚠️ El DAP ${_escapeHtml(idInterno)} se guardó en Sheets, pero falló el envío a Notion. Lo reintentaré automáticamente.`);
    _alertAdmin(`NOTION_SYNC_${idInterno}`, `No se pudo enviar el DAP ${_escapeHtml(idInterno)} a Notion; quedó PENDIENTE_NOTION (se reintenta solo).`);
  }

  SpreadsheetApp.flush();

  // Desencadenar el siguiente en la cola
  pingNextPendingDap();
}

/**
 * Liquida manualmente un DAP mediante un comando de Telegram. Solo marca el Sheet si Notion
 * quedó actualizado (o si el DAP no tiene página en Notion), para no dejar ambos desincronizados.
 * @param {string} chatId - ID del chat autorizado.
 * @param {string} idInterno - ID interno del DAP (solo dígitos).
 * @returns {void}
 */
function forceLiquidateDap(chatId, idInterno) {
  const sheet = _openDapSheet();
  const found = _findRowByInternalId(sheet.getDataRange().getValues(), idInterno);

  if (!found) {
    sendTelegramMessage(chatId, `❌ No encontré el registro DAP <b>${_escapeHtml(idInterno)}</b> en la base de datos.`);
    return;
  }

  const estado = found.row[DAP_COLS.Estado_Cola - 1];
  if (estado !== CONFIG.STATES.COMPLETADO) {
    sendTelegramMessage(chatId, `⚠️ El DAP <b>${_escapeHtml(idInterno)}</b> aún no está completado (estado: ${_escapeHtml(estado)}).`);
    return;
  }

  if (_isChecked(found.row[DAP_COLS.Liquidado - 1])) {
    sendTelegramMessage(chatId, `ℹ️ El DAP <b>${_escapeHtml(idInterno)}</b> ya estaba marcado como liquidado.`);
    return;
  }

  const notionPageId = found.row[DAP_COLS.Notion_Page_ID - 1];
  if (notionPageId && !updateNotionDapStatus(notionPageId)) {
    sendTelegramMessage(chatId, `⚠️ No pude actualizar Notion, así que <b>no</b> marqué el DAP ${_escapeHtml(idInterno)} como liquidado. Reintenta en unos minutos.`);
    return;
  }

  sheet.getRange(found.rowIndex, DAP_COLS.Liquidado).setValue(true);
  SpreadsheetApp.flush();

  sendTelegramMessage(chatId, `✅ <b>DAP ${_escapeHtml(idInterno)}</b> marcado como liquidado manualmente.` +
    (notionPageId ? "\n✅ <i>Base de datos de Notion actualizada.</i>" : "\nℹ️ <i>El DAP no tiene página en Notion.</i>"));
}
