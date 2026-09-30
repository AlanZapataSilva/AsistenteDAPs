/**
 * @fileoverview utils.gs - Utilidades compartidas de bajo nivel: red, texto, fechas, locks,
 * alertas y acceso validado a la hoja de DAPs.
 */

'use strict';

// ---------------------------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------------------------

/**
 * Milisegundos a esperar antes de reintentar una respuesta 429 (Too Many Requests). Lee la
 * cabecera `Retry-After` (Notion, en segundos) o `parameters.retry_after` del cuerpo (Telegram).
 * @private
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response - Respuesta 429.
 * @param {number} fallbackMs - Espera por defecto si la respuesta no indica ninguna.
 * @returns {number} Milisegundos de espera, con tope de 10 s.
 */
function _retryAfterMs(response, fallbackMs) {
  let seconds = NaN;
  try {
    const headers = (response.getHeaders && response.getHeaders()) || {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'retry-after');
    if (key) seconds = parseFloat(headers[key]);
    if (!(seconds > 0)) {
      const body = JSON.parse(response.getContentText());
      seconds = parseFloat(body && body.parameters && body.parameters.retry_after);
    }
  } catch (error) {
    seconds = NaN;
  }
  const ms = seconds > 0 ? seconds * 1000 : fallbackMs;
  return Math.min(ms, 10000);
}

/**
 * Ejecuta UrlFetchApp.fetch con reintentos ante fallos transitorios.
 * Reintenta ante excepciones de red, respuestas 5xx y 429 (respetando `Retry-After`);
 * NO reintenta ante otros 4xx, ya que indican un error de configuración (token, payload)
 * que no se resuelve reintentando.
 * @param {string} url - URL de destino.
 * @param {GoogleAppsScript.URL_Fetch.URLFetchRequestOptions} options - Opciones para UrlFetchApp.fetch (debe incluir muteHttpExceptions: true).
 * @param {number} [maxRetries=2] - Número máximo de reintentos adicionales al primer intento.
 * @returns {GoogleAppsScript.URL_Fetch.HTTPResponse|null} Respuesta HTTP, o null si todos los intentos fallan.
 */
function _fetchWithRetry(url, options, maxRetries) {
  const retries = typeof maxRetries === 'number' ? maxRetries : 2;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let waitMs = 500 * (attempt + 1);

    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();

      if (code === 429) {
        lastError = 'HTTP 429';
        waitMs = _retryAfterMs(response, waitMs);
      } else if (code < 500) {
        return response;
      } else {
        lastError = `HTTP ${code}`;
      }
    } catch (error) {
      lastError = error.message;
    }

    if (attempt < retries) {
      console.warn(`⚠️ _fetchWithRetry: Intento ${attempt + 1} falló (${lastError}). Reintentando en ${waitMs} ms...`);
      Utilities.sleep(waitMs);
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

// ---------------------------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------------------------

/**
 * Escapa el texto del usuario para insertarlo en un mensaje HTML de Telegram
 * (solo `&`, `<` y `>` deben escaparse).
 * @param {*} text - Texto a escapar.
 * @returns {string} Texto seguro.
 */
function _escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Recorta un texto a un máximo de caracteres.
 * @param {*} text - Texto original.
 * @param {number} max - Largo máximo.
 * @returns {string} Texto recortado.
 */
function _truncate(text, max) {
  const value = String(text === null || text === undefined ? '' : text);
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Divide un mensaje largo en partes de como máximo `max` caracteres, cortando en saltos de
 * línea cuando es posible (los mensajes de este proyecto abren y cierran sus etiquetas HTML
 * dentro de una misma línea).
 * @param {string} text - Mensaje completo.
 * @param {number} max - Largo máximo por parte (Telegram: 4096).
 * @returns {string[]} Partes no vacías.
 */
function _splitMessage(text, max) {
  const chunks = [];
  let current = '';

  String(text).split('\n').forEach((line) => {
    let rest = line;
    while (rest.length > max) {
      if (current) { chunks.push(current); current = ''; }
      chunks.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > max) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  });

  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Concurrencia
// ---------------------------------------------------------------------------------------------

// Indica si esta ejecución ya tiene el lock. La documentación de Apps Script no define qué ocurre
// al adquirir dos veces el lock de script dentro de una misma ejecución, así que nunca se anida.
let _scriptLockHeld = false;

/**
 * Ejecuta `fn` con el lock de script, sin anidar: si esta ejecución ya lo tiene, ejecuta `fn`
 * directamente. Libera el lock siempre.
 * @param {function(): *} fn - Trabajo a proteger.
 * @param {number} [timeoutMs=10000] - Espera máxima para obtener el lock.
 * @returns {{acquired: boolean, value: *}} `acquired=false` si no se pudo obtener el lock (fn no se ejecutó).
 */
function _withScriptLock(fn, timeoutMs) {
  if (_scriptLockHeld) return { acquired: true, value: fn() };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(typeof timeoutMs === 'number' ? timeoutMs : 10000)) {
    return { acquired: false, value: undefined };
  }

  _scriptLockHeld = true;
  try {
    return { acquired: true, value: fn() };
  } finally {
    _scriptLockHeld = false;
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------------------------
// Observabilidad
// ---------------------------------------------------------------------------------------------

/**
 * Registra un evento estructurado (JSON) para poder filtrarlo en los registros de ejecución.
 * @param {'info'|'warn'|'error'} level - Nivel de log.
 * @param {string} event - Nombre corto del evento (ej. 'notion_sync_failed').
 * @param {Object} [data] - Datos adicionales (sin secretos).
 * @returns {void}
 */
function _log(level, event, data) {
  const fn = console[level] || console.info;
  fn.call(console, JSON.stringify(Object.assign({ event: event }, data || {})));
}

/**
 * Envía una alerta al administrador por Telegram, con throttle por clave para no repetir la
 * misma alerta. Nunca lanza excepciones (una alerta no debe romper el flujo que la origina).
 * @param {string} key - Clave de la alerta (misma clave = misma alerta lógica).
 * @param {string} message - Texto de la alerta (HTML de Telegram; escapa los datos externos).
 * @returns {boolean} true si la alerta se envió; false si se omitió por throttle o falló.
 */
function _alertAdmin(key, message) {
  try {
    const chatId = getEnv('TELEGRAM_CHAT_ID');
    if (!chatId) return false;

    const cache = CacheService.getScriptCache();
    const cacheKey = `ALERT_${key}`.slice(0, 250);
    if (cache.get(cacheKey)) return false;
    cache.put(cacheKey, '1', Math.min(CONFIG.ALERTS.THROTTLE_SECONDS, 21600));

    return sendTelegramMessage(chatId, `🚨 <b>Alerta AsistenteDAPs</b>\n${message}`);
  } catch (error) {
    console.error(`❌ _alertAdmin falló: ${error.message}`);
    return false;
  }
}

/**
 * @private
 * @param {number} startMs - Instante de inicio (Date.now()).
 * @param {number} [budgetMs] - Presupuesto en ms (por defecto CONFIG.LIMITS.RUNTIME_BUDGET_MS).
 * @returns {boolean} true si todavía queda tiempo dentro del presupuesto.
 */
function _hasTimeLeft(startMs, budgetMs) {
  return Date.now() - startMs < (typeof budgetMs === 'number' ? budgetMs : CONFIG.LIMITS.RUNTIME_BUDGET_MS);
}

// ---------------------------------------------------------------------------------------------
// Fechas y números
// ---------------------------------------------------------------------------------------------

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
 * horaria. Acepta Date, `yyyy-MM-dd[...]` y `dd-MM-yyyy` / `dd/MM/yyyy` (convención chilena).
 * Cualquier otro texto se considera no interpretable (no se adivina el orden día/mes).
 * @private
 * @param {Date|string|null} value - Fecha de Sheets o texto.
 * @returns {string} Fecha ISO, o cadena vacía si el valor está vacío o no es interpretable.
 */
function _toIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (_isDateObject(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const latin = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (latin) return `${latin[3]}-${latin[2].padStart(2, '0')}-${latin[1].padStart(2, '0')}`;

  return '';
}

/**
 * Interpreta el valor de una celda tipo casilla/booleano (true, "TRUE", "true").
 * @private
 * @param {*} value - Valor de la celda.
 * @returns {boolean} true si la celda está marcada.
 */
function _isChecked(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

/**
 * Convierte un valor de celda de fecha/hora (Date de Sheets o texto ISO) a milisegundos epoch.
 * @private
 * @param {Date|string|null} value - Valor de la celda.
 * @returns {number} Milisegundos, o 0 si está vacío o no es interpretable.
 */
function _toEpochMs(value) {
  if (!value) return 0;
  if (_isDateObject(value)) return value.getTime();
  const parsed = Date.parse(String(value));
  return isNaN(parsed) ? 0 : parsed;
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

/**
 * Normaliza un número de operación/depósito a Number (los ceros a la izquierda no son
 * significativos y Sheets/Notion los tratan como número).
 * @private
 * @param {string|number} value - Número de operación en cualquier formato.
 * @returns {number} Número de operación, o NaN si no contiene dígitos.
 */
function _normalizeOperationId(value) {
  const digits = String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
  return digits === '' ? NaN : Number(digits);
}

// ---------------------------------------------------------------------------------------------
// Hoja de DAPs
// ---------------------------------------------------------------------------------------------

/**
 * Valida que el encabezado real de la hoja coincida con `CONFIG.HEADERS.DAPS` (mismo orden).
 * Si solo faltan columnas nuevas al final, las agrega (migración idempotente). Si una columna
 * fue renombrada, movida o borrada, lanza un error: seguir escribiendo por posición corrompería
 * los datos.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @returns {void}
 * @throws {Error} Si el encabezado no coincide con el esquema esperado.
 */
function _assertSchema(sheet) {
  const expected = CONFIG.HEADERS.DAPS;
  const width = Math.max(sheet.getLastColumn(), 1);
  const actual = sheet.getRange(1, 1, 1, width).getValues()[0];
  let missing = false;

  for (let i = 0; i < expected.length; i++) {
    const found = actual[i];
    if (found === expected[i]) continue;
    if (found === undefined || found === '') { missing = true; continue; }
    throw new Error(`Esquema de la hoja "${CONFIG.SHEETS.DAPS}" inválido: la columna ${i + 1} debería llamarse "${expected[i]}" pero es "${found}".`);
  }

  if (missing) _addMissingHeaders(sheet);
}

/**
 * Abre la hoja de DAPs validando propiedades, existencia y esquema.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet} Hoja de DAPs lista para usar.
 * @throws {Error} Si falta SHARED_SPREADSHEET_ID, la hoja no existe o el esquema es inválido.
 */
function _openDapSheet() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Falta la propiedad SHARED_SPREADSHEET_ID.');

  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(CONFIG.SHEETS.DAPS);
  if (!sheet) throw new Error(`No existe la hoja "${CONFIG.SHEETS.DAPS}" (ejecuta installDapApp()).`);

  _assertSchema(sheet);
  return sheet;
}

/**
 * Busca una fila por su ID interno.
 * @param {Array[]} data - Valores de la hoja (con la fila de encabezados en data[0]).
 * @param {string|number} internalId - ID interno buscado.
 * @returns {{rowIndex: number, row: Array}|null} Fila (rowIndex base 1) o null si no existe.
 */
function _findRowByInternalId(data, internalId) {
  const wanted = parseInt(internalId, 10);
  if (isNaN(wanted)) return null;

  for (let i = 1; i < data.length; i++) {
    const current = parseInt(data[i][DAP_COLS.ID_Interno - 1], 10);
    if (!isNaN(current) && current === wanted) return { rowIndex: i + 1, row: data[i] };
  }
  return null;
}

/**
 * Busca la conversación activa: la primera fila en estado ESPERANDO_TELEGRAM.
 * @param {Array[]} data - Valores de la hoja (con la fila de encabezados en data[0]).
 * @returns {{rowIndex: number, row: Array}|null} Fila activa (rowIndex base 1) o null si no hay ninguna.
 */
function _findActiveConversation(data) {
  for (let i = 1; i < data.length; i++) {
    if (data[i][DAP_COLS.Estado_Cola - 1] === CONFIG.STATES.ESPERANDO_TELEGRAM) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

/**
 * Paso de la conversación de una fila. Si la columna está vacía (filas anteriores a esta
 * columna) se infiere: con Objetivo ya respondido se espera la fecha de liquidación.
 * @param {Array} row - Fila de la hoja.
 * @returns {string} Valor de CONFIG.STEPS.
 */
function _getConversationStep(row) {
  const step = row[DAP_COLS.Paso_Conversacion - 1];
  if (step) return step;
  return row[DAP_COLS.Objetivo - 1] ? CONFIG.STEPS.LIQUIDACION : CONFIG.STEPS.OBJETIVO;
}

/**
 * Escribe un texto libre del usuario en una celda como TEXTO PLANO (nunca como fórmula).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @param {number} rowIndex - Fila (base 1).
 * @param {number} column - Columna (base 1).
 * @param {string} text - Texto a guardar.
 * @returns {void}
 */
function _setPlainText(sheet, rowIndex, column, text) {
  const range = sheet.getRange(rowIndex, column);
  range.setNumberFormat('@');
  range.setValue(text);
}

/**
 * Valida y normaliza el Objetivo escrito por el usuario.
 * @param {string} text - Texto recibido por Telegram.
 * @returns {{ok: boolean, value?: string, error?: string}} Objetivo listo para guardar, o el motivo del rechazo.
 */
function _validateObjetivo(text) {
  const value = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: 'El objetivo no puede estar vacío.' };
  if (value.length > CONFIG.LIMITS.OBJETIVO_MAX) {
    return { ok: false, error: `El objetivo es demasiado largo (máximo ${CONFIG.LIMITS.OBJETIVO_MAX} caracteres).` };
  }
  return { ok: true, value: value };
}
