/**
 * @fileoverview dap_health.gs - Verificación de salud del sistema (healthCheck) y canario del
 * parser. Ambos son triggers: avisan por Telegram solo cuando hay algo que revisar.
 */

'use strict';

/**
 * Hallazgo de una verificación de salud.
 * @typedef {Object} HealthFinding
 * @property {'ok'|'warn'|'error'} level - Severidad.
 * @property {string} code - Código de la verificación (ej. 'NOTION_ESQUEMA').
 * @property {string} message - Descripción legible.
 */

/**
 * Prueba si la exclusión `-label:` de Gmail funciona para una etiqueta anidada: una búsqueda que
 * pida la etiqueta y a la vez la excluya debe devolver 0 resultados.
 * @private
 * @param {string} labelName - Nombre de la etiqueta.
 * @returns {'ok'|'broken'|'unknown'} 'unknown' si aún no hay hilos con esa etiqueta para probar.
 */
function _verifyLabelExclusion(labelName) {
  const label = GmailApp.getUserLabelByName(labelName);
  if (!label || label.getThreads(0, 1).length === 0) return 'unknown';

  const forms = [labelName, labelName.replace(/[/\s]+/g, '-')];
  const positive = forms.find((form) => GmailApp.search(`label:${form}`, 0, 1).length > 0);
  if (!positive) return 'unknown';

  return GmailApp.search(`label:${positive} ${_labelExclusionTerms(labelName)}`, 0, 1).length === 0 ? 'ok' : 'broken';
}

/**
 * Consulta la versión del código que ejecuta el Web App DESPLEGADO (endpoint `doGet`).
 * @private
 * @returns {string|null} Versión, 'desactualizado' si el Web App no soporta la consulta, o null si no se pudo consultar.
 */
function _fetchDeployedVersion() {
  const webAppUrl = getEnv('WEB_APP_URL');
  const secret = getEnv('TELEGRAM_SECRET_TOKEN');
  if (!webAppUrl || !secret) return null;

  const res = _fetchWithRetry(`${webAppUrl}?token=${encodeURIComponent(secret)}`, { method: 'get', muteHttpExceptions: true });
  if (!res || res.getResponseCode() !== 200) return null;

  const text = res.getContentText().trim();
  return /^\d{4}-\d{2}-\d{2}\.\d+$/.test(text) ? text : 'desactualizado';
}

/**
 * Ejecuta todas las verificaciones de salud y devuelve los hallazgos (cada verificación está
 * aislada: si una falla, se reporta como error y las demás continúan).
 * @private
 * @returns {HealthFinding[]} Hallazgos de todas las verificaciones.
 */
function _collectHealthFindings() {
  /** @type {HealthFinding[]} */
  const findings = [];
  const add = (level, code, message) => findings.push({ level: level, code: code, message: message });
  const check = (code, fn) => {
    try {
      fn();
    } catch (error) {
      add('error', code, `La verificación falló: ${error.message}`);
    }
  };

  check('PROPIEDADES', () => {
    const missing = CONFIG.REQUIRED_PROPERTIES.filter((key) => !getEnv(key));
    if (missing.length) add('error', 'PROPIEDADES', `Faltan propiedades del script: ${missing.join(', ')}.`);
    const secret = getEnv('TELEGRAM_SECRET_TOKEN');
    if (secret && secret.length < 24) add('warn', 'TOKEN_DEBIL', 'TELEGRAM_SECRET_TOKEN es corto (<24 caracteres): usa uno largo y aleatorio.');
  });

  let data = null;
  check('ESQUEMA_SHEET', () => {
    const sheet = _openDapSheet();
    data = sheet.getDataRange().getValues();
  });

  check('ETIQUETAS', () => {
    [CONFIG.GMAIL.LABEL_DAP_PROCESSED, CONFIG.GMAIL.LABEL_DAP_ERROR].forEach((name) => {
      if (!GmailApp.getUserLabelByName(name)) add('warn', 'ETIQUETA_FALTANTE', `Faltaba la etiqueta ${name} (se creará en la próxima extracción).`);
      if (_verifyLabelExclusion(name) === 'broken') {
        add('error', 'LABEL_EXCLUSION', `La exclusión "-label:" de ${name} no funciona en Gmail: los correos ya procesados volverían a aparecer en cada búsqueda.`);
      }
    });
    const errorLabel = GmailApp.getUserLabelByName(CONFIG.GMAIL.LABEL_DAP_ERROR);
    if (errorLabel && errorLabel.getThreads(0, 1).length > 0) {
      add('warn', 'CORREOS_CON_ERROR', `Hay correos de DAP sin interpretar (etiqueta ${CONFIG.GMAIL.LABEL_DAP_ERROR}). Revísalos: puede haber cambiado la plantilla del banco.`);
    }
  });

  check('TRIGGERS', () => {
    const installed = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    const missing = _TRIGGER_SPECS.map((s) => s.handler).filter((handler) => !installed.includes(handler));
    if (missing.length) add('error', 'TRIGGERS', `Faltan triggers: ${missing.join(', ')}. Ejecuta installDapApp().`);
  });

  check('NOTION_ESQUEMA', () => {
    const token = getEnv('NOTION_API_TOKEN');
    const dbId = getEnv('NOTION_DAP_DATABASE_ID');
    if (!token || !dbId) return;
    _validateNotionSchema(token, dbId).forEach((problem) => add('error', 'NOTION_ESQUEMA', problem));
  });

  check('TELEGRAM_WEBHOOK', () => {
    const token = (getEnv('TELEGRAM_BOT_TOKEN') || '').trim();
    if (!token) return;
    const res = _fetchWithRetry(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get', muteHttpExceptions: true });
    if (!res || res.getResponseCode() !== 200) {
      add('error', 'TELEGRAM_WEBHOOK', 'No se pudo consultar getWebhookInfo de Telegram.');
      return;
    }
    const info = JSON.parse(res.getContentText()).result || {};
    const webAppUrl = getEnv('WEB_APP_URL');
    if (!info.url) add('error', 'TELEGRAM_WEBHOOK', 'El webhook de Telegram no está configurado (ejecuta setupWebhook()).');
    else if (webAppUrl && info.url.indexOf(webAppUrl) !== 0) add('warn', 'TELEGRAM_WEBHOOK', 'El webhook de Telegram apunta a una URL distinta de WEB_APP_URL.');
    if (info.pending_update_count > 5) add('warn', 'TELEGRAM_PENDIENTES', `Telegram tiene ${info.pending_update_count} updates sin entregar.`);
    if (info.last_error_date && Date.now() / 1000 - info.last_error_date < 86400) {
      add('warn', 'TELEGRAM_ERROR', `Último error de entrega del webhook: ${info.last_error_message}`);
    }
  });

  check('UF', () => {
    if (!getUfValue(_todayIso())) add('error', 'UF', 'No se pudo obtener el valor de la UF (CMF ni respaldo).');
  });

  check('VERSION', () => {
    const deployed = _fetchDeployedVersion();
    if (deployed === null) add('warn', 'VERSION', 'No se pudo verificar la versión del Web App desplegado.');
    else if (deployed === 'desactualizado') add('error', 'VERSION', `El Web App desplegado está desactualizado (no responde la versión). Crea una nueva versión de la implementación (código actual: ${APP_VERSION}).`);
    else if (deployed !== APP_VERSION) add('error', 'VERSION', `El Web App desplegado ejecuta ${deployed} pero el código actual es ${APP_VERSION}. Crea una nueva versión de la implementación.`);
  });

  check('ESTADOS', () => {
    if (!data) return;
    const now = Date.now();
    let waiting = 0;
    let pendingNotion = 0;
    let exhausted = 0;
    let withoutPage = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const estado = row[DAP_COLS.Estado_Cola - 1];
      if (estado === CONFIG.STATES.ESPERANDO_TELEGRAM) {
        const last = _toEpochMs(row[DAP_COLS.Ultimo_Aviso - 1]);
        if (!last || now - last > 24 * 3600000) waiting++;
      } else if (estado === CONFIG.STATES.PENDIENTE_NOTION) {
        pendingNotion++;
        if ((Number(row[DAP_COLS.Notion_Intentos - 1]) || 0) >= CONFIG.NOTION.MAX_SYNC_ATTEMPTS) exhausted++;
      } else if (estado === CONFIG.STATES.COMPLETADO && !row[DAP_COLS.Notion_Page_ID - 1]) {
        withoutPage++;
      }
    }

    if (waiting) add('warn', 'CONVERSACION_ATASCADA', `${waiting} DAP llevan más de 24 h esperando tu respuesta en Telegram.`);
    if (pendingNotion) add(exhausted ? 'error' : 'warn', 'PENDIENTE_NOTION', `${pendingNotion} DAP pendientes de sincronizar con Notion (${exhausted} sin reintentos restantes).`);
    if (withoutPage) add('warn', 'SIN_PAGINA_NOTION', `${withoutPage} DAP COMPLETADOS no tienen Notion_Page_ID.`);
  });

  return findings;
}

/**
 * Trigger diario: verifica propiedades, esquema del Sheet y de Notion, etiquetas de Gmail
 * (incluida la exclusión `-label:`), triggers, webhook de Telegram, UF, versión desplegada y
 * estados atascados. Avisa por Telegram solo si hay hallazgos (y envía un latido los lunes si
 * todo está bien).
 * @returns {HealthFinding[]} Hallazgos (vacío de problemas si todo está en orden).
 */
function healthCheck() {
  const findings = _collectHealthFindings();
  const problems = findings.filter((f) => f.level !== 'ok');
  const chatId = getEnv('TELEGRAM_CHAT_ID');

  if (problems.length === 0) {
    console.info(`✅ healthCheck: sin problemas (v${APP_VERSION}).`);
    if (chatId && new Date().getDay() === 1) sendTelegramMessage(chatId, `✅ <b>Sistema OK</b> (v${APP_VERSION}).`);
    return findings;
  }

  const lines = problems.map((f) => `${f.level === 'error' ? '🔴' : '🟡'} <b>${_escapeHtml(f.code)}</b>: ${_escapeHtml(f.message)}`);
  problems.forEach((f) => console.warn(`🩺 [${f.level}] ${f.code}: ${f.message}`));
  _alertAdmin('HEALTH', `🩺 <b>Health check</b> (v${APP_VERSION}): ${problems.length} hallazgo(s)\n${lines.join('\n')}`);
  return findings;
}

/**
 * Trigger semanal (canario): re-parsea los correos de DAP de los últimos 60 días (máx. 20 hilos)
 * y avisa si alguno ya no se puede interpretar o si el resultado difiere de lo guardado en el
 * Sheet. Detecta a tiempo un cambio de plantilla del banco.
 * @returns {void}
 */
function parserCanary() {
  try {
    const sheet = _openDapSheet();
    const rowsByMessage = {};
    const rowsByLiquidationMessage = {};
    sheet.getDataRange().getValues().slice(1).forEach((row) => {
      rowsByMessage[String(row[DAP_COLS.ID_Mensaje_Email - 1])] = row;
      const liquidationMessageId = String(row[DAP_COLS.ID_Mensaje_Liquidacion - 1] || '');
      if (liquidationMessageId) rowsByLiquidationMessage[liquidationMessageId] = row;
    });

    const threads = GmailApp.search(_buildDapSearchQuery('newer_than:60d').replace(/-label:\S+/g, '').trim(), 0, 20);
    let total = 0;
    const failures = [];
    const mismatches = [];

    threads.forEach((thread) => thread.getMessages().forEach((msg) => {
      if (!_isAllowedSender(msg.getFrom())) return;
      total++;

      const parsed = parseBciDapEmailDetailed(msg);
      if (!parsed.ok) {
        failures.push(`${parsed.error.code} — "${_truncate(msg.getSubject(), 50)}"`);
        return;
      }

      const row = rowsByMessage[msg.getId()];
      if (!row) return;
      const dto = parsed.dto;
      const id = row[DAP_COLS.ID_Interno - 1];
      const stored = {
        operacion: _normalizeOperationId(row[DAP_COLS.ID_Operacion - 1]),
        moneda: row[DAP_COLS.Moneda - 1] || 'CLP',
        tipo: row[DAP_COLS.Tipo_DAP - 1],
        inicio: _toIsoDate(row[DAP_COLS.Fecha_Inicio - 1]),
        vencimiento: _toIsoDate(row[DAP_COLS.Fecha_Vencimiento - 1])
      };
      if (stored.operacion !== _normalizeOperationId(dto.ID_Operacion)) mismatches.push(`DAP [${id}] ID_Operacion`);
      if (stored.moneda !== dto.Moneda) mismatches.push(`DAP [${id}] Moneda`);
      if (stored.tipo !== dto.Tipo_DAP) mismatches.push(`DAP [${id}] Tipo_DAP`);
      if (stored.inicio !== dto.Fecha_Inicio) mismatches.push(`DAP [${id}] Fecha_Inicio`);
      if (stored.vencimiento !== dto.Fecha_Vencimiento) mismatches.push(`DAP [${id}] Fecha_Vencimiento`);
    }));

    // Plantilla del correo de liquidación: misma vigilancia (se detecta un cambio antes de que se pierdan liquidaciones)
    const liquidationQuery = _buildDapLiquidationSearchQuery('newer_than:60d').replace(/-label:\S+/g, '').trim();
    GmailApp.search(liquidationQuery, 0, 20).forEach((thread) => thread.getMessages().forEach((msg) => {
      if (!_isAllowedLiquidationSender(msg.getFrom())) return;
      total++;

      const parsed = parseBciLiquidationEmailDetailed(msg);
      if (!parsed.ok) {
        failures.push(`${parsed.error.code} — liquidación "${_truncate(msg.getSubject(), 50)}"`);
        return;
      }

      const row = rowsByLiquidationMessage[msg.getId()];
      if (!row) return;
      const id = row[DAP_COLS.ID_Interno - 1];
      const storedAmount = _numberOrNull(row[DAP_COLS.Monto_Final_Original - 1]);
      if (_normalizeOperationId(row[DAP_COLS.ID_Operacion - 1]) !== _normalizeOperationId(parsed.dto.ID_Operacion)) mismatches.push(`DAP [${id}] liquidación ID_Operacion`);
      if (storedAmount === null || Math.abs(storedAmount - parsed.dto.Monto_Final_Original) > 0.00005) mismatches.push(`DAP [${id}] liquidación Monto_Final_Original`);
    }));

    console.info(`🐤 Canario del parser: ${total} correo(s) revisado(s), ${failures.length} sin interpretar, ${mismatches.length} diferencia(s).`);
    if (failures.length || mismatches.length) {
      _alertAdmin('CANARY',
        `🐤 <b>Canario del parser</b>: ${failures.length} correo(s) sin interpretar y ${mismatches.length} diferencia(s) con lo guardado.\n` +
        `${_escapeHtml(failures.concat(mismatches).slice(0, 10).join('\n'))}`);
    }
  } catch (error) {
    console.error(`❌ Error en parserCanary: ${error.stack || error.message}`);
    _alertAdmin('CANARY_ERROR', `Fallo en el canario del parser: <code>${_escapeHtml(error.message)}</code>`);
  }
}
