/**
 * @fileoverview utils.gs - Utilidades compartidas de bajo nivel.
 */

'use strict';

/**
 * Ejecuta UrlFetchApp.fetch con reintentos ante fallos transitorios.
 * Reintenta ante excepciones de red o respuestas 5xx (errores del servidor remoto);
 * NO reintenta ante 4xx, ya que indican un error de configuración (token, payload)
 * que no se resuelve reintentando.
 * @param {string} url - URL de destino.
 * @param {Object} options - Opciones para UrlFetchApp.fetch (debe incluir muteHttpExceptions: true).
 * @param {number} [maxRetries=2] - Número máximo de reintentos adicionales al primer intento.
 * @returns {GoogleAppsScript.URL_Fetch.HTTPResponse|null} Respuesta HTTP, o null si todos los intentos fallan.
 */
function _fetchWithRetry(url, options, maxRetries) {
  const retries = typeof maxRetries === 'number' ? maxRetries : 2;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();

      if (code < 500) {
        return response;
      }

      lastError = `HTTP ${code}`;
    } catch (error) {
      lastError = error.message;
    }

    if (attempt < retries) {
      console.warn(`⚠️ _fetchWithRetry: Intento ${attempt + 1} falló (${lastError}). Reintentando...`);
      Utilities.sleep(500 * (attempt + 1));
    }
  }

  console.error(`❌ _fetchWithRetry: Todos los intentos fallaron para ${url}. Último error: ${lastError}`);
  return null;
}
