/**
 * @fileoverview uf.gs - Valor de la UF (API CMF con respaldo en mindicador.cl) y conversión de
 * DAP en UF a pesos.
 */

'use strict';

/** Fallos consecutivos de ambos proveedores tras los cuales se alerta al administrador. */
const _UF_FAILURES_BEFORE_ALERT = 3;

/**
 * Consulta el valor de la UF de una fecha en la API de la CMF (proveedor principal).
 * @private
 * @param {string} isoDate - Fecha ISO (YYYY-MM-DD).
 * @returns {number|null} Valor de la UF en CLP, o null si falta la clave o la consulta falla.
 */
function _getUfFromCmf(isoDate) {
  const apiKey = getEnv('CMF_API_KEY');
  if (!apiKey) {
    console.error('❌ UF: Falta la propiedad CMF_API_KEY en las propiedades del script.');
    return null;
  }

  const parts = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const url = `https://api.cmfchile.cl/api-sbifv3/recursos_api/uf/${parts[1]}/${parts[2]}/dias/${parts[3]}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const res = _fetchWithRetry(url, { method: 'get', muteHttpExceptions: true });
  if (!res) return null;

  if (res.getResponseCode() !== 200) {
    console.error(`❌ UF: La API de la CMF respondió ${res.getResponseCode()} para la fecha ${isoDate}.`);
    return null;
  }

  try {
    const valor = _parseChileanNumber(JSON.parse(res.getContentText()).UFs[0].Valor);
    return valor > 0 ? valor : null;
  } catch (error) {
    console.error(`❌ UF: Respuesta inesperada de la CMF para ${isoDate}: ${error.message}`);
    return null;
  }
}

/**
 * Consulta el valor de la UF de una fecha en mindicador.cl (proveedor de respaldo, sin clave).
 * Acepta las dos formas de respuesta conocidas de la API (`serie[0].valor` o `valor`).
 * @private
 * @param {string} isoDate - Fecha ISO (YYYY-MM-DD).
 * @returns {number|null} Valor de la UF en CLP, o null si la consulta falla.
 */
function _getUfFromMindicador(isoDate) {
  const parts = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const res = _fetchWithRetry(`https://mindicador.cl/api/uf/${parts[3]}-${parts[2]}-${parts[1]}`, { method: 'get', muteHttpExceptions: true });
  if (!res || res.getResponseCode() !== 200) return null;

  try {
    const json = JSON.parse(res.getContentText());
    const valor = Number(json.serie && json.serie[0] ? json.serie[0].valor : json.valor);
    return valor > 0 ? valor : null;
  } catch (error) {
    console.error(`❌ UF: Respuesta inesperada de mindicador.cl para ${isoDate}: ${error.message}`);
    return null;
  }
}

/**
 * Obtiene el valor de la UF en pesos para una fecha. Usa la API de la CMF (requiere la propiedad
 * de script `CMF_API_KEY`) y, si falla, el respaldo de mindicador.cl. Cachea el resultado (el
 * valor histórico de una fecha no cambia) y alerta al administrador tras varios fallos seguidos.
 * @param {string} isoDate - Fecha en formato YYYY-MM-DD.
 * @returns {number|null} Valor de la UF en CLP, o null si ambos proveedores fallan.
 */
function getUfValue(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate))) {
    console.error(`❌ UF: Fecha inválida para consultar la UF: "${isoDate}".`);
    return null;
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = `UF_${isoDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return parseFloat(cached);

  let valor = _getUfFromCmf(isoDate);
  if (!valor) {
    valor = _getUfFromMindicador(isoDate);
    if (valor) console.warn(`⚠️ UF: Se usó el proveedor de respaldo (mindicador.cl) para ${isoDate}.`);
  }

  const props = PropertiesService.getScriptProperties();
  if (!valor) {
    const failures = (parseInt(props.getProperty('UF_FAILURES') || '0', 10)) + 1;
    props.setProperty('UF_FAILURES', String(failures));
    if (failures >= _UF_FAILURES_BEFORE_ALERT) {
      _alertAdmin('UF_DOWN', `No se puede obtener el valor de la UF (${failures} fallos seguidos, CMF y respaldo). Los DAP en UF quedan sin encolar hasta que se recupere.`);
    }
    return null;
  }

  props.setProperty('UF_FAILURES', '0');
  cache.put(cacheKey, String(valor), 21600);
  return valor;
}

/**
 * Completa el monto en CLP de un DAP. Para CLP no hace nada; para UF consulta el valor de la
 * UF a la fecha de captación y calcula `Monto = round(Monto_Original * valorUF)`.
 * @private
 * @param {DapDTO} dapDto - DTO devuelto por `parseBciDapEmail` (se modifica in situ).
 * @returns {boolean} true si el DTO quedó con `Monto` en CLP; false si no se pudo convertir.
 */
function _enrichWithClpAmount(dapDto) {
  if (dapDto.Moneda !== 'UF') return true;

  const valorUF = getUfValue(dapDto.Fecha_Inicio);
  if (!valorUF) {
    console.error(`❌ UF: No se pudo convertir el DAP [${dapDto.ID_Operacion}] (UF ${dapDto.Monto_Original}) a pesos.`);
    return false;
  }

  dapDto.Valor_UF = valorUF;
  dapDto.Monto = Math.round(dapDto.Monto_Original * valorUF);
  return true;
}
