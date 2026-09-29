/**
 * @fileoverview setup.gs - Inicializador del entorno remoto
 * Script de instalación y configuración inicial de la infraestructura del Microservicio.
 */

'use strict';

/**
 * Función de ejecución manual (Única vez).
 * Conecta con el Sheet base y despliega la infraestructura inicial (Sheets y Gmail).
 */
function installDapApp() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  
  if (!spreadsheetId) {
    console.error('❌ ERROR: Debes configurar el SHARED_SPREADSHEET_ID en las Propiedades del Script antes de instalar.');
    return;
  }

  try {
    console.log('🔗 Conectando a la base de datos compartida...');
    const ss = SpreadsheetApp.openById(spreadsheetId);
    
    // Delegación de responsabilidades a funciones privadas
    _setupDatabase(ss);
    _setupGmailLabels();
    _setupTriggers();

    console.log('🚀 Instalación del Microservicio DAP completada de forma segura.');
    
  } catch (error) {
    console.error(`❌ Error crítico de conexión: ${error.message} (Verifica que el SHARED_SPREADSHEET_ID sea correcto y tengas permisos).`);
  }
}

/**
 * Configura la hoja de cálculo, inyecta encabezados y ajusta estilos visuales.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Instancia del Spreadsheet remoto.
 */
function _setupDatabase(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
  
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEETS.DAPS);
    sheet.appendRow(CONFIG.HEADERS.DAPS);
    
    // Estilos para los encabezados (Verde Inversión)
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.DAPS.length)
         .setBackground('#0f9d58') 
         .setFontColor('#FFFFFF')
         .setFontWeight('bold');
    sheet.setFrozenRows(1);
    
    // Ajuste de anchos de columna para mejor legibilidad
    sheet.setColumnWidth(1, 100);  // ID_Interno
    sheet.setColumnWidth(2, 120);  // ID_Operacion
    sheet.setColumnWidth(7, 200);  // Objetivo
    sheet.setColumnWidth(12, 250); // Notion_Page_ID
    
    console.log(`✅ Hoja de base de datos creada exitosamente: ${CONFIG.SHEETS.DAPS}`);
  } else {
    console.log(`ℹ️ La hoja ${CONFIG.SHEETS.DAPS} ya existe en el documento.`);
    _addMissingHeaders(sheet);
  }
}

/**
 * Agrega al final de la fila de encabezados las columnas de CONFIG.HEADERS.DAPS que aún no
 * existan (migración idempotente para hojas creadas antes de agregar columnas nuevas).
 * Las filas existentes quedan con esas celdas vacías.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs existente.
 */
function _addMissingHeaders(sheet) {
  const expected = CONFIG.HEADERS.DAPS;
  const currentWidth = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getRange(1, 1, 1, currentWidth).getValues()[0];

  expected.forEach((header, index) => {
    if (current[index] === header) return;
    if (current[index] !== undefined && current[index] !== '') {
      console.warn(`⚠️ Encabezado inesperado en la columna ${index + 1}: "${current[index]}" (se esperaba "${header}"). No se modifica.`);
      return;
    }
    sheet.getRange(1, index + 1)
         .setValue(header)
         .setBackground('#0f9d58')
         .setFontColor('#FFFFFF')
         .setFontWeight('bold');
    console.log(`✅ Encabezado agregado: "${header}" (columna ${index + 1}).`);
  });
}

/**
 * Configura la etiqueta de Gmail necesaria para la idempotencia.
 * @private
 */
function _setupGmailLabels() {
  const labelName = CONFIG.GMAIL.LABEL_DAP_PROCESSED;
  const existingLabel = GmailApp.getUserLabelByName(labelName);

  if (!existingLabel) {
    GmailApp.createLabel(labelName);
    console.log(`✅ Etiqueta de Gmail creada: ${labelName}`);
  } else {
    console.log(`ℹ️ La etiqueta de Gmail ya existe: ${labelName}`);
  }
}

/**
 * Crea los triggers de tiempo requeridos por el microservicio si aún no existen.
 * Idempotente: puede ejecutarse múltiples veces (ej. en reinstalaciones) sin duplicar triggers.
 * @private
 */
function _setupTriggers() {
  const existingHandlers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());

  if (!existingHandlers.includes('processDapEmails')) {
    ScriptApp.newTrigger('processDapEmails')
      .timeBased()
      .everyMinutes(15)
      .create();
    console.log('✅ Trigger creado: processDapEmails (cada 15 min).');
  } else {
    console.log('ℹ️ Trigger processDapEmails ya existe.');
  }

  if (!existingHandlers.includes('checkAndLiquidateDaps')) {
    ScriptApp.newTrigger('checkAndLiquidateDaps')
      .timeBased()
      .everyDays(1)
      .atHour(8)
      .create();
    console.log('✅ Trigger creado: checkAndLiquidateDaps (diario, 08:00 America/Santiago).');
  } else {
    console.log('ℹ️ Trigger checkAndLiquidateDaps ya existe.');
  }
}