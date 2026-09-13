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
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
    const data = sheet.getDataRange().getValues();
    
    // Iteramos desde la fila 2 (saltando los encabezados)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const estadoCola = row[9]; // Índice 9 -> Columna J
      
      if (estadoCola === 'PENDIENTE_OBJETIVO') {
        const idInterno = row[0];
        const monto = row[2];
        const tipoDap = row[3];
        const fecVencimientoRaw = row[5];
        
        // 1. Prevención de Concurrencia: Mutamos el estado en Sheets inmediatamente
        const rowIndex = i + 1;
        sheet.getRange(rowIndex, 10).setValue('ESPERANDO_TELEGRAM');
        SpreadsheetApp.flush();
        
        // 2. Preparación de la Máquina de Estados (FSM) en Caché
        const cache = CacheService.getScriptCache();
        const TTL_SECONDS = 21600; // 6 horas de validez de la sesión
        
        // Forzamos String() para evitar fallos de Type Coercion al comparar más adelante
        cache.put(`${chatId}_ACTIVE_DAP`, String(idInterno), TTL_SECONDS); 
        cache.put(`${chatId}_DAP_STEP`, 'ESPERANDO_OBJETIVO', TTL_SECONDS);
        
        // 3. Formateo de UI para el usuario
        // Si Sheets entregó un objeto Date, lo formateamos para que sea legible
        const fecVencimientoStr = (fecVencimientoRaw instanceof Date) 
            ? Utilities.formatDate(fecVencimientoRaw, Session.getScriptTimeZone(), "yyyy-MM-dd") 
            : fecVencimientoRaw;
            
        const montoFormateado = new Intl.NumberFormat('es-CL').format(monto);
        
        // 4. Construcción y Envío del Mensaje
        let msg = `🔔 <b>¡Nuevo Depósito a Plazo Detectado!</b>\n\n`;
        msg += `🆔 <b>${idInterno}</b>\n`;
        msg += `💰 <b>Monto:</b> $${montoFormateado}\n`;
        msg += `⚙️ <b>Tipo:</b> ${tipoDap}\n`;
        msg += `📅 <b>Fecha vencimiento:</b> ${fecVencimientoStr}\n\n`;
        msg += `<i>Por favor, responde este mensaje indicando el <b>Objetivo</b> de este dinero (Ej: Vacaciones 2027, Fondo de Emergencia):</i>`;
        
        // Delegamos el envío a la función especializada de telegram.gs (DRY)
        sendTelegramMessage(chatId, msg);
        
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