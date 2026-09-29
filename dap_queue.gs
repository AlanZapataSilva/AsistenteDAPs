/**
 * @fileoverview dap_queue.gs - Gestor de la cola de procesamiento.
 */

'use strict';

/**
 * Lee la base de datos buscando el primer DAP pendiente y notifica al usuario por Telegram.
 * Implementa un patrón "First In, First Out" (FIFO) procesando un elemento a la vez.
 */
function pingNextPendingDap() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  
  if (!spreadsheetId || !chatId) {
    console.error('❌ Cola: Faltan credenciales de entorno (Spreadsheet o Chat ID).');
    return;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('⚠️ Cola ocupada: No se pudo obtener el Lock. Se reintentará luego.');
    return;
  }

  try {
    // Evitamos pisar una conversación FSM en curso: si ya hay un DAP activo en
    // caché, no debemos avanzar la cola (dejaría esa fila huérfana en
    // ESPERANDO_TELEGRAM para siempre, ya que el caché perdería su referencia).
    const cache = CacheService.getScriptCache();
    if (cache.get(`${chatId}_ACTIVE_DAP`)) {
      console.info('ℹ️ Cola: Ya existe una conversación DAP activa en caché. Se pospone el avance de la cola.');
      return;
    }

    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
    const data = sheet.getDataRange().getValues();

    // Iteramos desde la fila 2 (saltando los encabezados)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const estadoCola = row[DAP_COLS.Estado_Cola - 1];

      // Llegados aquí no hay conversación activa en caché (ver guard arriba), por lo que una fila
      // en ESPERANDO_TELEGRAM es huérfana (ej. su sesión expiró por TTL) y se vuelve a preguntar.
      if (estadoCola === 'PENDIENTE_OBJETIVO' || estadoCola === 'ESPERANDO_TELEGRAM') {
        const idInterno = row[DAP_COLS.ID_Interno - 1];

        // 1. Prevención de Concurrencia: Mutamos el estado en Sheets inmediatamente
        const rowIndex = i + 1;
        sheet.getRange(rowIndex, DAP_COLS.Estado_Cola).setValue('ESPERANDO_TELEGRAM');
        SpreadsheetApp.flush();
        
        // 2. Preparación de la Máquina de Estados (FSM) en Caché
        const TTL_SECONDS = 21600; // 6 horas de validez de la sesión
        
        // Forzamos String() para evitar fallos de Type Coercion al comparar más adelante
        cache.put(`${chatId}_ACTIVE_DAP`, String(idInterno), TTL_SECONDS); 
        cache.put(`${chatId}_DAP_STEP`, 'ESPERANDO_OBJETIVO', TTL_SECONDS);
        
        // 3. Construcción y envío del mensaje (delegamos el envío a telegram.gs, DRY)
        sendTelegramMessage(chatId, _buildNewDapMessage(row));
        
        console.info(`✅ Cola: Notificación enviada para DAP [${idInterno}]. FSM a la espera de respuesta.`);
        
        // Rompemos el bucle: Solo procesamos UNO a la vez para no saturar al usuario
        break; 
      }
    }
  } catch (error) {
    console.error(`❌ Error crítico en pingNextPendingDap: ${error.stack || error.message}`);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Arma el mensaje HTML de Telegram que presenta un DAP pendiente y pide su Objetivo.
 * @private
 * @param {Array} row - Fila completa de la hoja DAPs (valores de getValues).
 * @returns {string} Mensaje en HTML de Telegram.
 */
function _buildNewDapMessage(row) {
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
  msg += `🆔 <b>${idInterno}</b>\n`;
  msg += `🔢 <b>N° operación:</b> ${idOperacion}\n`;
  msg += `💰 <b>Monto:</b> ${montoStr}\n`;
  msg += `⚙️ <b>Tipo:</b> ${tipoDap}\n`;
  msg += `📅 <b>Fecha de captación:</b> ${_formatDateLong(fechaInicio)}\n`;
  msg += `📅 <b>Fecha de vencimiento:</b> ${_formatDateLong(row[DAP_COLS.Fecha_Vencimiento - 1])}\n\n`;
  msg += `<i>Por favor, responde este mensaje indicando el <b>Objetivo</b> de este dinero (Ej: Vacaciones 2027, Fondo de Emergencia):</i>`;
  return msg;
}