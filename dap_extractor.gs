/**
 * @fileoverview dap_extractor.gs - Orquestador de búsqueda y guardado en cola.
 * Un correo NUNCA se etiqueta como "procesado" si no se pudo interpretar: en ese caso queda con
 * la etiqueta de error y se avisa al administrador, para que un cambio de plantilla del banco no
 * haga perder DAPs en silencio.
 */

'use strict';

/**
 * Resumen de una corrida de extracción.
 * @typedef {Object} ExtractionSummary
 * @property {number} threads - Hilos devueltos por la búsqueda.
 * @property {number} enqueued - DAPs nuevos encolados en el Sheet.
 * @property {number} duplicates - Comprobantes repetidos (mismo N° de operación) omitidos.
 * @property {number} retryLater - Hilos no etiquetados para reintentar (ej. falta el valor de la UF).
 * @property {number} labeledError - Hilos etiquetados como error (correo no interpretable).
 * @property {number} errors - Excepciones inesperadas durante la corrida.
 * @property {boolean} truncated - true si se cortó por el presupuesto de tiempo.
 * @property {boolean} busy - true si no se pudo obtener el lock.
 */

/**
 * Busca nuevos correos de DAPs, los procesa y los encola en la BD remota.
 * Diseñado para ser ejecutado mediante un Cron Job (Time-driven trigger).
 * @returns {ExtractionSummary} Resumen de la corrida.
 */
function processDapEmails() {
  return _runDapEmailExtraction({
    query: _buildDapSearchQuery('newer_than:30d'),
    maxThreads: 10,
    flushEveryThreads: 0
  });
}

/**
 * Términos de búsqueda de Gmail que excluyen una etiqueta. Se incluyen las dos formas de
 * escribir una etiqueta anidada ("Padre/Hijo" y "Padre-Hijo") porque Gmail no documenta cuál
 * usa el operador `label:`; `healthCheck()` verifica que la exclusión funcione.
 * @private
 * @param {string} labelName - Nombre de la etiqueta.
 * @returns {string} Términos `-label:...`.
 */
function _labelExclusionTerms(labelName) {
  return `-label:${labelName} -label:${labelName.replace(/[/\s]+/g, '-')}`;
}

/**
 * Arma la consulta de Gmail para correos de DAP aún no procesados.
 * @param {string} timeWindow - Ventana de tiempo de Gmail (ej. `newer_than:30d` o `after:2025/01/01`).
 * @returns {string} Consulta de Gmail.
 */
function _buildDapSearchQuery(timeWindow) {
  const from = CONFIG.BANKS.BCI.SENDER_DOMAINS.map((domain) => `from:${domain}`).join(' OR ');
  return `(${from}) subject:"${DAP_BCI_LOGIC.SUBJECT}" ${_labelExclusionTerms(CONFIG.GMAIL.LABEL_DAP_PROCESSED)} ${_labelExclusionTerms(CONFIG.GMAIL.LABEL_DAP_ERROR)} ${timeWindow}`;
}

/**
 * Indica si el remitente de un correo pertenece a un dominio bancario permitido. El operador
 * `from:` de Gmail busca coincidencias parciales, así que el dominio se valida aquí de forma exacta.
 * @param {string} fromHeader - Valor de `GmailMessage.getFrom()` (ej. `BCI <avisos@bci.cl>`).
 * @returns {boolean} true si el dominio es uno de `CONFIG.BANKS.BCI.SENDER_DOMAINS` (o un subdominio).
 */
function _isAllowedSender(fromHeader) {
  const angle = String(fromHeader || '').match(/<([^>]+)>/);
  const address = (angle ? angle[1] : String(fromHeader || '')).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return false;

  const domain = address.slice(at + 1);
  return CONFIG.BANKS.BCI.SENDER_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

/**
 * Obtiene una etiqueta de Gmail, creándola si no existe.
 * @private
 * @param {string} name - Nombre de la etiqueta.
 * @returns {GoogleAppsScript.Gmail.GmailLabel} Etiqueta.
 */
function _ensureLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/**
 * Núcleo compartido de extracción de correos: busca hilos según `query`, parsea cada
 * mensaje y encola los DAPs nuevos en el Sheet. Opera bajo el lock de script y nunca lanza
 * excepciones (las registra y alerta).
 * @private
 * @param {Object} options
 * @param {string} options.query - Query de búsqueda de Gmail.
 * @param {number} options.maxThreads - Máximo de hilos a traer (pasado a GmailApp.search).
 * @param {number} options.flushEveryThreads - Si es > 0, fuerza SpreadsheetApp.flush() cada
 *   N hilos procesados, para no perder progreso si una ejecución larga se corta por timeout.
 * @param {number} [options.maxRuntimeMs] - Presupuesto de tiempo; al agotarse se corta y `truncated` queda true.
 * @returns {ExtractionSummary} Resumen de la corrida.
 */
function _runDapEmailExtraction(options) {
  const summary = { threads: 0, enqueued: 0, duplicates: 0, retryLater: 0, labeledError: 0, errors: 0, truncated: false, busy: false };

  try {
    const result = _withScriptLock(() => _extractLocked(options, summary), 10000);
    if (!result.acquired) {
      summary.busy = true;
      console.warn('⚠️ Extractor ocupado: No se pudo obtener el Lock de seguridad. Se reintentará en la próxima ejecución.');
    }
  } catch (error) {
    summary.errors++;
    console.error(`❌ Error CRÍTICO en _runDapEmailExtraction: ${error.stack || error.message}`);
    _alertAdmin('EXTRACTOR_ERROR', `Fallo en la extracción de correos: <code>${_escapeHtml(error.message)}</code>`);
  }

  return summary;
}

/**
 * Cuerpo de la extracción (debe ejecutarse bajo el lock de script).
 * @private
 * @param {Object} options - Ver `_runDapEmailExtraction`.
 * @param {ExtractionSummary} summary - Resumen que se va completando.
 * @returns {void}
 */
function _extractLocked(options, summary) {
  const startMs = Date.now();
  const sheet = _openDapSheet();
  const ctx = {
    labelProcessed: _ensureLabel(CONFIG.GMAIL.LABEL_DAP_PROCESSED),
    labelError: _ensureLabel(CONFIG.GMAIL.LABEL_DAP_ERROR),
    existingIds: _getExistingMessageIds(sheet),
    existingOps: _getExistingOperationIds(sheet)
  };

  const threads = GmailApp.search(options.query, 0, options.maxThreads);
  summary.threads = threads.length;

  if (threads.length === 0) {
    console.info('ℹ️ Extracción: No hay correos nuevos de DAPs pendientes.');
    return;
  }
  console.info(`🔄 Iniciando procesamiento de ${threads.length} hilos de correo encontrados.`);

  threads.forEach((thread, index) => {
    if (!_hasTimeLeft(startMs, options.maxRuntimeMs)) {
      summary.truncated = true;
      return;
    }

    try {
      _processThread(thread, sheet, ctx, summary);
    } catch (error) {
      summary.errors++;
      console.error(`❌ Error procesando el hilo ${thread.getId()}: ${error.stack || error.message}`);
      _alertAdmin(`THREAD_${thread.getId()}`, `Error procesando un correo de DAP: <code>${_escapeHtml(error.message)}</code>`);
    }

    if (options.flushEveryThreads && (index + 1) % options.flushEveryThreads === 0) {
      SpreadsheetApp.flush();
      console.info(`💾 Progreso guardado (${index + 1}/${threads.length} hilos procesados).`);
    }
  });

  // Forzamos la escritura inmediata en el documento antes de llamar al siguiente paso
  SpreadsheetApp.flush();

  if (summary.enqueued > 0) {
    console.info(`🚀 Lote completado: ${summary.enqueued} DAPs nuevos. Llamando al lector de cola...`);
    pingNextPendingDap();
  }
}

/**
 * Procesa un hilo de correo: encola sus DAPs y lo etiqueta según el resultado
 * (procesado / error de lectura / sin etiqueta para reintentar).
 * @private
 * @param {GoogleAppsScript.Gmail.GmailThread} thread - Hilo de Gmail.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @param {{labelProcessed: GoogleAppsScript.Gmail.GmailLabel, labelError: GoogleAppsScript.Gmail.GmailLabel, existingIds: Set<string>, existingOps: Set<number>}} ctx - Contexto compartido de la corrida.
 * @param {ExtractionSummary} summary - Resumen que se va completando.
 * @returns {void}
 */
function _processThread(thread, sheet, ctx, summary) {
  const alreadyLabeled = thread.getLabels().some((label) => {
    const name = label.getName();
    return name === CONFIG.GMAIL.LABEL_DAP_PROCESSED || name === CONFIG.GMAIL.LABEL_DAP_ERROR;
  });
  if (alreadyLabeled) return;

  let retryLater = false;
  const errors = [];

  thread.getMessages().forEach((msg) => {
    const messageId = msg.getId();
    // Si el mensaje ya está en la hoja (ej. un reintento tras un fallo parcial), no lo duplicamos
    if (ctx.existingIds.has(messageId)) return;

    if (!_isAllowedSender(msg.getFrom())) {
      errors.push({ code: 'REMITENTE_NO_PERMITIDO', message: `Remitente no permitido: ${msg.getFrom()}` });
      return;
    }

    const parsed = parseBciDapEmailDetailed(msg);
    if (!parsed.ok) {
      errors.push(parsed.error);
      return;
    }

    const dapDto = parsed.dto;
    const operationId = _normalizeOperationId(dapDto.ID_Operacion);

    // El banco puede reenviar el mismo comprobante en otro correo: no se duplica el DAP
    if (ctx.existingOps.has(operationId)) {
      summary.duplicates++;
      console.info(`ℹ️ Comprobante repetido (operación ${operationId}); se omite.`);
      return;
    }

    if (!_enrichWithClpAmount(dapDto)) {
      // Sin valor UF no podemos calcular el monto en CLP: no encolamos ni etiquetamos el hilo
      // para que se reintente en la próxima ejecución.
      retryLater = true;
      return;
    }

    const idInterno = _generateNextInternalId(sheet);

    // Inserción en Sheets: los valores se ordenan según CONFIG.HEADERS.DAPS (no por posición fija)
    const valores = {
      ID_Interno: idInterno,
      ID_Operacion: operationId,
      Monto: dapDto.Monto,
      Tipo_DAP: dapDto.Tipo_DAP,
      Fecha_Inicio: dapDto.Fecha_Inicio,
      Fecha_Vencimiento: dapDto.Fecha_Vencimiento,
      Objetivo: '',
      Fecha_Liquidacion: '',
      Liquidado: false,
      Estado_Cola: CONFIG.STATES.PENDIENTE_OBJETIVO,
      ID_Mensaje_Email: messageId,
      Notion_Page_ID: '',
      Moneda: dapDto.Moneda,
      Monto_Original: dapDto.Monto_Original,
      Valor_UF: dapDto.Valor_UF || '',
      Paso_Conversacion: '',
      Ultimo_Aviso: '',
      Avisos_Enviados: 0,
      Notion_Intentos: 0
    };
    sheet.appendRow(CONFIG.HEADERS.DAPS.map((header) => valores[header]));
    ctx.existingIds.add(messageId);
    ctx.existingOps.add(operationId);

    summary.enqueued++;
    console.info(`✅ DAP Encolado exitosamente: ${idInterno} | Operación: ${operationId} | ${dapDto.Moneda}`);
  });

  if (retryLater) {
    summary.retryLater++;
    return;
  }

  if (errors.length > 0) {
    thread.addLabel(ctx.labelError);
    summary.labeledError++;

    const detail = errors.map((e) => `${e.code}: ${e.message}`).join('\n');
    console.error(`❌ Correo de DAP no interpretable (hilo ${thread.getId()}):\n${detail}`);
    _alertAdmin(`PARSE_${thread.getId()}`,
      `No pude interpretar un correo de DAP.\n<b>Asunto:</b> ${_escapeHtml(thread.getFirstMessageSubject())}\n` +
      `<b>Motivos:</b>\n${_escapeHtml(detail)}\n` +
      `Quedó con la etiqueta <code>${_escapeHtml(CONFIG.GMAIL.LABEL_DAP_ERROR)}</code> para revisión manual.`);
    return;
  }

  thread.addLabel(ctx.labelProcessed);
}

/**
 * Lee de la hoja los IDs de mensaje de Gmail ya registrados.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de cálculo de DAPs.
 * @returns {Set<string>} IDs de mensaje presentes en la columna ID_Mensaje_Email.
 */
function _getExistingMessageIds(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const values = sheet.getRange(2, DAP_COLS.ID_Mensaje_Email, lastRow - 1, 1).getValues();
  return new Set(values.map((row) => String(row[0])).filter((id) => id !== ''));
}

/**
 * Lee de la hoja los números de operación ya registrados.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de cálculo de DAPs.
 * @returns {Set<number>} Números de operación (normalizados) presentes en la columna ID_Operacion.
 */
function _getExistingOperationIds(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const values = sheet.getRange(2, DAP_COLS.ID_Operacion, lastRow - 1, 1).getValues();
  const ids = new Set();
  values.forEach((row) => {
    const id = _normalizeOperationId(row[0]);
    if (!isNaN(id)) ids.add(id);
  });
  return ids;
}

/**
 * Calcula el siguiente ID Interno: el máximo de la columna + 1 (no mira solo la última fila,
 * que puede no ser la mayor si la hoja se ordenó o se editó a mano).
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de cálculo de DAPs.
 * @returns {number} Entero secuencial simple (Ej: 1, 2, 42), sin prefijo.
 */
function _generateNextInternalId(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;

  const values = sheet.getRange(2, DAP_COLS.ID_Interno, lastRow - 1, 1).getValues();
  let max = 0;
  values.forEach((row) => {
    const n = parseInt(row[0], 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return max + 1;
}
