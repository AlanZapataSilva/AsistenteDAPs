/**
 * @fileoverview setup.gs - Inicializador del entorno remoto
 * Script de instalación y configuración inicial de la infraestructura del Microservicio.
 * `installDapApp()` es idempotente: puede ejecutarse de nuevo tras cada despliegue.
 */

'use strict';

/**
 * Triggers de tiempo del microservicio. `installDapApp()` crea los que falten.
 * @typedef {Object} TriggerSpec
 * @property {string} handler - Nombre de la función global que ejecuta el trigger.
 * @property {string} description - Descripción legible (para logs).
 * @property {function(GoogleAppsScript.Script.TriggerBuilder): GoogleAppsScript.Script.Trigger} create - Crea el trigger.
 */

/** @type {TriggerSpec[]} */
const _TRIGGER_SPECS = [
  { handler: 'processDapEmails', description: 'cada 15 min', create: (b) => b.timeBased().everyMinutes(15).create() },
  { handler: 'checkAndLiquidateDaps', description: 'diario 08:00', create: (b) => b.timeBased().everyDays(1).atHour(8).create() },
  { handler: 'retryNotionSync', description: 'cada 30 min', create: (b) => b.timeBased().everyMinutes(30).create() },
  { handler: 'watchdogTick', description: 'cada hora', create: (b) => b.timeBased().everyHours(1).create() },
  { handler: 'healthCheck', description: 'diario 07:00', create: (b) => b.timeBased().everyDays(1).atHour(7).create() },
  { handler: 'parserCanary', description: 'lunes 09:00', create: (b) => b.timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create() },
  { handler: 'backupSheet', description: 'domingo 03:00', create: (b) => b.timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create() }
];

/**
 * Función de ejecución manual (repetible).
 * Conecta con el Sheet base y despliega la infraestructura (hoja, etiquetas de Gmail y triggers).
 * @returns {void}
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
    console.error(`❌ Error crítico de instalación: ${error.message} (Verifica que el SHARED_SPREADSHEET_ID sea correcto y tengas permisos).`);
  }
}

/**
 * Configura la hoja de cálculo, inyecta encabezados y ajusta estilos visuales y validaciones.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Instancia del Spreadsheet remoto.
 * @returns {void}
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
    sheet.setColumnWidth(DAP_COLS.ID_Interno, 100);
    sheet.setColumnWidth(DAP_COLS.ID_Operacion, 120);
    sheet.setColumnWidth(DAP_COLS.Objetivo, 200);
    sheet.setColumnWidth(DAP_COLS.Notion_Page_ID, 250);

    console.log(`✅ Hoja de base de datos creada exitosamente: ${CONFIG.SHEETS.DAPS}`);
  } else {
    console.log(`ℹ️ La hoja ${CONFIG.SHEETS.DAPS} ya existe en el documento.`);
    _addMissingHeaders(sheet);
  }

  _applySheetPolish(sheet);
}

/**
 * Agrega al final de la fila de encabezados las columnas de CONFIG.HEADERS.DAPS que aún no
 * existan (migración idempotente para hojas creadas antes de agregar columnas nuevas).
 * Las filas existentes quedan con esas celdas vacías.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs existente.
 * @returns {void}
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
 * Aplica a la hoja las validaciones y formatos que evitan errores de edición manual:
 * desplegables (estado, tipo, moneda), casillas de "Liquidado", formatos de fecha/ID/texto y
 * encabezado protegido (advertencia). Idempotente. Las validaciones solo advierten (no bloquean)
 * para no interferir con las escrituras del script.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @returns {void}
 */
function _applySheetPolish(sheet) {
  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  const column = (name) => sheet.getRange(2, DAP_COLS[name], rows, 1);

  const dropdown = (name, values) => column(name).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());

  dropdown('Estado_Cola', Object.keys(CONFIG.STATES).map((key) => CONFIG.STATES[key]));
  dropdown('Tipo_DAP', ['FIJO', 'RENOVABLE']);
  dropdown('Moneda', ['CLP', 'UF']);

  column('Liquidado').insertCheckboxes();
  column('ID_Operacion').setNumberFormat('0');
  ['Fecha_Inicio', 'Fecha_Vencimiento', 'Fecha_Liquidacion'].forEach((name) => column(name).setNumberFormat('yyyy-mm-dd'));
  column('Objetivo').setNumberFormat('@');

  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  if (!protections.some((p) => p.getDescription() === 'DAP_HEADER')) {
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.DAPS.length).protect().setDescription('DAP_HEADER').setWarningOnly(true);
  }

  console.log('✅ Validaciones y formatos de la hoja aplicados.');
}

/**
 * Configura las etiquetas de Gmail necesarias: idempotencia (procesado) y correos con error.
 * @private
 * @returns {void}
 */
function _setupGmailLabels() {
  [CONFIG.GMAIL.LABEL_DAP_PROCESSED, CONFIG.GMAIL.LABEL_DAP_ERROR].forEach((labelName) => {
    if (!GmailApp.getUserLabelByName(labelName)) {
      GmailApp.createLabel(labelName);
      console.log(`✅ Etiqueta de Gmail creada: ${labelName}`);
    } else {
      console.log(`ℹ️ La etiqueta de Gmail ya existe: ${labelName}`);
    }
  });
}

/**
 * Crea los triggers de tiempo requeridos por el microservicio si aún no existen.
 * Idempotente: puede ejecutarse múltiples veces (ej. en reinstalaciones) sin duplicar triggers.
 * @private
 * @returns {void}
 */
function _setupTriggers() {
  const existingHandlers = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());

  _TRIGGER_SPECS.forEach((spec) => {
    if (existingHandlers.includes(spec.handler)) {
      console.log(`ℹ️ Trigger ${spec.handler} ya existe.`);
      return;
    }
    spec.create(ScriptApp.newTrigger(spec.handler));
    console.log(`✅ Trigger creado: ${spec.handler} (${spec.description}).`);
  });
}
