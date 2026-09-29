/**
 * @fileoverview renewal.gs - Ventanas de renovación de los DAP renovables.
 *
 * Un DAP renovable se renueva cada `plazo` días (ej. 30). Se puede liquidar en la fecha de
 * renovación y en los días hábiles siguientes; aquí una "ventana" es
 * [inicio, inicio + 2 días hábiles] (se deja 1 día de margen respecto a los 3 posibles).
 *   - Fecha1 = "Fecha de Vencimiento" del correo = primera fecha de renovación.
 *   - plazo  = Fecha de Vencimiento − Fecha de Captación (en días).
 *   - ventana k: inicio_k = Fecha1 + k·plazo días; fin_k = inicio_k + 2 días hábiles.
 * Días hábiles = lunes a viernes, menos las fechas ISO de `CONFIG.HOLIDAYS` (opcional).
 * Todas las fechas se manejan como texto ISO `yyyy-MM-dd` (comparables como texto).
 */

'use strict';

const RENEWAL_WINDOW_BUSINESS_DAYS = 2;
const MS_PER_DAY = 86400000;

/**
 * @private
 * @param {string} iso - Fecha ISO yyyy-MM-dd.
 * @returns {number} Milisegundos UTC de esa fecha a medianoche.
 */
function _isoToUtcMs(iso) {
  const parts = String(iso).split('-');
  return Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

/**
 * @private
 * @param {number} ms - Milisegundos UTC.
 * @returns {string} Fecha ISO yyyy-MM-dd.
 */
function _utcMsToIso(ms) {
  const d = new Date(ms);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/**
 * @private
 * @param {string} iso - Fecha ISO.
 * @param {number} days - Días a sumar (puede ser negativo).
 * @returns {string} Fecha ISO resultante.
 */
function _addDaysIso(iso, days) {
  return _utcMsToIso(_isoToUtcMs(iso) + days * MS_PER_DAY);
}

/**
 * @private
 * @returns {number} Días de calendario entre dos fechas ISO (b − a).
 */
function _daysBetween(isoA, isoB) {
  return Math.round((_isoToUtcMs(isoB) - _isoToUtcMs(isoA)) / MS_PER_DAY);
}

/**
 * @private
 * @param {string} iso - Fecha ISO.
 * @returns {boolean} true si es lunes a viernes y no está en `CONFIG.HOLIDAYS`.
 */
function _isBusinessDay(iso) {
  const weekday = new Date(_isoToUtcMs(iso)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const holidays = (typeof CONFIG !== 'undefined' && CONFIG.HOLIDAYS) || [];
  return holidays.indexOf(iso) === -1;
}

/**
 * @private
 * @param {string} iso - Fecha ISO de partida.
 * @param {number} count - Cantidad de días hábiles a avanzar.
 * @returns {string} Fecha ISO tras avanzar `count` días hábiles.
 */
function _addBusinessDays(iso, count) {
  let current = iso;
  let added = 0;
  while (added < count) {
    current = _addDaysIso(current, 1);
    if (_isBusinessDay(current)) added++;
  }
  return current;
}

/**
 * Ventana de renovación número k (k = 0 es la de Fecha1).
 * @private
 * @param {string} fecha1 - Primera fecha de renovación (ISO).
 * @param {number} plazo - Días entre renovaciones.
 * @param {number} k - Índice de la ventana (>= 0).
 * @returns {{k: number, start: string, end: string}}
 */
function _renewalWindow(fecha1, plazo, k) {
  const start = _addDaysIso(fecha1, k * plazo);
  return { k: k, start: start, end: _addBusinessDays(start, RENEWAL_WINDOW_BUSINESS_DAYS) };
}

/**
 * Primera ventana cuyo fin es hoy o posterior (la "próxima ventana de renovación").
 * @private
 * @param {string} fecha1 - Primera fecha de renovación (ISO).
 * @param {number} plazo - Días entre renovaciones.
 * @param {string} todayIso - Fecha de hoy (ISO).
 * @returns {{k: number, start: string, end: string}}
 */
function _nextRenewalWindow(fecha1, plazo, todayIso) {
  let k = 0;
  if (todayIso > fecha1) k = Math.max(0, Math.floor(_daysBetween(fecha1, todayIso) / plazo) - 1);
  let window = _renewalWindow(fecha1, plazo, k);
  while (window.end < todayIso) {
    k++;
    window = _renewalWindow(fecha1, plazo, k);
  }
  return window;
}

/**
 * Verifica si una fecha cae dentro de alguna ventana de renovación. Si no, propone la fecha más
 * cercana (inicio o fin de una ventana vecina; en empate, la anterior).
 * @private
 * @param {string} dateIso - Fecha ingresada (ISO).
 * @param {string} fecha1 - Primera fecha de renovación (ISO).
 * @param {number} plazo - Días entre renovaciones.
 * @returns {{valid: boolean, window: {k: number, start: string, end: string}, suggested?: string}}
 *   `window` es la ventana que contiene la fecha (si es válida) o la de la sugerencia.
 */
function _validateRenewalDate(dateIso, fecha1, plazo) {
  const baseK = Math.max(0, Math.floor(_daysBetween(fecha1, dateIso) / plazo));
  let best = null;

  for (let k = Math.max(0, baseK - 1); k <= baseK + 1; k++) {
    const window = _renewalWindow(fecha1, plazo, k);
    if (dateIso >= window.start && dateIso <= window.end) {
      return { valid: true, window: window };
    }
    [window.start, window.end].forEach((edge) => {
      const distance = Math.abs(_daysBetween(edge, dateIso));
      if (!best || distance < best.distance || (distance === best.distance && edge < best.date)) {
        best = { date: edge, distance: distance, window: window };
      }
    });
  }

  return { valid: false, window: best.window, suggested: best.date };
}

/**
 * Interpreta una fecha escrita por el usuario: `yyyy-MM-dd`, `dd-MM-yyyy` o `dd/MM/yyyy`.
 * @private
 * @param {string} text - Texto ingresado.
 * @returns {string|null} Fecha ISO, o null si el formato o la fecha no son válidos.
 */
function _parseUserDate(text) {
  const value = String(text).trim();
  let year;
  let month;
  let day;

  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    year = parseInt(match[1], 10); month = parseInt(match[2], 10); day = parseInt(match[3], 10);
  } else {
    match = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!match) return null;
    day = parseInt(match[1], 10); month = parseInt(match[2], 10); year = parseInt(match[3], 10);
  }

  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return _utcMsToIso(d.getTime());
}

/**
 * Datos de renovación de una fila de la hoja DAPs.
 * @private
 * @param {Array} row - Fila de la hoja (valores de getValues).
 * @returns {{fecha1: string, plazo: number}|null} null si las fechas no permiten calcular un plazo válido.
 */
function _getRenewalInfo(row) {
  const inicio = _toIsoDate(row[DAP_COLS.Fecha_Inicio - 1]);
  const vencimiento = _toIsoDate(row[DAP_COLS.Fecha_Vencimiento - 1]);
  if (!inicio || !vencimiento) return null;

  const plazo = _daysBetween(inicio, vencimiento);
  return plazo > 0 ? { fecha1: vencimiento, plazo: plazo } : null;
}

/**
 * Texto legible de una ventana: `Lunes 06/Julio/2026 al Miércoles 08/Julio/2026`.
 * @private
 * @param {{start: string, end: string}} window - Ventana de renovación.
 * @returns {string}
 */
function _formatRenewalWindow(window) {
  return `${_formatDateLong(window.start)} al ${_formatDateLong(window.end)}`;
}
