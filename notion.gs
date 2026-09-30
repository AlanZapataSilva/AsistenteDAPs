/**
 * @fileoverview notion.gs - Integración de escritura con Notion API
 */

'use strict';

/**
 * Genera los encabezados estándar requeridos por la API de Notion.
 * @private
 * @param {string} token - Token de integración de Notion (Bearer).
 * @returns {Object<string, string>} Cabeceras HTTP listas para UrlFetchApp.
 */
function _getNotionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': CONFIG.NOTION.VERSION
  };
}

/**
 * Busca en la base de datos de Notion la página cuyo "ID operación" coincida. Si hubiera
 * duplicadas, devuelve la MÁS RECIENTE (misma política que la deduplicación).
 * @private
 * @param {string} token - Token de integración de Notion.
 * @param {string} dbId - ID de la base de datos de Notion.
 * @param {number} idOperacion - Número de operación del DAP a buscar.
 * @returns {Object|null} El objeto de página de Notion (id + properties), o null si no
 *   existe ninguna coincidencia o si la consulta falla (en cuyo caso se asume que no existe
 *   y se procede a crear, para no bloquear el flujo por un error transitorio).
 */
function _findNotionPageByOperacion(token, dbId, idOperacion) {
  if (!Number.isFinite(idOperacion)) {
    console.warn('⚠️ Notion: ID de operación no numérico; no se puede buscar una página existente.');
    return null;
  }

  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  const payload = {
    filter: { property: CONFIG.NOTION.PROPS.ID_OPERACION, number: { equals: idOperacion } },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    page_size: 1
  };

  const res = _fetchWithRetry(url, {
    method: 'post',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
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
 * @param {'number'|'checkbox'|'date'|'select'|'title'} type - Tipo de propiedad.
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
    Liquidado: _isChecked(row[DAP_COLS.Liquidado - 1])
  };
}

/**
 * Crea (o complementa, si ya existe por "ID operación") un registro de DAP en Notion.
 * Evita duplicados: si ya existe una página con el mismo número de operación, no crea una
 * página nueva, sino que completa únicamente los campos vacíos en Notion —y sube "Liquidado" a
 * `true` si corresponde— sin pisar nunca datos ya presentes.
 * @param {Object} dap - DTO del depósito (ver `_buildDapDtoFromRow`).
 * @returns {string|null} El ID de la página (nueva o ya existente) en Notion, o null si falla.
 */
function pushDapToNotion(dap) {
  const token = getEnv('NOTION_API_TOKEN');
  const dbId = getEnv('NOTION_DAP_DATABASE_ID');

  if (!token || !dbId) {
    console.error('❌ Notion API: Faltan credenciales (Token o Database ID).');
    return null;
  }

  const idOperacion = _normalizeOperationId(dap.ID_Operacion);
  const existingPage = _findNotionPageByOperacion(token, dbId, idOperacion);

  if (existingPage) {
    return _complementExistingNotionPage(token, existingPage, dap).id;
  }

  return _createNotionPage(token, dbId, dap);
}

/**
 * Crea una página nueva en la base de datos de Notion.
 * @private
 * @param {string} token - Token de integración de Notion.
 * @param {string} dbId - ID de la base de datos de Notion.
 * @param {Object} dap - DTO del depósito.
 * @returns {string|null} ID de la página creada, o null si falla.
 */
function _createNotionPage(token, dbId, dap) {
  const P = CONFIG.NOTION.PROPS;
  const idOperacion = _normalizeOperationId(dap.ID_Operacion);
  if (!Number.isFinite(idOperacion)) {
    console.error(`❌ Notion: No se crea la página: ID de operación inválido ("${dap.ID_Operacion}").`);
    return null;
  }

  // Mapeo exacto al esquema de la base de datos. El título de Notion admite hasta 2000 caracteres.
  const payload = {
    parent: { database_id: dbId },
    properties: {
      [P.OBJETIVO]: { title: [{ text: { content: _truncate(dap.Objetivo || 'Sin Objetivo', 2000) } }] },
      [P.ID_OPERACION]: { number: idOperacion },
      [P.MONTO]: { number: dap.Monto },
      [P.TIPO]: { select: { name: dap.Tipo_DAP } },
      [P.FECHA_INICIO]: { date: { start: dap.Fecha_Inicio } },
      [P.FECHA_VENCIMIENTO]: { date: { start: dap.Fecha_Vencimiento } },
      [P.LIQUIDADO]: { checkbox: Boolean(dap.Liquidado) }
    }
  };

  // Agregar la fecha de liquidación solo si existe para no enviar campos vacíos
  if (dap.Fecha_Liquidacion) {
    payload.properties[P.FECHA_LIQUIDACION] = { date: { start: dap.Fecha_Liquidacion } };
  }

  const res = _fetchWithRetry('https://api.notion.com/v1/pages', {
    method: 'post',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (!res) return null;

  const code = res.getResponseCode();
  if (code === 200) {
    const jsonRes = JSON.parse(res.getContentText());
    console.info(`✅ Notion: DAP [${dap.ID_Operacion}] creado correctamente.`);
    return jsonRes.id; // Retorna el Notion Page ID (ej. 13ef5...)
  }

  console.error(`❌ Error Notion API (POST): Código ${code} - ${res.getContentText()}`);
  return null;
}

/**
 * Complementa una página de Notion ya existente con los datos que le falten, sin pisar
 * valores ya presentes. "Liquidado" solo se sube de false a true, nunca al revés.
 * @private
 * @param {string} token - Token de integración de Notion.
 * @param {Object} existingPage - Página existente (id + properties).
 * @param {Object} dap - DTO con los datos a complementar (campos ausentes se ignoran).
 * @returns {{id: string, ok: boolean, changed: boolean}} `id` de la página existente; `ok` es false si
 *   el PATCH de complemento falló (la página existe igualmente); `changed` indica si había algo que complementar.
 */
function _complementExistingNotionPage(token, existingPage, dap) {
  const P = CONFIG.NOTION.PROPS;
  const patchProps = {};

  if (dap.Liquidado === true && _readNotionProperty(existingPage, P.LIQUIDADO, 'checkbox') !== true) {
    patchProps[P.LIQUIDADO] = { checkbox: true };
  }

  const currentObjetivo = _readNotionProperty(existingPage, P.OBJETIVO, 'title');
  if (dap.Objetivo && (!currentObjetivo || currentObjetivo === 'Sin Objetivo')) {
    patchProps[P.OBJETIVO] = { title: [{ text: { content: _truncate(dap.Objetivo, 2000) } }] };
  }

  if (dap.Fecha_Liquidacion && !_readNotionProperty(existingPage, P.FECHA_LIQUIDACION, 'date')) {
    patchProps[P.FECHA_LIQUIDACION] = { date: { start: dap.Fecha_Liquidacion } };
  }

  const currentMonto = _readNotionProperty(existingPage, P.MONTO, 'number');
  if ((dap.Monto || dap.Monto === 0) && currentMonto === null) {
    patchProps[P.MONTO] = { number: dap.Monto };
  }

  if (dap.Tipo_DAP && !_readNotionProperty(existingPage, P.TIPO, 'select')) {
    patchProps[P.TIPO] = { select: { name: dap.Tipo_DAP } };
  }

  if (dap.Fecha_Inicio && !_readNotionProperty(existingPage, P.FECHA_INICIO, 'date')) {
    patchProps[P.FECHA_INICIO] = { date: { start: dap.Fecha_Inicio } };
  }

  if (dap.Fecha_Vencimiento && !_readNotionProperty(existingPage, P.FECHA_VENCIMIENTO, 'date')) {
    patchProps[P.FECHA_VENCIMIENTO] = { date: { start: dap.Fecha_Vencimiento } };
  }

  if (Object.keys(patchProps).length === 0) {
    console.info(`ℹ️ Notion: DAP [${dap.ID_Operacion}] ya existía y no requería cambios.`);
    return { id: existingPage.id, ok: true, changed: false };
  }

  if (!patchNotionPageProperties(existingPage.id, patchProps)) {
    console.error(`❌ Notion: DAP [${dap.ID_Operacion}] ya existía pero falló al complementar campos.`);
    return { id: existingPage.id, ok: false, changed: true };
  }

  console.info(`✅ Notion: DAP [${dap.ID_Operacion}] ya existía; se complementaron sus campos vacíos.`);
  return { id: existingPage.id, ok: true, changed: true };
}

/**
 * Actualiza el estado de un DAP existente en Notion a "Liquidado".
 * Utiliza el método PATCH para mutar un solo campo sin afectar los demás.
 * @param {string} pageId - El ID único de la página en Notion.
 * @returns {boolean} true si la mutación fue exitosa, false si falló.
 */
function updateNotionDapStatus(pageId) {
  return patchNotionPageProperties(pageId, { [CONFIG.NOTION.PROPS.LIQUIDADO]: { checkbox: true } });
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

  const res = _fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'patch',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify({ properties: properties }),
    muteHttpExceptions: true
  });
  if (!res) return false;

  const code = res.getResponseCode();
  if (code === 200) {
    console.info(`✅ Notion: página [${pageId}] actualizada (${Object.keys(properties).join(', ')}).`);
    return true;
  }

  console.error(`❌ Error Notion API (PATCH): Código ${code} - ${res.getContentText()}`);
  return false;
}

/**
 * Verifica que la base de datos de Notion tenga las propiedades esperadas con el tipo correcto
 * (si alguien renombra o cambia una propiedad, las escrituras empiezan a fallar con 400).
 * @param {string} token - Token de integración de Notion.
 * @param {string} dbId - ID de la base de datos de Notion.
 * @returns {string[]} Problemas encontrados (lista vacía si el esquema es correcto).
 */
function _validateNotionSchema(token, dbId) {
  const res = _fetchWithRetry(`https://api.notion.com/v1/databases/${dbId}`, {
    method: 'get',
    headers: _getNotionHeaders(token),
    muteHttpExceptions: true
  });
  if (!res) return ['No se pudo consultar la base de datos de Notion (sin respuesta).'];
  if (res.getResponseCode() !== 200) return [`Notion respondió ${res.getResponseCode()} al leer la base de datos.`];

  const properties = (JSON.parse(res.getContentText()).properties) || {};
  const problems = [];

  Object.keys(CONFIG.NOTION.PROP_TYPES).forEach((name) => {
    const expected = CONFIG.NOTION.PROP_TYPES[name];
    if (!properties[name]) problems.push(`Falta la propiedad "${name}" (${expected}).`);
    else if (properties[name].type !== expected) problems.push(`La propiedad "${name}" es ${properties[name].type} y debería ser ${expected}.`);
  });

  return problems;
}
