/**
 * @fileoverview dap_ops.gs - Operaciones de mantenimiento y recuperación (triggers y herramientas
 * manuales): liberar la cola, watchdog, reintento de sincronización con Notion y respaldo del Sheet.
 */

'use strict';

/**
 * Libera la cola de DAPs para retomar las preguntas de Telegram: devuelve a `PENDIENTE_OBJETIVO`
 * toda fila que esté en `ESPERANDO_TELEGRAM`, limpia las claves de caché de versiones antiguas
 * (que guardaban ahí el estado) y vuelve a lanzar la cola. Ejecutar manualmente cuando una
 * conversación quedó atascada.
 * @returns {void}
 */
function releaseDapQueue() {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) {
    console.error('❌ Liberar cola: Falta TELEGRAM_CHAT_ID en las propiedades.');
    return;
  }

  const cache = CacheService.getScriptCache();
  cache.remove(`${chatId}_ACTIVE_DAP`);
  cache.remove(`${chatId}_DAP_STEP`);

  let released = 0;
  const result = _withScriptLock(() => {
    const sheet = _openDapSheet();
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][DAP_COLS.Estado_Cola - 1] !== CONFIG.STATES.ESPERANDO_TELEGRAM) continue;
      sheet.getRange(i + 1, DAP_COLS.Estado_Cola).setValue(CONFIG.STATES.PENDIENTE_OBJETIVO);
      sheet.getRange(i + 1, DAP_COLS.Paso_Conversacion).setValue('');
      sheet.getRange(i + 1, DAP_COLS.Avisos_Enviados).setValue(0);
      released++;
    }
    SpreadsheetApp.flush();
  }, 10000);

  if (!result.acquired) {
    console.warn('⚠️ Liberar cola: No se pudo obtener el Lock. Reintenta en unos segundos.');
    return;
  }

  console.info(`🔓 Cola liberada: ${released} fila(s) devuelta(s) a PENDIENTE_OBJETIVO. Reanudando...`);
  pingNextPendingDap();
}

/**
 * Trigger horario: reactiva la cola (avisa del siguiente DAP pendiente o reenvía la pregunta si
 * una conversación lleva demasiado tiempo sin respuesta). Cubre el caso en que ningún evento
 * nuevo (correo o mensaje) vuelva a disparar la cola.
 * @returns {void}
 */
function watchdogTick() {
  pingNextPendingDap();
}

/**
 * Trigger periódico (outbox hacia Notion): reintenta el envío de los DAP que quedaron en
 * `PENDIENTE_NOTION` porque Notion falló al finalizar la conversación. Tras
 * `CONFIG.NOTION.MAX_SYNC_ATTEMPTS` fallos deja de insistir y alerta (queda visible en healthCheck).
 * @returns {void}
 */
function retryNotionSync() {
  try {
    const result = _withScriptLock(() => _retryNotionSyncLocked(), 10000);
    if (!result.acquired) console.warn('⚠️ retryNotionSync: No se pudo obtener el Lock; se reintentará en la próxima ejecución.');
  } catch (error) {
    console.error(`❌ Error en retryNotionSync: ${error.stack || error.message}`);
    _alertAdmin('RETRY_NOTION_ERROR', `Fallo en el reintento de Notion: <code>${_escapeHtml(error.message)}</code>`);
  }
}

/**
 * Cuerpo de `retryNotionSync` (debe ejecutarse bajo el lock de script).
 * @private
 * @returns {void}
 */
function _retryNotionSyncLocked() {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  const sheet = _openDapSheet();
  const data = sheet.getDataRange().getValues();
  const startMs = Date.now();
  let synced = 0;
  let failed = 0;
  let gaveUp = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[DAP_COLS.Estado_Cola - 1] !== CONFIG.STATES.PENDIENTE_NOTION) continue;
    if (!_hasTimeLeft(startMs)) break;

    const idInterno = row[DAP_COLS.ID_Interno - 1];
    const attempts = Number(row[DAP_COLS.Notion_Intentos - 1]) || 0;
    if (attempts >= CONFIG.NOTION.MAX_SYNC_ATTEMPTS) {
      gaveUp++;
      continue;
    }

    let pageId = null;
    try {
      pageId = pushDapToNotion(_buildDapDtoFromRow(row));
    } catch (error) {
      console.error(`❌ retryNotionSync: excepción con el DAP [${idInterno}]: ${error.message}`);
    }

    const rowIndex = i + 1;
    if (pageId) {
      sheet.getRange(rowIndex, DAP_COLS.Estado_Cola).setValue(CONFIG.STATES.COMPLETADO);
      sheet.getRange(rowIndex, DAP_COLS.Notion_Page_ID).setValue(pageId);
      sheet.getRange(rowIndex, DAP_COLS.Notion_Intentos).setValue(0);
      synced++;
      if (chatId) sendTelegramMessage(chatId, `✅ El DAP ${_escapeHtml(idInterno)} quedó sincronizado con Notion.`);
    } else {
      sheet.getRange(rowIndex, DAP_COLS.Notion_Intentos).setValue(attempts + 1);
      failed++;
      if (attempts + 1 >= CONFIG.NOTION.MAX_SYNC_ATTEMPTS) {
        _alertAdmin(`NOTION_GIVEUP_${idInterno}`, `El DAP ${_escapeHtml(idInterno)} no se pudo enviar a Notion tras ${attempts + 1} intentos. Revisa el token/esquema de Notion y ejecuta releaseDapQueue() o corrige a mano.`);
      }
    }
  }

  SpreadsheetApp.flush();
  console.info(`🔁 retryNotionSync: ${synced} sincronizado(s), ${failed} fallido(s), ${gaveUp} sin reintentos restantes.`);
}

/**
 * Trigger semanal: guarda una copia (pestaña oculta `Backup_YYYY-MM-DD`) de la hoja de DAPs en
 * el mismo documento y conserva solo las 8 más recientes. Protege contra ediciones o borrados
 * accidentales sin pedir permisos adicionales de Drive (el historial de versiones de Google
 * Sheets cubre la pérdida del archivo completo).
 * @returns {void}
 */
function backupSheet() {
  try {
    const result = _withScriptLock(() => {
      const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
      if (!spreadsheetId) throw new Error('Falta SHARED_SPREADSHEET_ID.');

      const ss = SpreadsheetApp.openById(spreadsheetId);
      const source = ss.getSheetByName(CONFIG.SHEETS.DAPS);
      if (!source) throw new Error(`No existe la hoja "${CONFIG.SHEETS.DAPS}".`);

      const name = `Backup_${_todayIso()}`;
      if (ss.getSheetByName(name)) {
        console.info(`ℹ️ Backup: ya existe ${name}.`);
        return;
      }

      const copy = source.copyTo(ss);
      copy.setName(name);
      copy.hideSheet();

      ss.getSheets()
        .filter((sheet) => /^Backup_\d{4}-\d{2}-\d{2}$/.test(sheet.getName()))
        .sort((a, b) => b.getName().localeCompare(a.getName()))
        .slice(8)
        .forEach((old) => ss.deleteSheet(old));

      console.info(`💾 Backup: creada la pestaña oculta ${name}.`);
    }, 30000);

    if (!result.acquired) console.warn('⚠️ Backup: No se pudo obtener el Lock; se reintentará la próxima semana.');
  } catch (error) {
    console.error(`❌ Error en backupSheet: ${error.stack || error.message}`);
    _alertAdmin('BACKUP_ERROR', `Fallo en el respaldo semanal: <code>${_escapeHtml(error.message)}</code>`);
  }
}
