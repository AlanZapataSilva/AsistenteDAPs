/**
 * @fileoverview dap_parser.gs - Motor de extracción de datos (Regex) para DAPs.
 * El parser es ESTRICTO: si un dato obligatorio falta o no es coherente, falla con un código de
 * error explícito en vez de inventar un valor por defecto (un DAP mal registrado es peor que un
 * DAP pendiente de revisión).
 */

'use strict';

/**
 * DTO (Data Transfer Object) representativo de un Depósito a Plazo.
 * @typedef {Object} DapDTO
 * @property {string} ID_Operacion - Número de comprobante de la operación.
 * @property {string} Moneda - Moneda del DAP: 'CLP' o 'UF'.
 * @property {number} Monto_Original - Monto en la moneda original del correo (CLP entero, o UF con decimales).
 * @property {number|null} Monto - Monto en CLP (entero). Para DAP en UF es null hasta convertirlo con `_enrichWithClpAmount`.
 * @property {number} [Valor_UF] - Valor de la UF usado en la conversión (solo DAP en UF, tras convertir).
 * @property {string} Tipo_DAP - Clasificación del DAP (FIJO o RENOVABLE).
 * @property {string} Fecha_Inicio - Fecha de toma en formato YYYY-MM-DD.
 * @property {string} Fecha_Vencimiento - Fecha de maduración en formato YYYY-MM-DD.
 * @property {number} [Valor_Final] - "Valor Final" del correo de toma, en la moneda del DAP (solo si el
 *   correo lo trae y es coherente). Para un DAP renovable es el valor al primer vencimiento, NO el monto final.
 */

/**
 * Resultado del parseo de un correo.
 * @typedef {Object} ParseResult
 * @property {boolean} ok - true si se extrajo un DAP válido.
 * @property {DapDTO} [dto] - DAP extraído (solo si ok).
 * @property {{code: string, message: string}} [error] - Motivo del fallo (solo si !ok). Códigos:
 *   CUERPO_VACIO, MONEDA_NO_SOPORTADA, SIN_MONTO, SIN_OPERACION, MONTO_INVALIDO,
 *   TIPO_DESCONOCIDO, FECHA_INVALIDA, FECHAS_INCOHERENTES, EXCEPCION.
 */

// "Gap" entre una etiqueta y su valor. Reglas (ver AGENTS.md, "Email Regex Line-Crossing"):
//  - Tolera que la etiqueta y el valor estén en la misma línea o en líneas distintas (Gmail suele
//    renderizar cada celda de una tabla HTML en su propia línea), incluyendo plantillas de 3
//    celdas etiqueta / separador (":" , "$" o "UF") / valor.
//  - Solo puede saltar: el resto de la línea de la etiqueta y líneas que contengan ÚNICAMENTE
//    separadores (espacios, ":", "$", "UF") o estén en blanco. Nunca cruza hacia otra fila con
//    texto (otra etiqueta), que es lo que causó capturar el N° de Transacción en vez del de Depósito.
//  - Es un texto para `new RegExp` y no lleva grupos de captura.
const _GAP = '(?:[^\\d\\r\\n]*\\r?\\n)?(?:[ \\t\\u00a0:$]*(?:UF)?[ \\t\\u00a0:$]*\\r?\\n)*[^\\d\\r\\n]*';

/**
 * Constantes y Expresiones Regulares para el Banco BCI.
 * @constant {Object}
 */
const DAP_BCI_LOGIC = Object.freeze({
  SUBJECT: 'Comprobante Solicitud de Toma Depósito a plazo',
  REGEX: {
    // Atrapa "Monto Inversión". Grupo 1: todo el gap entre la etiqueta y el número (puede
    // contener "$" o "UF", usado para detectar la moneda). Grupo 2: el número (CLP: "61.000" o
    // "1,525,000"; UF: "4,4379").
    MONTO: new RegExp('(?:Monto Inversi.*n|Monto|Capital)(' + _GAP + ')([\\d.,]+)', 'i'),
    // Campo "Moneda" de la tabla (valor "UF" o "Pesos"); señal adicional a la del prefijo del monto
    MONEDA: /Moneda[\s:]*(UF|Pesos)\b/i,
    // Monedas extranjeras: no están soportadas y NO deben registrarse como pesos
    MONEDA_EXTRANJERA: /Moneda[\s:]*(USD|US\$|D[oó]lar(?:es)?|EUR|Euros?|GBP|Libras?)/i,
    // Atrapa "Tipo de Documento" y busca la palabra "Fijo" o "Renovable" (cruza líneas a propósito,
    // de forma perezosa: se queda con la primera aparición)
    TIPO: /(?:Tipo de Documento|Tipo de Dep.sito|Tipo)[\s\S]*?(Fijo|Renovable)/i,
    FECHA_INICIO: new RegExp('(?:Fecha de Captaci.*n|Fecha de Toma|Fecha Inicio|Emisi.n)' + _GAP + '([\\d/-]{10})', 'i'),
    FECHA_VENCIMIENTO: new RegExp('(?:Fecha de Vencimiento|Vencimiento)' + _GAP + '([\\d/-]{10})', 'i'),
    // "Valor Final" del correo de toma (opcional). Grupo 1: gap (puede traer "$" o "UF"); grupo 2: el número.
    VALOR_FINAL: new RegExp('(?:Valor Final|Monto Final)(' + _GAP + ')([\\d.,]+)', 'i')
  },
  // Candidatos para el N° de Depósito/Operación, ordenados por confiabilidad (más
  // específico primero). Se usa el PRIMERO que matchee en cualquier parte del correo,
  // no el que aparezca primero en el texto: BCI a veces incluye un encabezado de sección
  // ("Detalle de la operación") ANTES de la tabla de datos, y un correo más nuevo agregó
  // un campo "N° Transacción" que no es el número que queremos. Si dejáramos un solo regex
  // combinado con alternativas, el fallback genérico "Operaci.n" podría matchear esa
  // palabra en el encabezado (que aparece antes en el texto).
  // "(?:del\s+)?" hace opcional la palabra "del" porque BCI la agregó/quitó entre versiones
  // de la plantilla ("N° del Depósito" vs "N° Depósito").
  OPERACION_CANDIDATES: [
    new RegExp('N.*(?:del\\s+)?Dep.*sito' + _GAP + '(\\d{6,15})', 'i'),
    new RegExp('Comprobante' + _GAP + '(\\d{6,15})', 'i'),
    new RegExp('N.mero' + _GAP + '(\\d{6,15})', 'i'),
    new RegExp('Nro' + _GAP + '(\\d{6,15})', 'i'),
    new RegExp('Operaci.n' + _GAP + '(\\d{6,15})', 'i')
  ]
});

/**
 * Extrae el número de operación/depósito probando los patrones de
 * `DAP_BCI_LOGIC.OPERACION_CANDIDATES` en orden de confiabilidad, y retorna el resultado
 * del primero que matchee en cualquier parte del cuerpo del correo.
 * @private
 * @param {string} body - Cuerpo del correo (texto plano).
 * @returns {string|null} El número de operación/depósito extraído, o null si ninguno matchea.
 */
function _extractIdOperacion(body) {
  for (const pattern of DAP_BCI_LOGIC.OPERACION_CANDIDATES) {
    const match = body.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Interpreta un monto de un correo del banco. UF admite decimales (formato variable entre
 * plantillas: ver `_parseFlexibleNumber`); pesos se redondea a entero.
 * @private
 * @param {string} text - Número tal como aparece en el correo (ej. "142.740", "1,525,000", "4,4379").
 * @param {boolean} isUF - true si el monto está en UF.
 * @returns {number} Monto, o NaN si no se puede interpretar.
 */
function _parseBankAmount(text, isUF) {
  const value = _parseFlexibleNumber(text);
  return isUF ? value : Math.round(value);
}

/**
 * Obtiene el cuerpo de un correo como texto plano: usa la versión de texto y, si no existe, convierte
 * el HTML (`_htmlToText`).
 * @private
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - Mensaje de Gmail.
 * @returns {string} Cuerpo legible, o cadena vacía si el correo no tiene contenido.
 */
function _readEmailBody(message) {
  let body = message.getPlainBody();
  if (!body || !body.trim()) body = _htmlToText(message.getBody() || '');
  return body && body.trim() ? body : '';
}

/**
 * Convierte el HTML de un correo a texto plano preservando la estructura de filas: cada celda
 * o bloque termina en un salto de línea y las entidades HTML se decodifican. Se usa solo cuando
 * el correo no trae versión de texto plano.
 * @private
 * @param {string} html - Cuerpo HTML del correo.
 * @returns {string} Texto plano.
 */
function _htmlToText(html) {
  const entities = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", deg: '°',
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
    Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü'
  };

  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th|tr|p|div|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => (Object.prototype.hasOwnProperty.call(entities, name) ? entities[name] : match))
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Interpreta una fecha de un correo: `DD-MM-YYYY`, `DD/MM/YYYY` o `YYYY-MM-DD` (con `-` o `/`).
 * @private
 * @param {string|null|undefined} raw - Texto extraído del correo.
 * @returns {string|null} Fecha ISO (YYYY-MM-DD), o null si el formato o la fecha no son válidos.
 */
function _parseEmailDate(raw) {
  const value = String(raw === null || raw === undefined ? '' : raw).trim();
  let year;
  let month;
  let day;

  let match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    year = parseInt(match[1], 10); month = parseInt(match[2], 10); day = parseInt(match[3], 10);
  } else {
    match = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!match) return null;
    day = parseInt(match[1], 10); month = parseInt(match[2], 10); year = parseInt(match[3], 10);
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Procesa un correo de DAP del BCI y extrae los datos clave, con validación estricta.
 * No lanza excepciones: cualquier problema se devuelve como `{ok: false, error}`.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - Mensaje de Gmail a procesar.
 * @returns {ParseResult} Resultado del parseo.
 */
function parseBciDapEmailDetailed(message) {
  const fail = (code, detail) => ({ ok: false, error: { code: code, message: detail } });

  try {
    const body = _readEmailBody(message);
    if (!body) return fail('CUERPO_VACIO', 'El correo no tiene contenido legible.');

    const regex = DAP_BCI_LOGIC.REGEX;

    const foreign = body.match(regex.MONEDA_EXTRANJERA);
    if (foreign) return fail('MONEDA_NO_SOPORTADA', `Moneda no soportada: "${foreign[1]}".`);

    const matchMonto = body.match(regex.MONTO);
    if (!matchMonto) return fail('SIN_MONTO', 'No se encontró el monto de la inversión.');

    const idOperacion = _extractIdOperacion(body);
    if (!idOperacion) return fail('SIN_OPERACION', 'No se encontró el número de depósito/operación.');

    // Moneda: UF si el prefijo del monto o el campo "Moneda" lo indican; en otro caso CLP.
    // UF usa coma decimal ("4,4379"); CLP es un entero con separadores de miles.
    const matchMoneda = body.match(regex.MONEDA);
    const esUF = /\bUF\b/i.test(matchMonto[1]) || (matchMoneda !== null && /^UF$/i.test(matchMoneda[1]));
    const montoOriginal = esUF
      ? _parseFlexibleNumber(matchMonto[2])
      : parseInt(matchMonto[2].replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(montoOriginal) || montoOriginal <= 0) {
      return fail('MONTO_INVALIDO', `Monto no interpretable: "${matchMonto[2]}".`);
    }

    const matchTipo = body.match(regex.TIPO);
    if (!matchTipo) return fail('TIPO_DESCONOCIDO', 'No se pudo determinar si el DAP es Fijo o Renovable.');

    const matchInicio = body.match(regex.FECHA_INICIO);
    const matchVencimiento = body.match(regex.FECHA_VENCIMIENTO);
    const fechaInicio = _parseEmailDate(matchInicio && matchInicio[1]);
    const fechaVencimiento = _parseEmailDate(matchVencimiento && matchVencimiento[1]);
    if (!fechaInicio || !fechaVencimiento) {
      return fail('FECHA_INVALIDA', `Fechas no interpretables (captación: "${matchInicio && matchInicio[1]}", vencimiento: "${matchVencimiento && matchVencimiento[1]}").`);
    }
    if (fechaVencimiento <= fechaInicio) {
      return fail('FECHAS_INCOHERENTES', `El vencimiento (${fechaVencimiento}) no es posterior a la captación (${fechaInicio}).`);
    }

    const dto = {
      ID_Operacion: idOperacion.trim(),
      Moneda: esUF ? 'UF' : 'CLP',
      Monto_Original: montoOriginal,
      // En UF el monto en CLP se calcula después (requiere consultar el valor de la UF a la fecha de captación)
      Monto: esUF ? null : montoOriginal,
      Tipo_DAP: matchTipo[1].trim().toUpperCase(),
      Fecha_Inicio: fechaInicio,
      Fecha_Vencimiento: fechaVencimiento
    };

    // "Valor Final" es opcional: solo se informa si es coherente con el DAP; nunca se inventa ni
    // provoca el rechazo del correo (el DAP se registra igual, sin monto final proyectado).
    const valorFinal = _extractValorFinal(body, esUF, montoOriginal);
    if (valorFinal !== null) dto.Valor_Final = valorFinal;

    return { ok: true, dto: dto };

  } catch (error) {
    return fail('EXCEPCION', error.message);
  }
}

/**
 * Extrae el "Valor Final" del correo de toma (monto que recibirá al vencimiento). Se descarta, con
 * una advertencia, si no es coherente: moneda distinta a la del DAP, no numérico o menor que la
 * inversión (el interés no puede ser negativo).
 * @private
 * @param {string} body - Cuerpo del correo (texto plano).
 * @param {boolean} esUF - true si el DAP está en UF.
 * @param {number} montoOriginal - Monto invertido, en la moneda del DAP.
 * @returns {number|null} Valor final en la moneda del DAP, o null si no está o no es confiable.
 */
function _extractValorFinal(body, esUF, montoOriginal) {
  const match = body.match(DAP_BCI_LOGIC.REGEX.VALOR_FINAL);
  if (!match) return null;

  const gap = match[1];
  const currencyMismatch = esUF ? /\$/.test(gap) : /\bUF\b/i.test(gap);
  const value = _parseBankAmount(match[2], esUF);

  if (currencyMismatch || !Number.isFinite(value) || value < montoOriginal) {
    console.warn(`⚠️ Parser BCI: "Valor Final" descartado por incoherente ("${match[2]}", inversión ${montoOriginal}, ${esUF ? 'UF' : 'CLP'}).`);
    return null;
  }
  return value;
}

/**
 * Constantes y expresiones regulares del correo de liquidación del BCI ("Comprobante de liquidación
 * de Depósito a plazo", enviado por contacto@bci.cl). Tabla de 2 celdas etiqueta / valor.
 * @constant {Object}
 */
const DAP_BCI_LIQUIDATION = Object.freeze({
  SUBJECT: 'Comprobante de liquidación de Depósito a plazo',
  REGEX: {
    // Solo el N° del DEPÓSITO. A diferencia del correo de toma no hay candidatos genéricos
    // ("Número", "Operación"): un N° equivocado marcaría como liquidado otro DAP con un monto ajeno.
    // Los `.{1,3}` toleran tildes mal codificadas ("Dep=C3=B3sito").
    OPERACION: new RegExp('N(?:.{1,3}mero|[°º]|ro\\.?)\\s*(?:del\\s+)?Dep.{1,3}sito' + _GAP + '(\\d{6,15})', 'i'),
    // Grupo 1: gap (puede traer "$" o "UF"); grupo 2: el número (CLP "142.740"; UF "4,5123")
    MONTO_FINAL: new RegExp('(?:Monto|Valor)\\s+final(?:\\s+del\\s+dep.{1,3}sito)?(' + _GAP + ')([\\d.,]+)', 'i'),
    FECHA_LIQUIDACION: new RegExp('Fecha(?:\\s+y\\s+hora)?(?:\\s+de)?\\s+liquidaci.{1,3}n' + _GAP + '([\\d/-]{10})', 'i')
  }
});

/**
 * Resultado del parseo de un correo de liquidación.
 * @typedef {Object} LiquidationDTO
 * @property {string} ID_Operacion - N° del depósito liquidado.
 * @property {string} Moneda - Moneda del monto final: 'CLP' o 'UF'.
 * @property {number} Monto_Final_Original - Monto final en la moneda indicada (CLP entero, o UF con decimales).
 * @property {string} Fecha_Liquidacion - Fecha real de liquidación (YYYY-MM-DD).
 * @property {string} [Tipo_DAP] - FIJO o RENOVABLE, si el correo lo informa (solo para verificar coherencia).
 */

/**
 * Interpreta un correo de liquidación de DAP del BCI con validación estricta (mismo criterio que
 * `parseBciDapEmailDetailed`: un dato obligatorio ausente o incoherente es un error, nunca un valor
 * por defecto). No lanza excepciones.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - Mensaje de Gmail a procesar.
 * @returns {{ok: boolean, dto?: LiquidationDTO, error?: {code: string, message: string}}} Resultado del parseo. Códigos de
 *   error: CUERPO_VACIO, MONEDA_NO_SOPORTADA, SIN_OPERACION, SIN_MONTO_FINAL, MONTO_INVALIDO, FECHA_INVALIDA, EXCEPCION.
 */
function parseBciLiquidationEmailDetailed(message) {
  const fail = (code, detail) => ({ ok: false, error: { code: code, message: detail } });

  try {
    const body = _readEmailBody(message);
    if (!body) return fail('CUERPO_VACIO', 'El correo no tiene contenido legible.');

    const foreign = body.match(DAP_BCI_LOGIC.REGEX.MONEDA_EXTRANJERA);
    if (foreign) return fail('MONEDA_NO_SOPORTADA', `Moneda no soportada: "${foreign[1]}".`);

    const regex = DAP_BCI_LIQUIDATION.REGEX;
    const matchOperacion = body.match(regex.OPERACION);
    if (!matchOperacion) return fail('SIN_OPERACION', 'No se encontró el número del depósito.');

    const matchMonto = body.match(regex.MONTO_FINAL);
    if (!matchMonto) return fail('SIN_MONTO_FINAL', 'No se encontró el monto final del depósito.');

    const matchMoneda = body.match(DAP_BCI_LOGIC.REGEX.MONEDA);
    const esUF = /\bUF\b/i.test(matchMonto[1]) || (matchMoneda !== null && /^UF$/i.test(matchMoneda[1]));
    const montoFinal = _parseBankAmount(matchMonto[2], esUF);
    if (!Number.isFinite(montoFinal) || montoFinal <= 0) {
      return fail('MONTO_INVALIDO', `Monto final no interpretable: "${matchMonto[2]}".`);
    }

    const matchFecha = body.match(regex.FECHA_LIQUIDACION);
    const fechaLiquidacion = _parseEmailDate(matchFecha && matchFecha[1]);
    if (!fechaLiquidacion) {
      return fail('FECHA_INVALIDA', `Fecha de liquidación no interpretable ("${matchFecha && matchFecha[1]}").`);
    }

    const dto = {
      ID_Operacion: matchOperacion[1].trim(),
      Moneda: esUF ? 'UF' : 'CLP',
      Monto_Final_Original: montoFinal,
      Fecha_Liquidacion: fechaLiquidacion
    };
    const matchTipo = body.match(DAP_BCI_LOGIC.REGEX.TIPO);
    if (matchTipo) dto.Tipo_DAP = matchTipo[1].trim().toUpperCase();

    return { ok: true, dto: dto };

  } catch (error) {
    return fail('EXCEPCION', error.message);
  }
}

/**
 * Procesa un correo de DAP del BCI. Envoltorio de `parseBciDapEmailDetailed` que devuelve solo
 * el DTO (o null si falla, registrando el motivo).
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - Mensaje de Gmail a procesar.
 * @returns {DapDTO|null} Objeto DTO del DAP o null si la extracción falla.
 */
function parseBciDapEmail(message) {
  const result = parseBciDapEmailDetailed(message);
  if (!result.ok) {
    let subject = '';
    try { subject = message.getSubject(); } catch (error) { subject = '(sin asunto)'; }
    console.warn(`⚠️ Parser BCI [${result.error.code}]: ${result.error.message} (asunto: "${subject}")`);
    return null;
  }
  return result.dto;
}
