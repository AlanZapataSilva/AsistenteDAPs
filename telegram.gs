/**
 * @fileoverview telegram.gs - Webhook y Máquina de Estados (FSM) para DAPs
 */

'use strict';

/**
 * Configura la URL del Webhook en la API de Telegram.
 * Debe ejecutarse manualmente una vez tras un Nuevo Despliegue.
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
  const telegramUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(url)}&drop_pending_updates=true`;
  
  try {
    const res = UrlFetchApp.fetch(telegramUrl);
    console.info(`✅ Webhook configurado: ${res.getContentText()}`);
  } catch (error) {
    console.error(`❌ Fallo al configurar Webhook: ${error.message}`);
  }
}

/**
 * Envía un mensaje de texto plano o HTML a un chat de Telegram.
 * @param {string|number} chatId - ID del chat destino.
 * @param {string} text - Contenido del mensaje.
 */
function sendTelegramMessage(chatId, text) {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  const cleanToken = botToken ? botToken.trim() : "";
  
  if (!cleanToken || !chatId) return;

  const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
  const payload = { 
    chat_id: chatId.toString(), 
    text: text, 
    parse_mode: 'HTML' 
  };
  
  _fetchWithRetry(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/**
 * Endpoint de entrada (Webhook). Procesa todos los mensajes entrantes de Telegram.
 * @param {Object} e - Evento POST proporcionado por Google Apps Script.
 */
function doPost(e) {
  // Obligatorio: Retornar HTTP 200 rápido para que Telegram no reintente
  const ACK = HtmlService.createHtmlOutput();
  
  try {
    const secretToken = getEnv('TELEGRAM_SECRET_TOKEN');

    // 1. Escudo de Seguridad: Token del Webhook
    if (!e.parameter.token || e.parameter.token !== secretToken) {
      console.warn('❌ ERROR ESCUDO 1: Token de seguridad de URL inválido.');
      return ACK;
    }

    const update = JSON.parse(e.postData.contents);
    
    // Ignorar eventos que no sean mensajes de texto
    if (!update.message || !update.message.text) {
      return ACK;
    }

    const chatId = update.message.chat.id.toString();
    const text = update.message.text.trim();
    const expectedChatId = getEnv('TELEGRAM_CHAT_ID');
    
    // 2. Escudo de Seguridad: Chat ID Autorizado
    if (chatId !== expectedChatId) {
      console.warn(`❌ ERROR ESCUDO 2: Intento de acceso no autorizado desde Chat ID: ${chatId}`);
      return ACK;
    }

    // --- ENRUTADOR DE COMANDOS ---
    
    // Comando Start / Hola
    if (text === '/start' || text.toLowerCase() === 'hola') {
      sendTelegramMessage(chatId, "🤖 ¡Hola! Soy tu gestor de Inversiones. Cuando detecte un nuevo DAP, te avisaré por aquí.");
      return ACK;
    }
    
    // Comando Manual de Liquidación
    if (text.toLowerCase().startsWith('/liquidar')) {
      const parts = text.split(' ');
      if (parts.length < 2) {
        sendTelegramMessage(chatId, "⚠️ Formato incorrecto. Usa: <code>/liquidar 1</code>");
        return ACK;
      }
      forceLiquidateDap(chatId, parts[1]);
      return ACK;
    }

    // --- MÁQUINA DE ESTADOS (FSM) ---
    const cache = CacheService.getScriptCache();
    const activeDapId = cache.get(`${chatId}_ACTIVE_DAP`);
    const step = cache.get(`${chatId}_DAP_STEP`);
    
    if (activeDapId && step) {
      handleDapConversation(chatId, text, activeDapId, step, cache);
    } else {
      sendTelegramMessage(chatId, "No hay ningún DAP pendiente de configuración en este momento.");
    }
    
  } catch (error) {
    console.error(`❌ Fallo crítico en doPost: ${error.stack || error.message}`);
  }
  
  return ACK;
}

/**
 * Controla la lógica conversacional del bot basándose en el estado actual (FSM).
 */
function handleDapConversation(chatId, text, activeDapId, step, cache) {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
  const data = sheet.getDataRange().getValues();
  
  let rowIndex = -1;
  let dapRow = null;
  
  // Buscar la fila exacta del DAP activo en la caché
  for (let i = 1; i < data.length; i++) {
    const idEnHoja = data[i][DAP_COLS.ID_Interno - 1] ? parseInt(data[i][DAP_COLS.ID_Interno - 1], 10) : null;
    const idEnCache = parseInt(activeDapId, 10);

    if (idEnHoja !== null && idEnHoja === idEnCache) {
      rowIndex = i + 1;
      dapRow = data[i];
      break;
    }
  }
  
  if (rowIndex === -1) {
    console.error(`❌ FSM Error: No se encontró el DAP [${activeDapId}] en la hoja de Sheets.`);
    return; 
  }

  // Lógica de transición de estados
  if (step === 'ESPERANDO_OBJETIVO') {
    sheet.getRange(rowIndex, DAP_COLS.Objetivo).setValue(text);

    const tipoDap = dapRow[DAP_COLS.Tipo_DAP - 1];
    if (tipoDap === 'RENOVABLE') {
      cache.put(`${chatId}_DAP_STEP`, 'ESPERANDO_LIQUIDACION', 21600);
      sendTelegramMessage(chatId, "🔄 Como es un DAP <b>RENOVABLE</b>, por favor indícame la Fecha Tentativa de Liquidación (Formato: YYYY-MM-DD).\n<i>Si no tienes fecha aún, responde 'saltar'.</i>");
    } else {
      // DAP Fijo: Fecha de liquidación hereda el vencimiento
      const fechaVencimiento = Utilities.formatDate(new Date(dapRow[DAP_COLS.Fecha_Vencimiento - 1]), Session.getScriptTimeZone(), "yyyy-MM-dd");
      sheet.getRange(rowIndex, DAP_COLS.Fecha_Liquidacion).setValue(fechaVencimiento);
      finalizeDap(chatId, activeDapId, rowIndex, sheet, cache);
    }

  } else if (step === 'ESPERANDO_LIQUIDACION') {
    const fechaLiq = text.toLowerCase() === 'saltar' ? "" : text;
    sheet.getRange(rowIndex, DAP_COLS.Fecha_Liquidacion).setValue(fechaLiq);
    finalizeDap(chatId, activeDapId, rowIndex, sheet, cache);
  }
}

/**
 * Cierra la conversación, envía el objeto a Notion y libera la cola.
 */
function finalizeDap(chatId, activeDapId, rowIndex, sheet, cache) {
  // Limpiar Caché Inmediatamente
  cache.remove(`${chatId}_ACTIVE_DAP`);
  cache.remove(`${chatId}_DAP_STEP`);
  
  sendTelegramMessage(chatId, "⏳ Guardando en la base de datos de Notion...");

  // Re-leer los datos actualizados para construir el DTO
  const data = sheet.getDataRange().getValues();
  const row = data[rowIndex - 1]; 
  
  const dapDto = {
    ID_Interno: row[DAP_COLS.ID_Interno - 1],
    ID_Operacion: row[DAP_COLS.ID_Operacion - 1],
    Monto: row[DAP_COLS.Monto - 1],
    Tipo_DAP: row[DAP_COLS.Tipo_DAP - 1],
    Fecha_Inicio: Utilities.formatDate(new Date(row[DAP_COLS.Fecha_Inicio - 1]), Session.getScriptTimeZone(), "yyyy-MM-dd"),
    Fecha_Vencimiento: Utilities.formatDate(new Date(row[DAP_COLS.Fecha_Vencimiento - 1]), Session.getScriptTimeZone(), "yyyy-MM-dd"),
    Objetivo: row[DAP_COLS.Objetivo - 1],
    Fecha_Liquidacion: row[DAP_COLS.Fecha_Liquidacion - 1] ? Utilities.formatDate(new Date(row[DAP_COLS.Fecha_Liquidacion - 1]), Session.getScriptTimeZone(), "yyyy-MM-dd") : null,
    Liquidado: row[DAP_COLS.Liquidado - 1]
  };

  const notionPageId = pushDapToNotion(dapDto);

  // Actualizar Sheets
  sheet.getRange(rowIndex, DAP_COLS.Estado_Cola).setValue('COMPLETADO');
  if (notionPageId) {
    sheet.getRange(rowIndex, DAP_COLS.Notion_Page_ID).setValue(notionPageId);
    sendTelegramMessage(chatId, `✅ <b>¡DAP ${activeDapId} registrado exitosamente!</b>\nObjetivo: ${dapDto.Objetivo}`);
  } else {
    sendTelegramMessage(chatId, "⚠️ Se guardó en Sheets, pero hubo un error enviando a Notion.");
  }
  
  SpreadsheetApp.flush();
  
  // Desencadenar el siguiente en la cola
  pingNextPendingDap(); 
}

/**
 * Liquida manualmente un DAP mediante un comando de Telegram.
 */
function forceLiquidateDap(chatId, idInterno) {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
  const data = sheet.getDataRange().getValues();

  let rowIndex = -1;
  let notionPageId = "";

  for (let i = 1; i < data.length; i++) {
    if (data[i][DAP_COLS.ID_Interno - 1] && parseInt(data[i][DAP_COLS.ID_Interno - 1], 10) === parseInt(idInterno, 10)) {
      rowIndex = i + 1;
      notionPageId = data[i][DAP_COLS.Notion_Page_ID - 1];
      break;
    }
  }

  if (rowIndex === -1) {
    sendTelegramMessage(chatId, `❌ No encontré el registro DAP <b>${idInterno}</b> en la base de datos.`);
    return;
  }

  let notionMsg = "";
  if (notionPageId) {
    const success = updateNotionDapStatus(notionPageId);
    notionMsg = success ? "\n✅ <i>Base de datos de Notion actualizada.</i>" : "\n⚠️ <i>Falló la actualización en Notion.</i>";
  }

  sheet.getRange(rowIndex, DAP_COLS.Liquidado).setValue(true);
  SpreadsheetApp.flush();

  sendTelegramMessage(chatId, `✅ <b>DAP ${idInterno}</b> marcado como liquidado manualmente.` + notionMsg);
}