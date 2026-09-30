/**
 * @fileoverview dap_repair.gs - Auditoría y reparación de DAP completados (Sheet + Notion).
 *
 * Pipeline manual, en este orden obligatorio:
 *   Sheet  a) marcar como liquidados los DAP que ya se liquidaron.
 *   Sheet  b) DAP renovables sin liquidar con fecha de liquidación fuera de ventana de renovación:
 *             se informan con 🚨 y se corrige la fecha a la válida más cercana.
 *   Sheet  c) DAP COMPLETADOS sin página en Notion: se envían (upsert por "ID operación").
 *   Notion a) páginas duplicadas: se conserva la más reciente, se complementa con lo que tenían
 *             las antiguas y se archivan las antiguas; luego se re-enlazan las filas del Sheet y
 *             se reflejan en Notion los cambios hechos en el Sheet (a y b).
 * `auditCompletedDaps()` simula (solo log); `repairCompletedDapsApply()` aplica.
 */

'use strict';

/**
 * SIMULACIÓN: ejecuta la auditoría completa del Sheet y de Notion y muestra en el log todo lo
 * que se haría, sin modificar nada. Revisar el log y luego ejecutar `repairCompletedDapsApply()`.
 */
function auditCompletedDaps() {
  _repairCompletedDaps(false);
}

/**
 * APLICA la reparación completa (ver descripción del archivo). Es idempotente: volver a
 * ejecutarla no repite cambios ya hechos.
 */
function repairCompletedDapsApply() {
  _repairCompletedDaps(true);
}

/**
 * Planifica (sin efectos) las correcciones del Sheet sobre las filas COMPLETADAS.
 * @private
 * @param {Array[]} data - Valores de la hoja, incluyendo la fila de encabezados.
 * @param {string} todayIso - Fecha de hoy (ISO).
 * @param {Object} pagesById - Páginas de Notion indexadas por id (puede estar vacío).
 * @returns {{liquidate: Object[], dateFixes: Object[], toPush: Object[]}} Acciones por fila
 *   (`rowIndex` es el número de fila en la hoja, base 1).
 */
function _planSheetFixes(data, todayIso, pagesById) {
  const liquidate = [];
  const dateFixes = [];
  const toPush = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[DAP_COLS.Estado_Cola - 1] !== 'COMPLETADO') continue;

    const rowIndex = i + 1;
    const idInterno = row[DAP_COLS.ID_Interno - 1];
    const fechaLiq = _toIsoDate(row[DAP_COLS.Fecha_Liquidacion - 1]);
    const pageId = row[DAP_COLS.Notion_Page_ID - 1];

    if (row[DAP_COLS.Liquidado - 1] !== true) {
      const page = pageId ? pagesById[pageId] : null;
      const porFecha = fechaLiq && fechaLiq <= todayIso;
      const porNotion = page && _readNotionProperty(page, 'Liquidado', 'checkbox') === true;

      if (porFecha || porNotion) {
        liquidate.push({ rowIndex: rowIndex, idInterno: idInterno, reason: porFecha ? `fecha de liquidación ${fechaLiq} ya pasó` : 'Notion lo marca como liquidado' });
      } else if (row[DAP_COLS.Tipo_DAP - 1] === 'RENOVABLE' && fechaLiq) {
        const renewal = _getRenewalInfo(row);
        const check = renewal ? _validateRenewalDate(fechaLiq, renewal.fecha1, renewal.plazo) : { valid: true };
        if (!check.valid) {
          dateFixes.push({ rowIndex: rowIndex, idInterno: idInterno, from: fechaLiq, to: check.suggested, window: check.window });
        }
      }
    }

    if (!pageId) toPush.push({ rowIndex: rowIndex, idInterno: idInterno });
  }

  return { liquidate: liquidate, dateFixes: dateFixes, toPush: toPush };
}

/**
 * Núcleo del pipeline de auditoría/reparación (ver descripción del archivo).
 * @private
 * @param {boolean} apply - true para escribir en Sheet/Notion; false solo para reportar.
 */
function _repairCompletedDaps(apply) {
  const spreadsheetId = getEnv('SHARED_SPREADSHEET_ID');
  const token = getEnv('NOTION_API_TOKEN');
  const dbId = getEnv('NOTION_DAP_DATABASE_ID');
  if (!spreadsheetId || !token || !dbId) {
    console.error('❌ Reparación: Faltan SHARED_SPREADSHEET_ID, NOTION_API_TOKEN o NOTION_DAP_DATABASE_ID en las propiedades.');
    return;
  }

  const modo = apply ? 'APLICANDO' : 'SIMULACIÓN';
  const lock = LockService.getScriptLock();
  if (apply && !lock.tryLock(10000)) {
    console.warn('⚠️ Reparación: No se pudo obtener el Lock (otro proceso está corriendo). Reintenta en unos segundos.');
    return;
  }

  try {
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(CONFIG.SHEETS.DAPS);
    const todayIso = _todayIso();

    let pages = _listAllNotionPages(token, dbId);
    if (!pages) {
      console.error('❌ Reparación: No se pudieron listar las páginas de Notion; se aborta sin modificar nada.');
      return;
    }
    const pagesById = {};
    pages.forEach((page) => { pagesById[page.id] = page; });

    console.info(`🔎 [${modo}] Hoy: ${todayIso}. Notion: ${pages.length} página(s).`);

    // ---------- Sheet: a) liquidados, b) fechas fuera de ventana ----------
    let data = sheet.getDataRange().getValues();
    const plan = _planSheetFixes(data, todayIso, pagesById);

    plan.liquidate.forEach((fix) => {
      console.info(`✅ [${modo}] DAP [${fix.idInterno}] ya liquidado (${fix.reason}) → Liquidado = TRUE.`);
      if (apply) sheet.getRange(fix.rowIndex, DAP_COLS.Liquidado).setValue(true);
    });

    plan.dateFixes.forEach((fix) => {
      console.warn(`🚨 [${modo}] DAP renovable [${fix.idInterno}]: fecha de liquidación tentativa FUERA de ventana de renovación: ${fix.from} → ${fix.to} (ventana ${_formatRenewalWindow(fix.window)}).`);
      if (apply) sheet.getRange(fix.rowIndex, DAP_COLS.Fecha_Liquidacion).setValue(fix.to);
    });

    if (apply) {
      SpreadsheetApp.flush();
      data = sheet.getDataRange().getValues();
    }

    // ---------- Sheet: c) DAP sin página en Notion ----------
    plan.toPush.forEach((item) => {
      if (!apply) {
        console.info(`📤 [${modo}] DAP [${item.idInterno}] no tiene página en Notion → se enviará (si ya existe una con el mismo ID de operación, se enlazará y complementará).`);
        return;
      }
      const notionPageId = pushDapToNotion(_buildDapDtoFromRow(data[item.rowIndex - 1]));
      if (notionPageId) {
        sheet.getRange(item.rowIndex, DAP_COLS.Notion_Page_ID).setValue(notionPageId);
        console.info(`📤 DAP [${item.idInterno}] enviado a Notion (página ${notionPageId}).`);
      } else {
        console.error(`❌ DAP [${item.idInterno}]: no se pudo enviar a Notion.`);
      }
    });

    if (apply) {
      SpreadsheetApp.flush();
      pages = _listAllNotionPages(token, dbId) || pages;
      data = sheet.getDataRange().getValues();
    }

    // ---------- Notion: a) duplicados ----------
    const dedupe = _planNotionDedupe(pages);
    const relink = {};
    let archivadas = 0;
    let omitidos = 0;

    dedupe.forEach((group) => {
      const detalle = (page) => `${page.id} ("${_readNotionProperty(page, 'Objetivo', 'title') || 'Sin Objetivo'}", creada ${page.created_time || '?'})`;
      console.info(`🧹 [${modo}] ID operación ${group.idOperacion}: ${group.olds.length + 1} páginas → se conserva la más reciente ${detalle(group.survivor)}; antiguas: ${group.olds.map(detalle).join(' | ')}.`);
      group.conflicts.forEach((conflict) => console.warn(`↔️ ID operación ${group.idOperacion}: ${conflict}.`));

      if (group.skipReason) {
        omitidos++;
        console.warn(`⛔ ID operación ${group.idOperacion} OMITIDO (revisar a mano; podrían ser DAP distintos): ${group.skipReason}.`);
        return;
      }

      group.olds.forEach((old) => { relink[old.id] = group.survivor.id; });
      if (!apply) return;

      _complementExistingNotionPage(token, group.survivor, group.merged);
      group.olds.forEach((old) => {
        if (archiveNotionPage(old.id)) archivadas++;
        else delete relink[old.id];
      });
    });

    // ---------- Sheet: re-enlazar filas que apuntaban a páginas archivadas ----------
    for (let i = 1; i < data.length; i++) {
      const currentId = data[i][DAP_COLS.Notion_Page_ID - 1];
      if (currentId && relink[currentId]) {
        console.info(`🔗 [${modo}] DAP [${data[i][DAP_COLS.ID_Interno - 1]}]: Notion_Page_ID ${currentId} → ${relink[currentId]} (página conservada).`);
        if (apply) sheet.getRange(i + 1, DAP_COLS.Notion_Page_ID).setValue(relink[currentId]);
      }
    }

    // ---------- Notion: reflejar los cambios hechos en el Sheet (a y b) ----------
    if (apply) {
      SpreadsheetApp.flush();
      data = sheet.getDataRange().getValues();
    }
    const changes = {};
    plan.liquidate.forEach((fix) => { (changes[fix.rowIndex] = changes[fix.rowIndex] || {}).liquidado = true; });
    plan.dateFixes.forEach((fix) => { (changes[fix.rowIndex] = changes[fix.rowIndex] || {}).fechaLiq = fix.to; });

    Object.keys(changes).forEach((rowIndex) => {
      const row = data[Number(rowIndex) - 1];
      const idInterno = row[DAP_COLS.ID_Interno - 1];
      const pageId = row[DAP_COLS.Notion_Page_ID - 1];
      const properties = {};
      if (changes[rowIndex].liquidado) properties['Liquidado'] = { checkbox: true };
      if (changes[rowIndex].fechaLiq) properties['Fecha liquidación'] = { date: { start: changes[rowIndex].fechaLiq } };

      console.info(`📝 [${modo}] DAP [${idInterno}]: se refleja en Notion (${Object.keys(properties).join(', ')}).`);
      if (!apply) return;
      if (!pageId || !patchNotionPageProperties(pageId, properties)) {
        console.error(`❌ DAP [${idInterno}]: no se pudo reflejar el cambio en Notion (sin página o error de API).`);
      }
    });

    console.info(`✅ Reparación [${modo}] terminada: ${plan.liquidate.length} DAP a marcar liquidados, ${plan.dateFixes.length} 🚨 fecha(s) fuera de ventana, ${plan.toPush.length} sin página en Notion, ${dedupe.length} ID(s) duplicado(s) (${omitidos} omitido(s)${apply ? `, ${archivadas} página(s) archivada(s)` : ''}).`);
  } finally {
    if (apply) lock.releaseLock();
  }
}
