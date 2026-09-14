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
 * Crea un nuevo registro de DAP en la base de datos de Notion.
 * @param {DapDTO} dap - Objeto estructurado con los datos del depósito.
 * @returns {string|null} El ID de la página creada en Notion, o null si falla.
 */
function pushDapToNotion(dap) {
  const token = getEnv('NOTION_API_TOKEN');
  const dbId = getEnv('NOTION_DAP_DATABASE_ID');
  
  if (!token || !dbId) {
    console.error('❌ Notion API: Faltan credenciales (Token o Database ID).');
    return null;
  }

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
    console.info(`✅ Notion: DAP [${dap.ID_Operacion}] sincronizado correctamente.`);
    return jsonRes.id; // Retorna el Notion Page ID (ej. 13ef5...)
  } else {
    console.error(`❌ Error Notion API (POST): Código ${code} - ${res.getContentText()}`);
    return null;
  }
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