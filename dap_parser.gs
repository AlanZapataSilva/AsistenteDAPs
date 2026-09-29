/**
 * @fileoverview dap_parser.gs - Motor de extracción de datos (Regex) para DAPs.
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
    // Atrapa "Tipo de Documento" y busca la palabra "Fijo" o "Renovable" (cruza líneas a propósito,
    // de forma perezosa: se queda con la primera aparición)
    TIPO: /(?:Tipo de Documento|Tipo de Dep.sito|Tipo)[\s\S]*?(Fijo|Renovable)/i,
    FECHA_INICIO: new RegExp('(?:Fecha de Captaci.*n|Fecha de Toma|Fecha Inicio|Emisi.n)' + _GAP + '([\\d/-]{10})', 'i'),
    FECHA_VENCIMIENTO: new RegExp('(?:Fecha de Vencimiento|Vencimiento)' + _GAP + '([\\d/-]{10})', 'i')
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
 * Procesa un correo de DAP del BCI y extrae los datos clave.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - Mensaje de Gmail a procesar.
 * @returns {DapDTO|null} Objeto DTO del DAP o null si la extracción falla.
 */
function parseBciDapEmail(message) {
  try {
    const body = message.getPlainBody() || message.getBody().replace(/<[^>]+>/g, ' ');
    const regex = DAP_BCI_LOGIC.REGEX;

    const matchMonto = body.match(regex.MONTO);
    const matchMoneda = body.match(regex.MONEDA);
    const idOperacion = _extractIdOperacion(body);
    const matchTipo = body.match(regex.TIPO);
    const matchInicio = body.match(regex.FECHA_INICIO);
    const matchVencimiento = body.match(regex.FECHA_VENCIMIENTO);

    if (!matchMonto || !idOperacion) {
      console.warn(`⚠️ Parser BCI: No se pudo extraer Monto u Operación del correo: "${message.getSubject()}"`);
      return null;
    }

    // Moneda: UF si el prefijo del monto o el campo "Moneda" lo indican; en otro caso CLP.
    // UF usa coma decimal ("4,4379"); CLP es un entero con puntos de miles ("61.000").
    const esUF = /\bUF\b/i.test(matchMonto[1]) || (matchMoneda !== null && /^UF$/i.test(matchMoneda[1]));
    const moneda = esUF ? 'UF' : 'CLP';
    const montoOriginal = esUF
      ? _parseFlexibleNumber(matchMonto[2])
      : parseInt(matchMonto[2].replace(/[^\d]/g, ''), 10);
    const tipoLimpio = matchTipo ? matchTipo[1].trim().toUpperCase() : 'FIJO';
    const messageDate = message.getDate();

    return {
      ID_Operacion: idOperacion.trim(),
      Moneda: moneda,
      Monto_Original: montoOriginal,
      // En UF el monto en CLP se calcula después (requiere consultar el valor de la UF a la fecha de captación)
      Monto: esUF ? null : montoOriginal,
      Tipo_DAP: tipoLimpio,
      Fecha_Inicio: _normalizeDate(matchInicio ? matchInicio[1] : null, messageDate),
      Fecha_Vencimiento: _normalizeDate(matchVencimiento ? matchVencimiento[1] : null, messageDate)
    };

  } catch (error) {
    console.error(`❌ Error en parseBciDapEmail: ${error.message}`);
    return null;
  }
}

/**
 * Estandariza las fechas extraídas al formato ISO (YYYY-MM-DD).
 * @private
 * @param {string|null} rawDate - Cadena de texto extraída (Ej: 30/12/2026).
 * @param {Date} fallbackDate - Fecha del correo para usar como respaldo en caso de fallar.
 * @returns {string} Fecha estandarizada en formato YYYY-MM-DD.
 */
function _normalizeDate(rawDate, fallbackDate) {
  if (!rawDate) {
    return Utilities.formatDate(fallbackDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  
  const parts = rawDate.trim().split(/[-/]/);
  
  // Transforma DD/MM/YYYY a YYYY-MM-DD
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  
  return rawDate;
}