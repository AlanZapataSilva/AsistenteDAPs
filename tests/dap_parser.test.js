'use strict';

const { loadGasFile } = require('./helpers/loadGasFile');

function makeMessage({ body, subject = 'Comprobante Solicitud de Toma Depósito a plazo', date = new Date('2026-01-15T00:00:00Z') }) {
  return {
    getPlainBody: () => body,
    getBody: () => body,
    getSubject: () => subject,
    getDate: () => date,
  };
}

describe('dap_parser.gs', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = loadGasFile('dap_parser.gs', {
      Utilities: {
        formatDate: (date) => date.toISOString().slice(0, 10),
      },
      Session: {
        getScriptTimeZone: () => 'America/Santiago',
      },
    });
  });

  test('extrae monto, operación, tipo y fechas de un DAP FIJO válido', () => {
    const body = [
      'Monto Inversión: $1.500.000',
      'N° del Depósito: 123456789',
      'Tipo de Documento: Fijo',
      'Fecha de Captación: 10/01/2026',
      'Fecha de Vencimiento: 10/02/2026',
    ].join('\n');

    const result = sandbox.parseBciDapEmail(makeMessage({ body }));

    expect(result).toEqual({
      ID_Operacion: '123456789',
      Monto: 1500000,
      Tipo_DAP: 'FIJO',
      Fecha_Inicio: '2026-01-10',
      Fecha_Vencimiento: '2026-02-10',
    });
  });

  test('reconoce un DAP RENOVABLE', () => {
    const body = [
      'Monto: $500.000',
      'Operación N°: 987654321',
      'Tipo de Depósito: Renovable',
      'Emisión: 01/03/2026',
      'Vencimiento: 01/06/2026',
    ].join('\n');

    const result = sandbox.parseBciDapEmail(makeMessage({ body }));
    expect(result.Tipo_DAP).toBe('RENOVABLE');
  });

  test('usa FIJO por defecto cuando no se detecta el tipo de documento', () => {
    const body = ['Monto: $200.000', 'Comprobante: 111222333'].join('\n');

    const result = sandbox.parseBciDapEmail(makeMessage({ body }));
    expect(result.Tipo_DAP).toBe('FIJO');
  });

  test('retorna null si no se puede extraer el monto', () => {
    const body = 'N° del Depósito: 123456789';
    expect(sandbox.parseBciDapEmail(makeMessage({ body }))).toBeNull();
  });

  test('retorna null si no se puede extraer la operación', () => {
    const body = 'Monto Inversión: $100.000';
    expect(sandbox.parseBciDapEmail(makeMessage({ body }))).toBeNull();
  });

  test('usa la fecha del correo como respaldo cuando no hay fechas en el cuerpo', () => {
    const body = 'Monto: $300.000 Operación: 555666777';
    const date = new Date('2026-05-20T00:00:00Z');

    const result = sandbox.parseBciDapEmail(makeMessage({ body, date }));
    expect(result.Fecha_Inicio).toBe('2026-05-20');
    expect(result.Fecha_Vencimiento).toBe('2026-05-20');
  });
});
