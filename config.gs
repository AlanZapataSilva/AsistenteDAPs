/**
 * @fileoverview config.gs - Microservicio DAPs
 * Configuración global, reglas de negocio y gestión de variables de entorno.
 */

'use strict';

/**
 * Obtiene una variable de entorno desde PropertiesService (Memoria Segura).
 * * @param {string} key - Clave de la variable a consultar.
 * @returns {string|null} Valor de la variable, o null si no existe o la clave es inválida.
 */
function getEnv(key) {
  if (!key) return null;
  return PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * Constantes estructurales del sistema.
 * Implementa Object.freeze para garantizar la inmutabilidad de la configuración 
 * durante el ciclo de vida de la ejecución.
 * * @constant {Object}
 */
const CONFIG = Object.freeze({
  SHEETS: {
    // Nombre de la hoja de base de datos en el documento remoto
    DAPS: 'DAPs' 
  },
  HEADERS: {
    // Estructura estricta de columnas para la persistencia de datos
    DAPS: [
      'ID_Interno', 
      'ID_Operacion', 
      'Monto', 
      'Tipo_DAP', 
      'Fecha_Inicio', 
      'Fecha_Vencimiento', 
      'Objetivo', 
      'Fecha_Liquidacion', 
      'Liquidado', 
      'Estado_Cola', 
      'ID_Mensaje_Email',
      'Notion_Page_ID'
    ]
  },
  GMAIL: {
    // Etiqueta de idempotencia para marcar correos como procesados
    LABEL_DAP_PROCESSED: 'SaaS_Inversiones/DAP_Procesado'
  }
});

/**
 * Índices de columna (base 1, aptos para Range.getRange) derivados de CONFIG.HEADERS.DAPS.
 * Evita "números mágicos" repetidos y mantiene el acceso a columnas sincronizado
 * automáticamente si el orden de HEADERS.DAPS cambia.
 * @constant {Object}
 */
const DAP_COLS = Object.freeze(
  CONFIG.HEADERS.DAPS.reduce((acc, header, index) => {
    acc[header] = index + 1;
    return acc;
  }, {})
);