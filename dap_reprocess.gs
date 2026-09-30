/**
 * @fileoverview dap_reprocess.gs - Herramienta manual para reprocesar TODOS los DAP y dejar
 * registrado su monto final (base del análisis de ganancias). Se ejecuta a mano, normalmente una
 * sola vez tras desplegar la versión que agregó las columnas de monto final.
 *
 * Dos fuentes, en este orden (la segunda nunca reemplaza a la primera):
 *  1. Correos de liquidación (todos los DAP, fijos y renovables): marca Liquidado, guarda la fecha
 *     real y el monto final REAL (Origen_Monto_Final = LIQUIDACION), en Sheet y Notion.
 *  2. Correo de toma de los DAP FIJOS que aún no tienen monto final: proyecta el "Valor Final" del
 *     correo (Origen_Monto_Final = CAPTACION). Los renovables no se proyectan: su monto final solo
 *     existe en el correo de liquidación.
 *
 * `reprocessFinalAmounts()` SIMULA (solo log); `reprocessFinalAmountsApply()` ESCRIBE. Ambas son
 * idempotentes y tienen presupuesto de tiempo: si el log dice "truncado", vuelve a ejecutarla.
 */

'use strict';

/**
 * Resumen de la fase de proyección desde los correos de toma.
 * @typedef {Object} CaptureProjectionSummary
 * @property {number} reviewed - DAP fijos sin monto final revisados.
 * @property {number} projected - DAP a los que se les (habría) registrado el monto final proyectado.
 * @property {number} noEmail - DAP sin ID de mensaje de correo.
 * @property {number} noFinalValue - Correos sin "Valor Final" confiable.
 * @property {number} errors - Correos que no se pudieron abrir/interpretar o no coinciden con la fila.
 * @property {number} notionFailed - DAP omitidos porque Notion falló (se reintentan al reejecutar).
 * @property {boolean} truncated - true si se agotó el presupuesto de tiempo.
 * @property {boolean} busy - true si no se pudo obtener el lock.
 */

/**
 * SIMULACIÓN del reprocesamiento de montos finales: muestra en el log qué se registraría, sin
 * modificar el Sheet, Notion ni las etiquetas de Gmail.
 * @param {number} [monthsBack=24] - Meses hacia atrás en que se buscan correos de liquidación (entero 1-120).
 * @returns {Object|null} Resumen, o null si el argumento no es válido.
 */
function reprocessFinalAmounts(monthsBack) {
  return _reprocessFinalAmounts(false, monthsBack);
}

/**
 * APLICA el reprocesamiento de montos finales (Sheet, Notion y etiquetas de Gmail) y avisa el
 * resultado por Telegram. Ejecutar antes `reprocessFinalAmounts()` y revisar su log.
 * @param {number} [monthsBack=24] - Meses hacia atrás en que se buscan correos de liquidación (entero 1-120).
 * @returns {Object|null} Resumen, o null si el argumento no es válido.
 */
function reprocessFinalAmountsApply(monthsBack) {
  return _reprocessFinalAmounts(true, monthsBack);
}

/**
 * Fecha límite de una búsqueda de Gmail (`yyyy/MM/dd`) restando meses sin desbordar (31 de marzo
 * menos 1 mes es fin de febrero, no 3 de marzo).
 * @private
 * @param {number} months - Meses hacia atrás.
 * @returns {string} Fecha en formato `yyyy/MM/dd`.
 */
function _gmailDateMonthsAgo(months) {
  const since = new Date();
  const targetDay = since.getDate();
  since.setDate(1);
  since.setMonth(since.getMonth() - months);
  const lastDayOfMonth = new Date(since.getFullYear(), since.getMonth() + 1, 0).getDate();
  since.setDate(Math.min(targetDay, lastDayOfMonth));
  return Utilities.formatDate(since, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

/**
 * Núcleo del reprocesamiento.
 * @private
 * @param {boolean} apply - true para escribir; false para solo simular.
 * @param {number} [monthsBack=24] - Meses hacia atrás para los correos de liquidación.
 * @returns {Object|null} Resumen `{mode, liquidations, captures, pending}`, o null si el argumento no es válido.
 */
function _reprocessFinalAmounts(apply, monthsBack) {
  const months = monthsBack === undefined ? 24 : monthsBack;
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    console.error(`❌ Reprocesar: monthsBack debe ser un entero entre 1 y 120 (recibido: ${months}).`);
    return null;
  }

  const mode = apply ? 'APLICANDO' : 'SIMULACIÓN';
  const startMs = Date.now();
  const sinceStr = _gmailDateMonthsAgo(months);
  console.info(`🕓 Reprocesar [${mode}]: correos de liquidación desde ${sinceStr} (${months} meses) y correos de toma de DAP fijos.`);

  // Fase 1: correos de liquidación (montos reales; tienen prioridad sobre cualquier proyección)
  const simulatedOperations = new Set();
  const liquidations = _runLiquidationExtraction({
    query: _buildDapLiquidationSearchQuery(`after:${sinceStr}`),
    maxThreads: 500,
    flushEveryThreads: 10,
    dryRun: !apply,
    notify: false,
    maxRuntimeMs: CONFIG.LIMITS.RUNTIME_BUDGET_MS,
    simulatedOperations: simulatedOperations
  });
  console.info(`📊 Fase 1 (liquidaciones) [${mode}]: ${JSON.stringify(liquidations)}`);

  // Fase 2: proyección del monto final de los DAP fijos desde el correo de toma
  const captures = _projectFinalAmountsFromCaptureEmails(apply, startMs, simulatedOperations);
  console.info(`📊 Fase 2 (correos de toma) [${mode}]: ${JSON.stringify(captures)}`);

  const pending = _collectPendingFinalAmounts(simulatedOperations);
  console.info(`📋 Sin monto final tras el reprocesamiento${apply ? '' : ' (simulado: se descuenta lo que se registraría)'}: ` +
    `${pending.renewableLiquidatedWithoutAmount.length} renovable(s) liquidado(s) sin correo de liquidación, ` +
    `${pending.fixedWithoutAmount} fijo(s), ${pending.renewableActive} renovable(s) vigente(s).`);
  if (pending.renewableLiquidatedWithoutAmount.length > 0) {
    console.warn(`⚠️ Renovables marcados como liquidados sin monto final (no se encontró su correo de liquidación): ${pending.renewableLiquidatedWithoutAmount.join(', ')}`);
  }

  const truncated = liquidations.truncated || captures.truncated;
  if (truncated) console.warn('⏱️ Reprocesar: se agotó el tiempo; vuelve a ejecutar la misma función para continuar.');

  const summary = { mode: mode, liquidations: liquidations, captures: captures, pending: pending };
  if (apply) _notifyReprocess(summary, truncated);
  return summary;
}

/**
 * Fase 2: para cada DAP FIJO sin monto final, relee su correo de toma y registra el "Valor Final"
 * como proyección (Origen_Monto_Final = CAPTACION). Notion primero (si el DAP ya tiene página),
 * Sheet después: si Notion falla el DAP se omite y se reintenta al reejecutar.
 * @private
 * @param {boolean} apply - true para escribir.
 * @param {number} startMs - Instante de inicio de la ejecución completa (para el presupuesto de tiempo).
 * @param {Set<number>} skipOperations - N° de operación que la fase 1 simulada habría liquidado (en la
 *   ejecución real ya tienen su monto real y se saltan solos); en simulación se omiten para no sobrecontar.
 *   En simulación, esta fase agrega además los que habría proyectado.
 * @returns {CaptureProjectionSummary} Resumen de la fase.
 */
function _projectFinalAmountsFromCaptureEmails(apply, startMs, skipOperations) {
  const summary = { reviewed: 0, projected: 0, noEmail: 0, noFinalValue: 0, errors: 0, notionFailed: 0, truncated: false, busy: false };
  const mode = apply ? 'APLICANDO' : 'SIMULACIÓN';

  try {
    const result = _withScriptLock(() => {
      const sheet = _openDapSheet();
      const data = sheet.getDataRange().getValues();

      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row[DAP_COLS.Tipo_DAP - 1] !== 'FIJO' || row[DAP_COLS.Origen_Monto_Final - 1]) continue;
        if (skipOperations.has(_normalizeOperationId(row[DAP_COLS.ID_Operacion - 1]))) continue;

        const idInterno = row[DAP_COLS.ID_Interno - 1];
        const messageId = row[DAP_COLS.ID_Mensaje_Email - 1];
        if (!messageId) {
          summary.noEmail++;
          continue;
        }
        if (!_hasTimeLeft(startMs)) {
          summary.truncated = true;
          break;
        }
        summary.reviewed++;

        try {
          const parsed = parseBciDapEmailDetailed(GmailApp.getMessageById(String(messageId)));
          if (!parsed.ok) {
            summary.errors++;
            console.warn(`⚠️ [${mode}] DAP [${idInterno}]: el parser actual no pudo releer su correo de toma (${parsed.error.code}).`);
            continue;
          }

          const dto = parsed.dto;
          if (_normalizeOperationId(dto.ID_Operacion) !== _normalizeOperationId(row[DAP_COLS.ID_Operacion - 1]) || dto.Moneda !== (row[DAP_COLS.Moneda - 1] || 'CLP')) {
            summary.errors++;
            console.warn(`⚠️ [${mode}] DAP [${idInterno}]: su correo de toma no coincide con la fila (operación o moneda distintas); se omite.`);
            continue;
          }

          const amounts = _captureFinalAmounts(dto);
          if (!amounts) {
            summary.noFinalValue++;
            continue;
          }

          if (!apply) {
            console.info(`🧪 [SIMULACIÓN] DAP [${idInterno}]: monto final proyectado ${amounts.clp === '' ? `UF ${amounts.original} (pesos pendientes)` : `$${amounts.clp}`}.`);
            if (amounts.clp !== '') skipOperations.add(_normalizeOperationId(row[DAP_COLS.ID_Operacion - 1]));
            summary.projected++;
            continue;
          }

          const pageId = row[DAP_COLS.Notion_Page_ID - 1];
          if (row[DAP_COLS.Estado_Cola - 1] === CONFIG.STATES.COMPLETADO && pageId && amounts.clp !== '' && !fillNotionMontoFinal(pageId, amounts.clp)) {
            summary.notionFailed++;
            continue;
          }

          _storeFinalColumns(sheet, i + 1, row, _finalColumnValues(amounts, CONFIG.FINAL_SOURCES.CAPTACION, ''));
          summary.projected++;
        } catch (error) {
          summary.errors++;
          console.error(`❌ [${mode}] DAP [${idInterno}]: ${error.stack || error.message}`);
        }
      }

      SpreadsheetApp.flush();
    }, 30000);

    if (!result.acquired) {
      summary.busy = true;
      console.warn('⚠️ Reprocesar: no se pudo obtener el Lock para la fase 2. Vuelve a ejecutar en unos segundos.');
    }
  } catch (error) {
    summary.errors++;
    console.error(`❌ Error en la fase 2 del reprocesamiento: ${error.stack || error.message}`);
    _alertAdmin('REPROCESS_ERROR', `Fallo al reprocesar montos finales: <code>${_escapeHtml(error.message)}</code>`);
  }

  return summary;
}

/**
 * Cuenta los DAP que siguen sin monto final y por qué.
 * @private
 * @param {Set<number>} resolvedOperations - N° de operación que una simulación habría dejado con monto final
 *   (se descuentan, porque la simulación no escribe); vacío al aplicar.
 * @returns {{renewableLiquidatedWithoutAmount: Array<number|string>, fixedWithoutAmount: number, renewableActive: number}}
 *   IDs internos de los renovables liquidados sin monto final, y cantidad de fijos sin monto y de renovables vigentes.
 */
function _collectPendingFinalAmounts(resolvedOperations) {
  const pending = { renewableLiquidatedWithoutAmount: [], fixedWithoutAmount: 0, renewableActive: 0 };
  const data = _openDapSheet().getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[DAP_COLS.ID_Operacion - 1] || _numberOrNull(row[DAP_COLS.Monto_Final - 1]) !== null) continue;
    if (resolvedOperations.has(_normalizeOperationId(row[DAP_COLS.ID_Operacion - 1]))) continue;

    const liquidated = _isChecked(row[DAP_COLS.Liquidado - 1]);
    if (row[DAP_COLS.Tipo_DAP - 1] === 'RENOVABLE') {
      if (liquidated) pending.renewableLiquidatedWithoutAmount.push(row[DAP_COLS.ID_Interno - 1]);
      else pending.renewableActive++;
    } else {
      pending.fixedWithoutAmount++;
    }
  }
  return pending;
}

/**
 * Envía por Telegram el resultado de un reprocesamiento aplicado.
 * @private
 * @param {{liquidations: LiquidationSummary, captures: CaptureProjectionSummary, pending: Object}} summary - Resumen.
 * @param {boolean} truncated - true si alguna fase se cortó por tiempo.
 * @returns {void}
 */
function _notifyReprocess(summary, truncated) {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) return;

  const l = summary.liquidations;
  const c = summary.captures;
  const p = summary.pending;
  let msg = `📊 <b>Reprocesamiento de montos finales</b>\n\n`;
  msg += `💰 Liquidaciones registradas: <b>${l.applied}</b> (repetidas: ${l.duplicates}, sin DAP registrado: ${l.orphans}, con error: ${l.labeledError}, por reintentar: ${l.retryLater})\n`;
  msg += `📈 Montos proyectados de DAP fijos: <b>${c.projected}</b> (sin "Valor Final": ${c.noFinalValue}, con error: ${c.errors}, Notion fallido: ${c.notionFailed})\n`;
  msg += `🔄 Renovables vigentes (sin monto final hasta liquidarse): ${p.renewableActive}\n`;
  if (p.renewableLiquidatedWithoutAmount.length > 0) {
    msg += `⚠️ Renovables marcados como liquidados sin correo de liquidación: ${_escapeHtml(p.renewableLiquidatedWithoutAmount.join(', '))}\n`;
  }
  if (truncated) msg += `\n⏱️ <i>Se agotó el tiempo: vuelve a ejecutar reprocessFinalAmountsApply() para continuar.</i>`;
  sendTelegramMessage(chatId, msg);
}
