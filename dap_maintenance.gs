/**
 * @fileoverview dap_maintenance.gs - Herramientas de auditoría y reparación manual.
 * Funciones de ejecución manual (no forman parte del pipeline automático), pensadas para
 * remediar datos ya guardados cuando se corrige un bug en dap_parser.gs.
 */

'use strict';

/**
 * Audita las filas del Sheet que aún NO llegaron a "COMPLETADO" (el usuario todavía no
 * terminó su conversación de Telegram para esa fila): re-parsea el correo original de cada
 * una (vía `ID_Mensaje_Email`, ya guardado) con el parser ACTUAL de `dap_parser.gs`, y si el
 * `ID_Operacion` resultante no coincide con el que ya está escrito en el Sheet, lo corrige.
 *
 * No toca filas "COMPLETADO": esas ya pudieron sincronizarse con Notion, y corregir el Sheet
 * ahí no las actualizaría allá (para esas, hay que corregir manualmente en ambos lados).
 *
 * Pensada para ejecutarse manualmente UNA VEZ desde el editor de Apps Script después de un
 * fix en el parser (ej. el bug donde se capturaba el N° de Transacción en vez del N° de
 * Depósito) para reparar DAPs que ya se habían encolado con el bug antes del fix.
 */
function auditPendingDapOperaciones() {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  if (!spreadsheetId) {
    console.error('❌ Auditoría: No se encontró SHARED_SPREADSHEET_ID en las propiedades.');
    return;
  }

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.DAPS);
  const data = sheet.getDataRange().getValues();

  let revisadas = 0;
  let corregidas = 0;
  let sinCorreo = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const estadoCola = row[DAP_COLS.Estado_Cola - 1];

    if (estadoCola === 'COMPLETADO') continue;

    const idInterno = row[DAP_COLS.ID_Interno - 1];
    const idOperacionActual = String(row[DAP_COLS.ID_Operacion - 1]);
    const idMensaje = row[DAP_COLS.ID_Mensaje_Email - 1];

    if (!idMensaje) {
      sinCorreo++;
      continue;
    }

    revisadas++;

    let message;
    try {
      message = GmailApp.getMessageById(idMensaje);
    } catch (error) {
      console.warn(`⚠️ Auditoría: No se pudo abrir el correo del DAP [${idInterno}] (ID_Mensaje_Email=${idMensaje}): ${error.message}`);
      continue;
    }

    const dapDto = parseBciDapEmail(message);
    if (!dapDto) {
      console.warn(`⚠️ Auditoría: El parser actual no pudo re-extraer el DAP [${idInterno}]. Revísalo manualmente.`);
      continue;
    }

    if (String(dapDto.ID_Operacion) !== idOperacionActual) {
      const rowIndex = i + 1;
      sheet.getRange(rowIndex, DAP_COLS.ID_Operacion).setValue(dapDto.ID_Operacion);
      corregidas++;
      console.info(`✏️ Auditoría: DAP [${idInterno}] corregido: ID_Operacion "${idOperacionActual}" → "${dapDto.ID_Operacion}"`);
    }
  }

  SpreadsheetApp.flush();
  console.info(`✅ Auditoría completa: ${revisadas} fila(s) revisada(s), ${corregidas} corregida(s), ${sinCorreo} sin correo asociado.`);
}
