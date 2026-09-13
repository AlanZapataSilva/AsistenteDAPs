/**
 * @fileoverview dap_parser.gs - Motor de extracción de datos (Regex) para DAPs.
 */

'use strict';

/**
 * DTO (Data Transfer Object) representativo de un Depósito a Plazo.
 * @typedef {Object} DapDTO
 * @property {string} ID_Operacion - Número de comprobante de la operación.
 * @property {number} Monto - Valor numérico entero de la inversión.
 * @property {string} Tipo_DAP - Clasificación del DAP (FIJO o RENOVABLE).
 * @property {string} Fecha_Inicio - Fecha de toma en formato YYYY-MM-DD.
 * @property {string} Fecha_Vencimiento - Fecha de maduración en formato YYYY-MM-DD.
 */

/**
 * Constantes y Expresiones Regulares para el Banco BCI.
 * @constant {Object}
 */
const DAP_BCI_LOGIC = Object.freeze({
  SUBJECT: 'Comprobante Solicitud de Toma Depósito a plazo',
  REGEX: {
    // Atrapa "Monto Inversión", saltando posibles caracteres de codificación (=C3=B3)
    MONTO: /(?:Monto Inversi.*n|Monto|Capital)[^\d]*\$?\s*([\d.,]+)/i,
    // Atrapa "N° del Depósito", extendiendo el largo de dígitos a 15 por precaución
    OPERACION: /(?:N.*del Dep.*sito|Operaci.n|N.mero|Nro|Comprobante)[^\d]*(\d{6,15})/i,
    // Atrapa "Tipo de Documento" y busca la palabra "Fijo" o "Renovable"
    TIPO: /(?:Tipo de Documento|Tipo de Dep.sito|Tipo)[\s\S]*?(Fijo|Renovable)/i,
    FECHA_INICIO: /(?:Fecha de Captaci.*n|Fecha de Toma|Fecha Inicio|Emisi.n)[^\d]*([\d/-]{10})/i,
    FECHA_VENCIMIENTO: /(?:Fecha de Vencimiento|Vencimiento)[^\d]*([\d/-]{10})/i
  }
});

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
    const matchOperacion = body.match(regex.OPERACION);
    const matchTipo = body.match(regex.TIPO);
    const matchInicio = body.match(regex.FECHA_INICIO);
    const matchVencimiento = body.match(regex.FECHA_VENCIMIENTO);

    if (!matchMonto || !matchOperacion) {
      console.warn(`⚠️ Parser BCI: No se pudo extraer Monto u Operación del correo: "${message.getSubject()}"`);
      return null;
    }

    // Limpieza de datos
    const montoNumerico = parseInt(matchMonto[1].replace(/[^\d]/g, ''), 10);
    const tipoLimpio = matchTipo ? matchTipo[1].trim().toUpperCase() : 'FIJO'; 
    const messageDate = message.getDate();

    return {
      ID_Operacion: matchOperacion[1].trim(),
      Monto: montoNumerico,
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