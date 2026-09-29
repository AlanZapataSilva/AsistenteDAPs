/**
 * @fileoverview utils.gs - Utilidades compartidas de bajo nivel.
 */

'use strict';

/**
 * Ejecuta UrlFetchApp.fetch con reintentos ante fallos transitorios.
 * Reintenta ante excepciones de red o respuestas 5xx (errores del servidor remoto);
 * NO reintenta ante 4xx, ya que indican un error de configuración (token, payload)
 * que no se resuelve reintentando.
 * @param {string} url - URL de destino.
 * @param {Object} options - Opciones para UrlFetchApp.fetch (debe incluir muteHttpExceptions: true).
 * @param {number} [maxRetries=2] - Número máximo de reintentos adicionales al primer intento.
 * @returns {GoogleAppsScript.URL_Fetch.HTTPResponse|null} Respuesta HTTP, o null si todos los intentos fallan.
 */
function _fetchWithRetry(url, options, maxRetries) {
  const retries = typeof maxRetries === 'number' ? maxRetries : 2;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();

      if (code < 500) {
        return response;
      }

      lastError = `HTTP ${code}`;
    } catch (error) {
      lastError = error.message;
    }

    if (attempt < retries) {
      console.warn(`⚠️ _fetchWithRetry: Intento ${attempt + 1} falló (${lastError}). Reintentando...`);
      Utilities.sleep(500 * (attempt + 1));
    }
  }

  console.error(`❌ _fetchWithRetry: Todos los intentos fallaron para ${_redactUrl(url)}. Último error: ${lastError}`);
  return null;
}

/**
 * Oculta secretos de una URL antes de loguearla: quita el query string (ej. `apikey=`) y el
 * token del bot de Telegram que viaja en el path (`/bot<token>/`).
 * @private
 * @param {string} url - URL original.
 * @returns {string} URL segura para logs.
 */
function _redactUrl(url) {
  return String(url).split('?')[0].replace(/\/bot[^/]+\//, '/bot***/');
}

/**
 * Indica si un valor es un objeto Date. Se usa toString en vez de `instanceof Date` porque
 * los valores que devuelve Sheets (`getValues`) vienen de otro contexto de ejecución y
 * `instanceof Date` da false aunque sean fechas.
 * @private
 * @param {*} value - Valor a evaluar.
 * @returns {boolean}
 */
function _isDateObject(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/**
 * Normaliza un valor de fecha (Date de Sheets o texto) a `yyyy-MM-dd`, sin desfases de zona
 * horaria (un texto `yyyy-MM-dd` se devuelve tal cual, en vez de pasar por `new Date()`,
 * que lo interpretaría en UTC y podría correr el día).
 * @private
 * @param {Date|string|null} value - Fecha de Sheets o texto.
 * @returns {string} Fecha ISO, o cadena vacía si el valor está vacío.
 */
function _toIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (_isDateObject(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? text : Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Formatea una fecha ISO como texto legible en español: `Jueves 02/Abril/2026`.
 * @private
 * @param {Date|string} value - Fecha (ISO o Date de Sheets).
 * @returns {string} Fecha legible, o el valor original si no se puede interpretar.
 */
function _formatDateLong(value) {
  const iso = _toIsoDate(value);
  const parts = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return iso;

  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const year = parseInt(parts[1], 10);
  const month = parseInt(parts[2], 10);
  const day = parseInt(parts[3], 10);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return `${days[weekday]} ${parts[3]}/${months[month - 1]}/${year}`;
}

/**
 * Convierte un número en formato chileno (`1.234,5678`: punto de miles, coma decimal) a Number.
 * @private
 * @param {string} text - Texto numérico.
 * @returns {number} Valor numérico, o NaN si no se puede interpretar.
 */
function _parseChileanNumber(text) {
  return parseFloat(String(text).replace(/\./g, '').replace(',', '.'));
}

/**
 * Convierte un número con separadores de miles/decimales en formato desconocido a Number.
 * Reglas: si trae "." y ",", el último de los dos es el decimal; si trae un solo tipo de
 * separador, es decimal cuando aparece una sola vez y NO va seguido de exactamente 3 dígitos
 * ("4,4379" / "12.5" son decimales; "1,525" / "1.525.000" son miles).
 * Se usa para montos en UF, cuyo formato varía entre plantillas de correo del banco.
 * @private
 * @param {string} text - Texto numérico.
 * @returns {number} Valor numérico, o NaN si no se puede interpretar.
 */
function _parseFlexibleNumber(text) {
  const t = String(text).trim();
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  let decimalIndex = -1;

  if (lastDot >= 0 && lastComma >= 0) {
    decimalIndex = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const index = Math.max(lastDot, lastComma);
    const separator = t.charAt(index);
    const occurrences = t.split(separator).length - 1;
    const digitsAfter = t.length - index - 1;
    if (occurrences === 1 && digitsAfter !== 3) decimalIndex = index;
  }

  if (decimalIndex < 0) return parseFloat(t.replace(/[.,]/g, ''));
  const integerPart = t.slice(0, decimalIndex).replace(/[.,]/g, '');
  return parseFloat(`${integerPart}.${t.slice(decimalIndex + 1)}`);
}

/**
 * @private
 * @returns {string} Fecha de hoy (yyyy-MM-dd) en la zona horaria del script.
 */
function _todayIso() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
