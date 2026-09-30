/**
 * @fileoverview notion.gs - Integración de escritura con Notion API
 */

'use strict';

/**
 * Genera los encabezados estándar requeridos por la API de Notion.
 * @private
 * @param {string} token - Token de integración de Notion (Bearer).
 * @returns {Object} Cabeceras HTTP listas para UrlFetchApp.
 */
function _getNotionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
}

/**
 * Busca en la base de datos de Notion una página cuyo "ID operación" coincida.
 * @private
 * @param {string} token - Token de integración de Notion.
 * @param {string} dbId - ID de la base de datos de Notion.
 * @param {number} idOperacion - Número de operación del DAP a buscar.
 * @returns {Object|null} El objeto de página de Notion (id + properties), o null si no
 *   existe ninguna coincidencia o si la consulta falla (en cuyo caso se asume que no existe
 *   y se procede a crear, para no bloquear el flujo por un error transitorio).
 */
function _findNotionPageByOperacion(token, dbId, idOperacion) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  const payload = {
    filter: { property: 'ID operación', number: { equals: idOperacion } },
    page_size: 1
  };

  const options = {
    method: 'post',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const res = _fetchWithRetry(url, options);
  if (!res) return null;

  const code = res.getResponseCode();
  if (code !== 200) {
    console.warn(`⚠️ Notion: No se pudo verificar si el DAP [${idOperacion}] ya existía (código ${code}). Se intentará crear de todas formas.`);
    return null;
  }

  const jsonRes = JSON.parse(res.getContentText());
  return (jsonRes.results && jsonRes.results.length > 0) ? jsonRes.results[0] : null;
}

/**
 * Lee el valor actual de una propiedad simple de una página de Notion.
 * @private
 * @param {Object} page - Objeto de página de Notion (con `.properties`).
 * @param {string} propName - Nombre de la propiedad tal como está en el esquema de Notion.
 * @param {string} type - Tipo de propiedad: 'number' | 'checkbox' | 'date' | 'select' | 'title'.
 * @returns {*} El valor actual, o null si está vacía/ausente.
 */
function _readNotionProperty(page, propName, type) {
  const prop = page.properties && page.properties[propName];
  if (!prop) return null;

  switch (type) {
    case 'number': return (prop.number === undefined) ? null : prop.number;
    case 'checkbox': return Boolean(prop.checkbox);
    case 'date': return prop.date ? prop.date.start : null;
    case 'select': return prop.select ? prop.select.name : null;
    case 'title': return (prop.title && prop.title[0]) ? prop.title[0].plain_text : null;
    default: return null;
  }
}

/**
 * Lista todas las páginas de la base de datos de Notion (paginado de a 100).
 * @private
 * @param {string} token - Token de integración de Notion.
 * @param {string} dbId - ID de la base de datos de Notion.
 * @returns {Object[]|null} Páginas (id + properties), o null si alguna consulta falla.
 */
function _listAllNotionPages(token, dbId) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  const pages = [];
  let cursor = null;

  for (let i = 0; i < 100; i++) {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;

    const res = _fetchWithRetry(url, {
      method: 'post',
      headers: _getNotionHeaders(token),
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (!res || res.getResponseCode() !== 200) return null;

    const json = JSON.parse(res.getContentText());
    pages.push(...(json.results || []));
    if (!json.has_more) return pages;
    cursor = json.next_cursor;
  }

  return pages;
}

/**
 * Crea (o complementa, si ya existe por "ID operación") un registro de DAP en Notion.
 * Evita duplicados: si ya existe una página con el mismo número de operación (por ejemplo,
 * al reprocesar correos históricos con `backfillDapEmails()`), no crea una página nueva, sino
 * que completa únicamente los campos vacíos en Notion —y sube "Liquidado" a `true` si
 * corresponde— sin pisar nunca datos ya presentes.
 * @param {DapDTO} dap - Objeto estructurado con los datos del depósito.
 * @returns {string|null} El ID de la página (nueva o ya existente) en Notion, o null si falla.
 */
function pushDapToNotion(dap) {
  const token = getEnv('NOTION_API_TOKEN');
  const dbId = getEnv('NOTION_DAP_DATABASE_ID');

  if (!token || !dbId) {
    console.error('❌ Notion API: Faltan credenciales (Token o Database ID).');
    return null;
  }

  const idOperacion = parseInt(dap.ID_Operacion, 10);
  const existingPage = _findNotionPageByOperacion(token, dbId, idOperacion);

  if (existingPage) {
    return _complementExistingNotionPage(token, existingPage, dap);
  }

  return _createNotionPage(token, dbId, dap);
}

/**
 * Crea una página nueva en la base de datos de Notion.
 * @private
 */
function _createNotionPage(token, dbId, dap) {
  const url = 'https://api.notion.com/v1/pages';

  // Mapeo exacto al esquema de la base de datos
  const payload = {
    parent: { database_id: dbId },
    properties: {
      "Objetivo": { title: [{ text: { content: dap.Objetivo || "Sin Objetivo" } }] },
      "ID operación": { number: parseInt(dap.ID_Operacion, 10) },
      "Monto": { number: dap.Monto },
      "Tipo DAP": { select: { name: dap.Tipo_DAP } },
      "Fecha inicio": { date: { start: dap.Fecha_Inicio } },
      "Fecha vencimiento": { date: { start: dap.Fecha_Vencimiento } },
      "Liquidado": { checkbox: Boolean(dap.Liquidado) }
    }
  };

  // Agregar la fecha de liquidación solo si existe para no enviar campos vacíos
  if (dap.Fecha_Liquidacion) {
    payload.properties["Fecha liquidación"] = { date: { start: dap.Fecha_Liquidacion } };
  }

  const options = {
    method: 'post',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const res = _fetchWithRetry(url, options);
  if (!res) return null;

  const code = res.getResponseCode();
  if (code === 200) {
    const jsonRes = JSON.parse(res.getContentText());
    console.info(`✅ Notion: DAP [${dap.ID_Operacion}] creado correctamente.`);
    return jsonRes.id; // Retorna el Notion Page ID (ej. 13ef5...)
  } else {
    console.error(`❌ Error Notion API (POST): Código ${code} - ${res.getContentText()}`);
    return null;
  }
}

/**
 * Complementa una página de Notion ya existente con los datos que le falten, sin pisar
 * valores ya presentes. "Liquidado" solo se sube de false a true, nunca al revés.
 * @private
 * @returns {string} El ID de la página existente (el PATCH puede fallar sin que esto afecte
 *   el retorno, ya que la página en sí ya existe).
 */
function _complementExistingNotionPage(token, existingPage, dap) {
  const patchProps = {};

  if (dap.Liquidado === true && _readNotionProperty(existingPage, 'Liquidado', 'checkbox') !== true) {
    patchProps["Liquidado"] = { checkbox: true };
  }

  const currentObjetivo = _readNotionProperty(existingPage, 'Objetivo', 'title');
  if (dap.Objetivo && (!currentObjetivo || currentObjetivo === 'Sin Objetivo')) {
    patchProps["Objetivo"] = { title: [{ text: { content: dap.Objetivo } }] };
  }

  if (dap.Fecha_Liquidacion && !_readNotionProperty(existingPage, 'Fecha liquidación', 'date')) {
    patchProps["Fecha liquidación"] = { date: { start: dap.Fecha_Liquidacion } };
  }

  const currentMonto = _readNotionProperty(existingPage, 'Monto', 'number');
  if ((dap.Monto || dap.Monto === 0) && currentMonto === null) {
    patchProps["Monto"] = { number: dap.Monto };
  }

  if (dap.Tipo_DAP && !_readNotionProperty(existingPage, 'Tipo DAP', 'select')) {
    patchProps["Tipo DAP"] = { select: { name: dap.Tipo_DAP } };
  }

  if (dap.Fecha_Inicio && !_readNotionProperty(existingPage, 'Fecha inicio', 'date')) {
    patchProps["Fecha inicio"] = { date: { start: dap.Fecha_Inicio } };
  }

  if (dap.Fecha_Vencimiento && !_readNotionProperty(existingPage, 'Fecha vencimiento', 'date')) {
    patchProps["Fecha vencimiento"] = { date: { start: dap.Fecha_Vencimiento } };
  }

  if (Object.keys(patchProps).length === 0) {
    console.info(`ℹ️ Notion: DAP [${dap.ID_Operacion}] ya existía y no requería cambios.`);
    return existingPage.id;
  }

  const url = `https://api.notion.com/v1/pages/${existingPage.id}`;
  const options = {
    method: 'patch',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify({ properties: patchProps }),
    muteHttpExceptions: true
  };

  const res = _fetchWithRetry(url, options);
  if (!res || res.getResponseCode() !== 200) {
    console.error(`❌ Notion: DAP [${dap.ID_Operacion}] ya existía pero falló al complementar campos.`);
    return existingPage.id;
  }

  console.info(`✅ Notion: DAP [${dap.ID_Operacion}] ya existía; se complementaron sus campos vacíos.`);
  return existingPage.id;
}

/**
 * Actualiza el estado de un DAP existente en Notion a "Liquidado".
 * Utiliza el método PATCH para mutar un solo campo sin afectar los demás.
 * @param {string} pageId - El ID único de la página en Notion.
 * @returns {boolean} true si la mutación fue exitosa, false si falló.
 */
function updateNotionDapStatus(pageId) {
  return patchNotionPageProperties(pageId, { "Liquidado": { checkbox: true } });
}

/**
 * Sobrescribe el campo "Monto" (en CLP) de una página de Notion. Solo lo usa la reparación
 * manual de DAP en UF; el upsert normal (`pushDapToNotion`) nunca pisa valores existentes.
 * @param {string} pageId - El ID único de la página en Notion.
 * @param {number} monto - Monto en CLP.
 * @returns {boolean} true si la mutación fue exitosa, false si falló.
 */
function updateNotionDapAmount(pageId, monto) {
  return patchNotionPageProperties(pageId, { "Monto": { number: monto } });
}

/**
 * Aplica un PATCH a las propiedades indicadas de una página de Notion (solo esas se modifican).
 * @param {string} pageId - El ID único de la página en Notion.
 * @param {Object} properties - Propiedades a mutar, en el formato de la API de Notion.
 * @returns {boolean} true si la mutación fue exitosa, false si falló.
 */
function patchNotionPageProperties(pageId, properties) {
  const token = getEnv('NOTION_API_TOKEN');

  if (!token || !pageId) {
    console.error('❌ Notion API: Falta Token o Page ID para actualizar la página.');
    return false;
  }

  const url = `https://api.notion.com/v1/pages/${pageId}`;

  const options = {
    method: 'patch',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify({ properties: properties }),
    muteHttpExceptions: true
  };

  const res = _fetchWithRetry(url, options);
  if (!res) return false;

  const code = res.getResponseCode();
  if (code === 200) {
    console.info(`✅ Notion: página [${pageId}] actualizada (${Object.keys(properties).join(', ')}).`);
    return true;
  } else {
    console.error(`❌ Error Notion API (PATCH): Código ${code} - ${res.getContentText()}`);
    return false;
  }
}
/**
 * Construye el DTO que se envía a Notion a partir de una fila de la hoja DAPs.
 * @private
 * @param {Array} row - Fila de la hoja (valores de getValues).
 * @returns {Object} DTO con fechas ISO (`Fecha_Liquidacion` es null si está vacía).
 */
function _buildDapDtoFromRow(row) {
  return {
    ID_Interno: row[DAP_COLS.ID_Interno - 1],
    ID_Operacion: row[DAP_COLS.ID_Operacion - 1],
    Monto: row[DAP_COLS.Monto - 1],
    Tipo_DAP: row[DAP_COLS.Tipo_DAP - 1],
    Fecha_Inicio: _toIsoDate(row[DAP_COLS.Fecha_Inicio - 1]),
    Fecha_Vencimiento: _toIsoDate(row[DAP_COLS.Fecha_Vencimiento - 1]),
    Objetivo: row[DAP_COLS.Objetivo - 1],
    Fecha_Liquidacion: _toIsoDate(row[DAP_COLS.Fecha_Liquidacion - 1]) || null,
    Liquidado: row[DAP_COLS.Liquidado - 1]
  };
}

/**
 * Archiva una página de Notion (queda en la papelera de Notion y es restaurable desde ahí;
 * no se borra de forma permanente).
 * @param {string} pageId - El ID único de la página en Notion.
 * @returns {boolean} true si se archivó, false si falló.
 */
function archiveNotionPage(pageId) {
  const token = getEnv('NOTION_API_TOKEN');
  if (!token || !pageId) {
    console.error('❌ Notion API: Falta Token o Page ID para archivar la página.');
    return false;
  }

  const res = _fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'patch',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify({ archived: true }),
    muteHttpExceptions: true
  });
  if (!res) return false;

  if (res.getResponseCode() === 200) {
    console.info(`🗄️ Notion: página [${pageId}] archivada.`);
    return true;
  }
  console.error(`❌ Error Notion API (archivar): Código ${res.getResponseCode()} - ${res.getContentText()}`);
  return false;
}

/**
 * Convierte una página de Notion a un DTO con los mismos nombres de campo que usa el Sheet.
 * Los campos vacíos quedan en null.
 * @private
 * @param {Object} page - Página de Notion (id + properties).
 * @returns {Object} DTO de la página.
 */
function _notionPageToDap(page) {
  const objetivo = _readNotionProperty(page, 'Objetivo', 'title');
  return {
    Objetivo: (objetivo && objetivo !== 'Sin Objetivo') ? objetivo : null,
    Monto: _readNotionProperty(page, 'Monto', 'number'),
    Tipo_DAP: _readNotionProperty(page, 'Tipo DAP', 'select'),
    Fecha_Inicio: _readNotionProperty(page, 'Fecha inicio', 'date'),
    Fecha_Vencimiento: _readNotionProperty(page, 'Fecha vencimiento', 'date'),
    Fecha_Liquidacion: _readNotionProperty(page, 'Fecha liquidación', 'date'),
    Liquidado: _readNotionProperty(page, 'Liquidado', 'checkbox') === true
  };
}

/**
 * Planifica la deduplicación de páginas de Notion por "ID operación". Por cada grupo con más de
 * una página: se conserva la MÁS RECIENTE (`created_time`), y de las antiguas se toma solo la
 * información que a la conservada le falte (`merged`, en orden de la más nueva a la más vieja).
 * Un grupo se marca con `skipReason` (y no debe archivarse automáticamente) si las páginas
 * traen valores DISTINTOS de Monto, tipo o fechas de inicio/vencimiento, porque entonces
 * probablemente no son el mismo DAP. Diferencias solo de Objetivo se informan en `conflicts`
 * pero no bloquean (se conserva el Objetivo de la más reciente).
 * @private
 * @param {Object[]} pages - Páginas de Notion (id, created_time, properties).
 * @returns {{idOperacion: number, survivor: Object, olds: Object[], merged: Object, conflicts: string[], skipReason: string|null}[]}
 */
function _planNotionDedupe(pages) {
  const groups = {};
  pages.forEach((page) => {
    const idOperacion = _readNotionProperty(page, 'ID operación', 'number');
    if (idOperacion === null) return;
    (groups[idOperacion] = groups[idOperacion] || []).push(page);
  });

  const hasValue = (v) => v !== null && v !== undefined && v !== '';

  return Object.keys(groups)
    .filter((key) => groups[key].length > 1)
    .map((key) => {
      const sorted = groups[key].slice().sort((a, b) => String(b.created_time || '').localeCompare(String(a.created_time || '')));
      const survivor = sorted[0];
      const olds = sorted.slice(1);
      const survivorDap = _notionPageToDap(survivor);
      const merged = { ID_Operacion: key };
      const conflicts = [];
      let skipReason = null;

      olds.forEach((old) => {
        const oldDap = _notionPageToDap(old);

        ['Monto', 'Tipo_DAP', 'Fecha_Inicio', 'Fecha_Vencimiento'].forEach((field) => {
          if (hasValue(survivorDap[field]) && hasValue(oldDap[field]) && survivorDap[field] !== oldDap[field]) {
            skipReason = skipReason || `${field} distinto entre páginas (${survivorDap[field]} vs ${oldDap[field]})`;
          }
        });

        if (hasValue(survivorDap.Objetivo) && hasValue(oldDap.Objetivo) && survivorDap.Objetivo !== oldDap.Objetivo) {
          conflicts.push(`Objetivo "${oldDap.Objetivo}" se descarta; se conserva "${survivorDap.Objetivo}"`);
        }

        ['Objetivo', 'Monto', 'Tipo_DAP', 'Fecha_Inicio', 'Fecha_Vencimiento', 'Fecha_Liquidacion'].forEach((field) => {
          if (!hasValue(merged[field]) && hasValue(oldDap[field])) merged[field] = oldDap[field];
        });
        if (oldDap.Liquidado) merged.Liquidado = true;
      });

      return { idOperacion: Number(key), survivor: survivor, olds: olds, merged: merged, conflicts: conflicts, skipReason: skipReason };
    });
}
