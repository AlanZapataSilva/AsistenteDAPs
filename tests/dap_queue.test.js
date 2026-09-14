'use strict';

const { loadGasFile } = require('./helpers/loadGasFile');

const DAP_COLS = {
  ID_Interno: 1,
  ID_Operacion: 2,
  Monto: 3,
  Tipo_DAP: 4,
  Fecha_Inicio: 5,
  Fecha_Vencimiento: 6,
  Objetivo: 7,
  Fecha_Liquidacion: 8,
  Liquidado: 9,
  Estado_Cola: 10,
  ID_Mensaje_Email: 11,
  Notion_Page_ID: 12,
};

function makeCache(initialStore = {}) {
  const store = { ...initialStore };
  return {
    store,
    get: jest.fn((key) => (key in store ? store[key] : null)),
    put: jest.fn((key, value) => {
      store[key] = value;
    }),
  };
}

function buildSandbox({ cache, ss, sendTelegramMessage = jest.fn() }) {
  return loadGasFile('dap_queue.gs', {
    getEnv: (key) =>
      ({ SHARED_SPREADSHEET_ID: 'sheet123', TELEGRAM_CHAT_ID: '42' }[key]),
    CONFIG: { SHEETS: { DAPS: 'DAPs' } },
    DAP_COLS,
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
    },
    CacheService: { getScriptCache: () => cache },
    SpreadsheetApp: { openById: jest.fn(() => ss), flush: jest.fn() },
    Utilities: { formatDate: () => '2026-01-01' },
    Session: { getScriptTimeZone: () => 'America/Santiago' },
    sendTelegramMessage,
  });
}

describe('dap_queue.gs - pingNextPendingDap', () => {
  test('no avanza la cola si ya hay un DAP activo en caché (evita filas huérfanas)', () => {
    const cache = makeCache({ '42_ACTIVE_DAP': '7' });
    const openByIdSpy = jest.fn();
    const sandbox = buildSandbox({
      cache,
      ss: { getSheetByName: openByIdSpy },
    });

    sandbox.pingNextPendingDap();

    expect(openByIdSpy).not.toHaveBeenCalled();
  });

  test('avanza la cola y notifica por Telegram cuando no hay DAP activo', () => {
    const cache = makeCache();
    const setValueSpy = jest.fn();
    const sheet = {
      getDataRange: () => ({
        getValues: () => [
          new Array(12).fill('header'),
          [1, '111', 100000, 'FIJO', '2026-01-01', '2026-02-01', '', '', false, 'PENDIENTE_OBJETIVO', 'msg1', ''],
        ],
      }),
      getRange: jest.fn(() => ({ setValue: setValueSpy })),
    };
    const sendTelegramMessage = jest.fn();
    const sandbox = buildSandbox({
      cache,
      ss: { getSheetByName: () => sheet },
      sendTelegramMessage,
    });

    sandbox.pingNextPendingDap();

    expect(setValueSpy).toHaveBeenCalledWith('ESPERANDO_TELEGRAM');
    expect(cache.put).toHaveBeenCalledWith('42_ACTIVE_DAP', '1', 21600);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });
});
