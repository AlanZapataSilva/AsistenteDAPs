/**
 * @fileoverview dap_final_amount.gs - Monto final de un DAP (capital + intereses al liquidarse), para
 * poder analizar ganancias. Dos orígenes:
 *  - CAPTACION: proyección leída del "Valor Final" del correo de toma. Solo DAP FIJOS (un renovable
 *    se renueva, así que ese valor es solo el del primer período).
 *  - LIQUIDACION: monto real del correo de liquidación; es definitivo y reemplaza a la proyección.
 * Convención igual que `Monto`/`Monto_Original`: `Monto_Final` siempre en CLP y `Monto_Final_Original`
 * en la moneda del DAP (UF con decimales, o CLP).
 */

'use strict';

/**
 * Columnas del monto final. Están contiguas y en este orden en `CONFIG.HEADERS.DAPS`, por lo que
 * se escriben con un solo `setValues`.
 * @constant {ReadonlyArray<string>}
 */
const FINAL_COLUMNS = Object.freeze(['Monto_Final', 'Monto_Final_Original', 'Valor_UF_Final', 'Origen_Monto_Final', 'ID_Mensaje_Liquidacion']);

/**
 * Montos finales de un DAP.
 * @typedef {Object} FinalAmounts
 * @property {number} original - Monto final en la moneda del DAP (CLP entero, o UF con decimales).
 * @property {number|string} clp - Monto final en pesos; '' si aún no se puede convertir (UF sin valor a esa fecha).
 * @property {number|string} valorUf - Valor de la UF usado en la conversión; '' si no aplica.
 */

/**
 * Calcula los montos finales de un DAP en pesos y en su moneda original.
 * - Monto en pesos de un DAP en pesos: se usa tal cual.
 * - Monto en UF: pesos = round(UF × valor de la UF de `dateIso`).
 * - Monto en pesos de un DAP en UF (el banco pagó en pesos): la UF equivalente se deriva con el valor
 *   de la UF de `dateIso`.
 * @private
 * @param {string} dapCurrency - Moneda del DAP: 'CLP' o 'UF'.
 * @param {string} amountCurrency - Moneda en que viene `amount`: 'CLP' o 'UF'.
 * @param {number} amount - Monto final tal como lo informa el banco.
 * @param {string} dateIso - Fecha (YYYY-MM-DD) cuyo valor de la UF se usa para convertir.
 * @param {boolean} allowPartial - true para aceptar un resultado sin pesos (`clp` = '') cuando el monto
 *   está en UF y aún no hay valor de la UF (fecha futura o proveedores caídos); false para exigirlo.
 * @returns {FinalAmounts|null} Montos, o null si se necesita el valor de la UF y no está disponible.
 */
function _resolveFinalAmounts(dapCurrency, amountCurrency, amount, dateIso, allowPartial) {
  if (amountCurrency === 'CLP' && dapCurrency !== 'UF') {
    const clp = Math.round(amount);
    return { original: clp, clp: clp, valorUf: '' };
  }

  // El valor de la UF de una fecha futura no existe: no se consulta a los proveedores
  const valorUf = dateIso <= _todayIso() ? getUfValue(dateIso) : null;
  if (!valorUf) {
    return allowPartial && amountCurrency === 'UF' ? { original: amount, clp: '', valorUf: '' } : null;
  }

  if (amountCurrency === 'UF') {
    return { original: amount, clp: Math.round(amount * valorUf), valorUf: valorUf };
  }

  const clp = Math.round(amount);
  return { original: Math.round((clp / valorUf) * 10000) / 10000, clp: clp, valorUf: valorUf };
}

/**
 * Monto final proyectado desde el correo de toma. Solo DAP FIJOS con "Valor Final" coherente.
 * Nunca bloquea el registro del DAP: en UF sin valor de la UF queda solo el monto en UF.
 * @private
 * @param {DapDTO} dapDto - DTO devuelto por `parseBciDapEmailDetailed`.
 * @returns {FinalAmounts|null} Montos proyectados, o null si el DAP no tiene proyección confiable.
 */
function _captureFinalAmounts(dapDto) {
  if (dapDto.Tipo_DAP !== 'FIJO' || !Number.isFinite(dapDto.Valor_Final)) return null;
  return _resolveFinalAmounts(dapDto.Moneda, dapDto.Moneda, dapDto.Valor_Final, dapDto.Fecha_Vencimiento, true);
}

/**
 * Valores de las columnas del monto final, por nombre de columna.
 * @private
 * @param {FinalAmounts|null} amounts - Montos; null deja todas las columnas vacías.
 * @param {string} origin - Valor de `CONFIG.FINAL_SOURCES`.
 * @param {string} [liquidationMessageId] - ID del mensaje de Gmail del correo de liquidación.
 * @returns {Object<string, number|string>} Un valor por cada columna de `FINAL_COLUMNS`.
 */
function _finalColumnValues(amounts, origin, liquidationMessageId) {
  if (!amounts) {
    return FINAL_COLUMNS.reduce((acc, name) => { acc[name] = ''; return acc; }, {});
  }
  return {
    Monto_Final: amounts.clp,
    Monto_Final_Original: amounts.original,
    Valor_UF_Final: amounts.valorUf,
    Origen_Monto_Final: origin,
    ID_Mensaje_Liquidacion: liquidationMessageId || ''
  };
}

/**
 * Escribe las columnas del monto final de una fila con una sola operación de rango y refleja el
 * cambio en el arreglo `row` en memoria (para que el resto de la corrida vea el valor nuevo).
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - Hoja de DAPs.
 * @param {number} rowIndex - Fila (base 1).
 * @param {Array} row - Valores de la fila en memoria (se actualiza).
 * @param {Object<string, number|string>} values - Salida de `_finalColumnValues`.
 * @returns {void}
 */
function _storeFinalColumns(sheet, rowIndex, row, values) {
  const cells = FINAL_COLUMNS.map((name) => (values[name] === undefined ? '' : values[name]));
  sheet.getRange(rowIndex, DAP_COLS[FINAL_COLUMNS[0]], 1, FINAL_COLUMNS.length).setValues([cells]);
  FINAL_COLUMNS.forEach((name, i) => { row[DAP_COLS[name] - 1] = cells[i]; });
}
