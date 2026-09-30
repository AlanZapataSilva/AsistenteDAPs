/**
 * @fileoverview dap_liquidation.gs - Correos de liquidación de DAP ("Comprobante de liquidación de
 * Depósito a plazo", enviados por contacto@bci.cl). Cada correo identifica el depósito por su N° y
 * trae la fecha real y el monto final: se marca el DAP como liquidado en Notion y en el Sheet y se
 * guarda el monto final (ver dap_final_amount.gs).
 *
 * Reglas de este flujo:
 *  - Notion primero, Sheet después (igual que el cron): si Notion falla el hilo queda sin etiquetar y
 *    se reintenta en la próxima corrida; el Sheet nunca queda por delante de Notion.
 *  - Idempotencia por MENSAJE (columna ID_Mensaje_Liquidacion) y por DAP (Origen_Monto_Final), no solo
 *    por etiqueta de hilo: Gmail puede agrupar correos con el mismo asunto en un hilo ya etiquetado y
 *    la búsqueda con `-label:` lo ocultaría para siempre.
 *  - Un correo que no se puede interpretar, o cuyo N° de depósito no existe en el Sheet, se etiqueta
 *    con `DAP_Error` y se avisa: nunca se inventa un DAP ni se ignora en silencio.
 */

'use strict';

/**
 * Resumen de una corrida de liquidaciones.
 * @typedef {Object} LiquidationSummary
 * @property {number} threads - Hilos devueltos por la búsqueda.
 * @property {number} applied - Liquidaciones registradas (en simulación: las que se registrarían).
 * @property {number} duplicates - Correos de una liquidación ya registrada (reenvíos).
 * @property {number} orphans - Liquidaciones cuyo N° de depósito no existe en el Sheet.
 * @property {number} retryLater - Correos pendientes de reintento (UF sin valor o Notion caído).
 * @property {number} labeledError - Hilos etiquetados como error.
 * @property {number} errors - Excepciones inesperadas durante la corrida.
 * @property {boolean} truncated - true si se cortó por el presupuesto de tiempo.
 * @property {boolean} busy - true si no se pudo obtener el lock.
 */

/**
 * Detalle de una liquidación registrada (para el aviso por Telegram).
 * @typedef {Object} AppliedLiquidation
 * @property {number|string} id - ID interno del DAP.
 * @property {string} objetivo - Objetivo del DAP.
 * @property {number} monto - Monto invertido en CLP.
 * @property {number} montoFinal - Monto final en CLP.
 * @property {string} moneda - Moneda del DAP.
 * @property {number} montoFinalOriginal - Monto final en la moneda del DAP.
 * @property {string} fecha - Fecha real de liquidación (YYYY-MM-DD).
 * @property {boolean} completado - false si el DAP aún está en la cola de Telegram.
 */

/**
 * Trigger (cada 30 min): busca correos de liquidación recientes y los registra.
 * @returns {LiquidationSummary} Resumen de la corrida.
 */
function processDapLiquidationEmails() {
  return _runLiquidationExtraction({
    query: _buildDapLiquidationSearchQuery('newer_than:30d'),
    maxThreads: 20,
    flushEveryThreads: 0,
    dryRun: false,
    notify: true
  });
}

/**
 * Arma la consulta de Gmail de los correos de liquidación. Solo excluye la etiqueta de error (los
 * correos ya registrados se reconocen por su ID de mensaje; ver el fileoverview).
 * @param {string} timeWindow - Ventana de tiempo de Gmail (ej. `newer_than:30d` o `after:2025/01/01`).
 * @returns {string} Consulta de Gmail.
 */
function _buildDapLiquidationSearchQuery(timeWindow) {
  const from = CONFIG.BANKS.BCI.LIQUIDATION_SENDERS.map((address) => `from:${address}`).join(' OR ');
  return `(${from}) subject:"${DAP_BCI_LIQUIDATION.SUBJECT}" ${_labelExclusionTerms(CONFIG.GMAIL.LABEL_DAP_ERROR)} ${timeWindow}`;
}

/**
 * Indica si el remitente es una de las direcciones exactas autorizadas para liquidaciones.
 * @param {string} fromHeader - Valor de `GmailMessage.getFrom()`.
 * @returns {boolean} true si la dirección está en `CONFIG.BANKS.BCI.LIQUIDATION_SENDERS`.
 */
function _isAllowedLiquidationSender(fromHeader) {
  return CONFIG.BANKS.BCI.LIQUIDATION_SENDERS.indexOf(_senderAddress(fromHeader)) >= 0;
}

/**
 * Núcleo compartido de la extracción de liquidaciones (trigger y reprocesamiento histórico): opera
 * bajo el lock de script y nunca lanza excepciones (las registra y alerta).
 * @private
 * @param {Object} options
 * @param {string} options.query - Consulta de Gmail.
 * @param {number} options.maxThreads - Máximo de hilos a traer.
 * @param {number} options.flushEveryThreads - Si es > 0, fuerza `SpreadsheetApp.flush()` cada N hilos.
 * @param {boolean} options.dryRun - true = simulación: no escribe, no etiqueta, no llama a Notion ni avisa.
 * @param {boolean} options.notify - true = avisar por Telegram las liquidaciones registradas.
 * @param {number} [options.maxRuntimeMs] - Presupuesto de tiempo; al agotarse se corta y `truncated` queda true.
 * @param {Set<number>} [options.simulatedOperations] - Solo en simulación: recibe los N° de operación que se
 *   habrían liquidado (permite que la simulación de otras fases sea fiel a la ejecución real).
 * @returns {LiquidationSummary} Resumen de la corrida.
 */
function _runLiquidationExtraction(options) {
  const summary = { threads: 0, applied: 0, duplicates: 0, orphans: 0, retryLater: 0, labeledError: 0, errors: 0, truncated: false, busy: false };

  try {
    const result = _withScriptLock(() => _liquidationLocked(options, summary), 10000);
    if (!result.acquired) {
      summary.busy = true;
      console.warn('⚠️ Liquidaciones: No se pudo obtener el Lock de seguridad. Se reintentará en la próxima ejecución.');
    }
  } catch (error) {
    summary.errors++;
    console.error(`❌ Error CRÍTICO en _runLiquidationExtraction: ${error.stack || error.message}`);
    _alertAdmin('LIQUIDATION_ERROR', `Fallo al procesar correos de liquidación: <code>${_escapeHtml(error.message)}</code>`);
  }

  return summary;
}

/**
 * Cuerpo de la extracción de liquidaciones (debe ejecutarse bajo el lock de script).
 * @private
 * @param {Object} options - Ver `_runLiquidationExtraction`.
 * @param {LiquidationSummary} summary - Resumen que se va completando.
 * @returns {void}
 */
function _liquidationLocked(options, summary) {
  const startMs = Date.now();
  const sheet = _openDapSheet();
  const data = sheet.getDataRange().getValues();

  const ctx = {
    sheet: sheet,
    dryRun: Boolean(options.dryRun),
    byOperation: new Map(),
    knownMessages: new Set(),
    labelProcessed: options.dryRun ? null : _ensureLabel(CONFIG.GMAIL.LABEL_DAP_PROCESSED),
    labelError: options.dryRun ? null : _ensureLabel(CONFIG.GMAIL.LABEL_DAP_ERROR),
    simulatedOperations: options.simulatedOperations || null,
    applied: [],
    orphanOperations: [],
    notionFailures: []
  };

  for (let i = 1; i < data.length; i++) {
    const operationId = _normalizeOperationId(data[i][DAP_COLS.ID_Operacion - 1]);
    if (!isNaN(operationId) && !ctx.byOperation.has(operationId)) ctx.byOperation.set(operationId, { rowIndex: i + 1, row: data[i] });

    const messageId = String(data[i][DAP_COLS.ID_Mensaje_Liquidacion - 1] || '');
    if (messageId) ctx.knownMessages.add(messageId);
  }

  const threads = GmailApp.search(options.query, 0, options.maxThreads);
  summary.threads = threads.length;

  if (threads.length === 0) {
    console.info('ℹ️ Liquidaciones: No hay correos de liquidación pendientes.');
    return;
  }
  console.info(`🔄 Liquidaciones: procesando ${threads.length} hilo(s) de correo.`);

  threads.forEach((thread, index) => {
    if (!_hasTimeLeft(startMs, options.maxRuntimeMs)) {
      summary.truncated = true;
      return;
    }

    try {
      _processLiquidationThread(thread, ctx, summary);
    } catch (error) {
      summary.errors++;
      console.error(`❌ Error procesando el hilo de liquidación ${thread.getId()}: ${error.stack || error.message}`);
      _alertAdmin(`LIQ_THREAD_${thread.getId()}`, `Error procesando un correo de liquidación: <code>${_escapeHtml(error.message)}</code>`);
    }

    if (options.flushEveryThreads && (index + 1) % options.flushEveryThreads === 0) {
      SpreadsheetApp.flush();
      console.info(`💾 Progreso guardado (${index + 1}/${threads.length} hilos de liquidación).`);
    }
  });

  SpreadsheetApp.flush();
  _reportLiquidations(ctx, options);
}

/**
 * Procesa un hilo: aplica cada mensaje nuevo y etiqueta el hilo según el resultado (procesado /
 * error / sin etiqueta para reintentar).
 * @private
 * @param {GoogleAppsScript.Gmail.GmailThread} thread - Hilo de Gmail.
 * @param {Object} ctx - Contexto de la corrida (ver `_liquidationLocked`).
 * @param {LiquidationSummary} summary - Resumen que se va completando.
 * @returns {void}
 */
function _processLiquidationThread(thread, ctx, summary) {
  const errors = [];
  const orphans = [];
  let retryLater = false;
  let resolved = 0;

  thread.getMessages().forEach((msg) => {
    const messageId = msg.getId();
    if (ctx.knownMessages.has(messageId)) return; // ya registrado en una corrida anterior

    if (!_isAllowedLiquidationSender(msg.getFrom())) {
      errors.push({ code: 'REMITENTE_NO_PERMITIDO', message: `Remitente no permitido: ${msg.getFrom()}` });
      return;
    }

    const parsed = parseBciLiquidationEmailDetailed(msg);
    if (!parsed.ok) {
      errors.push(parsed.error);
      return;
    }

    const outcome = _applyLiquidation(parsed.dto, messageId, ctx);
    if (outcome.status === 'APPLIED') { summary.applied++; resolved++; }
    else if (outcome.status === 'DUPLICATE') { summary.duplicates++; resolved++; }
    else if (outcome.status === 'ORPHAN') { summary.orphans++; orphans.push(parsed.dto.ID_Operacion); }
    else if (outcome.status === 'RETRY') retryLater = true;
    else errors.push(outcome.error);
  });

  if (retryLater) {
    summary.retryLater++;
    return;
  }

  if (errors.length > 0 || orphans.length > 0) {
    summary.labeledError++;
    if (!ctx.dryRun) thread.addLabel(ctx.labelError);

    if (errors.length > 0) {
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join('\n');
      console.error(`❌ Correo de liquidación no procesable (hilo ${thread.getId()}):\n${detail}`);
      if (!ctx.dryRun) {
        _alertAdmin(`LIQ_PARSE_${thread.getId()}`,
          `No pude procesar un correo de liquidación de DAP.\n<b>Asunto:</b> ${_escapeHtml(thread.getFirstMessageSubject())}\n` +
          `<b>Motivos:</b>\n${_escapeHtml(detail)}\n` +
          `Quedó con la etiqueta <code>${_escapeHtml(CONFIG.GMAIL.LABEL_DAP_ERROR)}</code> para revisión manual.`);
      }
    }
    return;
  }

  if (resolved > 0 && !ctx.dryRun) thread.addLabel(ctx.labelProcessed);
}

/**
 * Registra una liquidación en el DAP que corresponde a su N° de depósito. Orden: validar → calcular
 * montos → Notion (solo DAP ya COMPLETADOS) → Sheet.
 * @private
 * @param {LiquidationDTO} dto - Liquidación interpretada del correo.
 * @param {string} messageId - ID del mensaje de Gmail.
 * @param {Object} ctx - Contexto de la corrida (ver `_liquidationLocked`).
 * @returns {{status: 'APPLIED'|'DUPLICATE'|'ORPHAN'|'RETRY'|'ERROR', error?: {code: string, message: string}}} Resultado.
 */
function _applyLiquidation(dto, messageId, ctx) {
  const operationId = _normalizeOperationId(dto.ID_Operacion);
  const entry = ctx.byOperation.get(operationId);
  if (!entry) {
    ctx.orphanOperations.push(dto.ID_Operacion);
    console.warn(`⚠️ Liquidación: el depósito ${dto.ID_Operacion} no existe en el Sheet.`);
    return { status: 'ORPHAN' };
  }

  const sheet = ctx.sheet;
  const rowIndex = entry.rowIndex;
  const row = entry.row;
  const idInterno = row[DAP_COLS.ID_Interno - 1];
  const rowCurrency = row[DAP_COLS.Moneda - 1] || 'CLP';
  const fail = (code, message) => ({ status: 'ERROR', error: { code: code, message: `DAP [${idInterno}] (operación ${operationId}): ${message}` } });

  if (row[DAP_COLS.Origen_Monto_Final - 1] === CONFIG.FINAL_SOURCES.LIQUIDACION) {
    const stored = _numberOrNull(row[DAP_COLS.Monto_Final_Original - 1]);
    if (stored !== null && Math.abs(stored - dto.Monto_Final_Original) > 0.00005) {
      console.warn(`⚠️ Liquidación repetida del DAP [${idInterno}] con un monto distinto (guardado ${stored}, correo ${dto.Monto_Final_Original}); se conserva el guardado.`);
    }
    ctx.knownMessages.add(messageId);
    return { status: 'DUPLICATE' };
  }

  if (dto.Moneda === 'UF' && rowCurrency !== 'UF') {
    return fail('MONEDA_INCOHERENTE', 'el correo informa el monto en UF pero el DAP registrado está en pesos.');
  }
  const inicio = _toIsoDate(row[DAP_COLS.Fecha_Inicio - 1]);
  if ((inicio && dto.Fecha_Liquidacion < inicio) || dto.Fecha_Liquidacion > _todayIso()) {
    return fail('FECHA_INCOHERENTE', `la fecha de liquidación (${dto.Fecha_Liquidacion}) es anterior a la captación (${inicio}) o está en el futuro.`);
  }
  const rowType = row[DAP_COLS.Tipo_DAP - 1];
  if (dto.Tipo_DAP && rowType && dto.Tipo_DAP !== rowType) {
    console.warn(`⚠️ Liquidación: el correo dice ${dto.Tipo_DAP} pero el DAP [${idInterno}] está registrado como ${rowType}.`);
  }

  const amounts = _resolveFinalAmounts(rowCurrency, dto.Moneda, dto.Monto_Final_Original, dto.Fecha_Liquidacion, false);
  if (!amounts) {
    console.warn(`⚠️ Liquidación: sin valor de la UF del ${dto.Fecha_Liquidacion}; el DAP [${idInterno}] se reintentará.`);
    return { status: 'RETRY' };
  }

  const estado = row[DAP_COLS.Estado_Cola - 1];
  const detail = {
    id: idInterno,
    objetivo: row[DAP_COLS.Objetivo - 1] || 'Sin Objetivo',
    monto: _numberOrNull(row[DAP_COLS.Monto - 1]),
    montoFinal: amounts.clp,
    moneda: rowCurrency,
    montoFinalOriginal: amounts.original,
    fecha: dto.Fecha_Liquidacion,
    completado: estado === CONFIG.STATES.COMPLETADO
  };

  if (ctx.dryRun) {
    console.info(`🧪 [SIMULACIÓN] DAP [${idInterno}] operación ${operationId}: liquidado el ${dto.Fecha_Liquidacion}, monto final $${amounts.clp} (${rowCurrency === 'UF' ? `UF ${amounts.original}` : 'CLP'}).`);
    // Solo en memoria (nada se escribe): así un segundo correo del mismo depósito se ve como repetido
    row[DAP_COLS.Origen_Monto_Final - 1] = CONFIG.FINAL_SOURCES.LIQUIDACION;
    row[DAP_COLS.Monto_Final_Original - 1] = amounts.original;
    if (ctx.simulatedOperations) ctx.simulatedOperations.add(operationId);
    ctx.applied.push(detail);
    return { status: 'APPLIED' };
  }

  let pageId = row[DAP_COLS.Notion_Page_ID - 1];
  if (estado === CONFIG.STATES.COMPLETADO) {
    const notionOk = _syncLiquidationToNotion(row, pageId, dto.Fecha_Liquidacion, amounts.clp, (id) => { pageId = id; });
    if (!notionOk) {
      ctx.notionFailures.push(idInterno);
      return { status: 'RETRY' };
    }
    if (!row[DAP_COLS.Notion_Page_ID - 1] && pageId) {
      sheet.getRange(rowIndex, DAP_COLS.Notion_Page_ID).setValue(pageId);
      row[DAP_COLS.Notion_Page_ID - 1] = pageId;
    }
  }
  // Un DAP que sigue en la cola de Telegram conserva su estado: solo se guardan sus datos de liquidación.
  // Su página de Notion se creará ya liquidada cuando termine la conversación (finalizeDap).

  sheet.getRange(rowIndex, DAP_COLS.Liquidado).setValue(true);
  sheet.getRange(rowIndex, DAP_COLS.Fecha_Liquidacion).setValue(dto.Fecha_Liquidacion);
  _storeFinalColumns(sheet, rowIndex, row, _finalColumnValues(amounts, CONFIG.FINAL_SOURCES.LIQUIDACION, messageId));
  row[DAP_COLS.Liquidado - 1] = true;
  row[DAP_COLS.Fecha_Liquidacion - 1] = dto.Fecha_Liquidacion;

  ctx.knownMessages.add(messageId);
  ctx.applied.push(detail);
  console.info(`✅ Liquidación registrada: DAP [${idInterno}] operación ${operationId} | ${dto.Fecha_Liquidacion} | monto final $${amounts.clp}`);
  return { status: 'APPLIED' };
}

/**
 * Refleja una liquidación en Notion: si el DAP no tiene página la crea/complementa (upsert por N° de
 * operación) y luego escribe la fecha real y el monto final sobre ella.
 * @private
 * @param {Array} row - Fila del DAP en el Sheet.
 * @param {string} pageId - ID de la página ya enlazada (puede estar vacío).
 * @param {string} fechaLiquidacion - Fecha real de liquidación (ISO).
 * @param {number} montoFinal - Monto final en CLP.
 * @param {function(string): void} onPageId - Recibe el ID de página si hubo que resolverlo.
 * @returns {boolean} true si Notion quedó actualizado; false si falló (no se debe marcar el Sheet).
 */
function _syncLiquidationToNotion(row, pageId, fechaLiquidacion, montoFinal, onPageId) {
  try {
    let id = pageId;
    if (!id) {
      const dto = Object.assign(_buildDapDtoFromRow(row), { Liquidado: true, Fecha_Liquidacion: fechaLiquidacion, Monto_Final: montoFinal });
      id = pushDapToNotion(dto);
      if (id) onPageId(id);
    }
    return Boolean(id) && applyLiquidationToNotion(id, { Fecha_Liquidacion: fechaLiquidacion, Monto_Final: montoFinal });
  } catch (error) {
    console.error(`❌ Liquidación: excepción al actualizar Notion: ${error.message}`);
    return false;
  }
}

/**
 * Da a conocer el resultado de la corrida: alerta agrupada de depósitos sin registro y de fallos de
 * Notion, y aviso por Telegram de las liquidaciones registradas. En simulación solo escribe el log.
 * @private
 * @param {Object} ctx - Contexto de la corrida.
 * @param {Object} options - Opciones de la corrida (`notify`, `dryRun`).
 * @returns {void}
 */
function _reportLiquidations(ctx, options) {
  if (ctx.dryRun) {
    if (ctx.orphanOperations.length) console.warn(`🧪 [SIMULACIÓN] Depósitos sin DAP registrado: ${ctx.orphanOperations.join(', ')}`);
    return;
  }

  if (ctx.orphanOperations.length > 0) {
    _alertAdmin('LIQ_ORPHAN',
      `Llegó(aron) correo(s) de liquidación de depósito(s) que no están registrados como DAP: <code>${_escapeHtml(ctx.orphanOperations.join(', '))}</code>.\n` +
      `Quedaron con la etiqueta <code>${_escapeHtml(CONFIG.GMAIL.LABEL_DAP_ERROR)}</code>. Si el DAP existe, agrégalo (correo de toma) y quita la etiqueta para reprocesarlo.`);
  }
  if (ctx.notionFailures.length > 0) {
    _alertAdmin('LIQ_NOTION',
      `No pude actualizar Notion para la liquidación de los DAP ${_escapeHtml(ctx.notionFailures.join(', '))}; no se marcaron y se reintentará cada 30 min.\n` +
      `Si persiste, revisa que la página del DAP exista (no esté archivada) y que la propiedad <code>${_escapeHtml(CONFIG.NOTION.PROPS.MONTO_FINAL)}</code> (Número) esté creada en la base de datos.`);
  }

  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (options.notify && chatId && ctx.applied.length > 0) {
    sendTelegramMessage(chatId, _buildLiquidationReport(ctx.applied));
  }
}

/**
 * Arma el mensaje de Telegram con las liquidaciones registradas.
 * @private
 * @param {AppliedLiquidation[]} applied - Liquidaciones registradas.
 * @returns {string} Mensaje HTML de Telegram.
 */
function _buildLiquidationReport(applied) {
  const money = (value) => `$${new Intl.NumberFormat('es-CL').format(value)}`;
  let msg = `💰 <b>Liquidaciones de DAP detectadas</b>\n\n`;

  applied.forEach((d) => {
    msg += `🔹 [${_escapeHtml(d.id)}] <b>${_escapeHtml(d.objetivo)}</b>\n`;
    msg += `   Liquidado el ${_formatDateLong(d.fecha)}\n`;
    msg += `   Monto final: <b>${money(d.montoFinal)}</b>`;
    if (d.moneda === 'UF') msg += ` (UF ${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 4 }).format(d.montoFinalOriginal)})`;
    if (d.monto) {
      const gain = d.montoFinal - d.monto;
      msg += `\n   Invertido ${money(d.monto)} → ${gain >= 0 ? 'ganancia' : 'diferencia'} ${gain >= 0 ? '' : '-'}${money(Math.abs(gain))}`;
    }
    if (!d.completado) msg += `\n   ℹ️ <i>Aún no completaste este DAP en Telegram; los datos quedaron guardados.</i>`;
    msg += `\n\n`;
  });

  return msg.trim();
}
