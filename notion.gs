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
  const token = getEnv('NOTION_API_TOKEN');
  
  if (!token || !pageId) {
    console.error('❌ Notion API: Falta Token o Page ID para actualizar el estado.');
    return false;
  }

  const url = `https://api.notion.com/v1/pages/${pageId}`;
  
  // Enviamos SOLO la propiedad que queremos mutar
  const payload = {
    properties: {
      "Liquidado": { checkbox: true }
    }
  };

  const options = {
    method: 'patch',
    headers: _getNotionHeaders(token),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const res = _fetchWithRetry(url, options);
  if (!res) return false;

  const code = res.getResponseCode();
  if (code === 200) {
    console.info(`✅ Notion: DAP [${pageId}] marcado como liquidado remotamente.`);
    return true;
  } else {
    console.error(`❌ Error Notion API (PATCH): Código ${code} - ${res.getContentText()}`);
    return false;
  }
}