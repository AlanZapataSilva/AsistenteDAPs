/**
 * @fileoverview uf.gs - Valor de la UF (API CMF) y conversión de DAP en UF a pesos.
 */

'use strict';

/**
 * Obtiene el valor de la UF en pesos para una fecha, desde la API de la CMF.
 * Requiere la propiedad de script `CMF_API_KEY`. Cachea el resultado (el valor histórico
 * de una fecha no cambia) para no repetir consultas.
 * @param {string} isoDate - Fecha en formato YYYY-MM-DD.
 * @returns {number|null} Valor de la UF en CLP, o null si no hay clave o la consulta falla.
 */
function getUfValue(isoDate) {
  const apiKey = getEnv('CMF_API_KEY');
  if (!apiKey) {
    console.error('❌ UF: Falta la propiedad CMF_API_KEY en las propiedades del script.');
    return null;
  }

  const parts = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) {
    console.error(`❌ UF: Fecha inválida para consultar la UF: "${isoDate}".`);
    return null;
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = `UF_${isoDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return parseFloat(cached);

  const url = `https://api.cmfchile.cl/api-sbifv3/recursos_api/uf/${parts[1]}/${parts[2]}/dias/${parts[3]}?apikey=${encodeURIComponent(apiKey)}&formato=json`;
  const res = _fetchWithRetry(url, { method: 'get', muteHttpExceptions: true });
  if (!res) return null;

  const code = res.getResponseCode();
  if (code !== 200) {
    console.error(`❌ UF: La API de la CMF respondió ${code} para la fecha ${isoDate}.`);
    return null;
  }

  let valor = NaN;
  try {
    const json = JSON.parse(res.getContentText());
    valor = _parseChileanNumber(json.UFs[0].Valor);
  } catch (error) {
    console.error(`❌ UF: Respuesta inesperada de la CMF para ${isoDate}: ${error.message}`);
    return null;
  }

  if (!(valor > 0)) {
    console.error(`❌ UF: Valor de UF inválido para ${isoDate}.`);
    return null;
  }

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
