'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Carga un archivo .gs (script plano, no CommonJS) en un sandbox de Node usando `vm`,
 * inyectando los globals de Apps Script necesarios como stubs/mocks.
 * @param {string} relativePath - Ruta del .gs relativa a la raíz del proyecto (ej. 'dap_parser.gs').
 * @param {Object} [globals] - Globals adicionales/stubs a exponer dentro del sandbox.
 * @returns {Object} El sandbox, con las funciones/constantes definidas por el .gs como propiedades.
 */
function loadGasFile(relativePath, globals = {}) {
  const filePath = path.join(__dirname, '..', '..', relativePath);
  const code = fs.readFileSync(filePath, 'utf8');

  const sandbox = { console, Intl, Date, ...globals };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relativePath });

  return sandbox;
}

module.exports = { loadGasFile };
