/**
 * @fileoverview config.gs - Microservicio DAPs
 * Configuración global, reglas de negocio y gestión de variables de entorno.
 */

'use strict';

/**
 * Obtiene una variable de entorno desde PropertiesService (Memoria Segura).
 * @param {string} key - Clave de la variable a consultar.
 * @returns {string|null} Valor de la variable, o null si no existe o la clave es inválida.
 */
function getEnv(key) {
  if (!key) return null;
  return PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * Sello de versión del código. Súbelo en cada entrega: el comando `/version` del bot lo
 * devuelve para comprobar qué versión está ejecutando el Web App (el webhook corre la versión
 * DESPLEGADA, no el código más reciente del editor) y `healthCheck()` lo compara con el Web
 * App desplegado.
 * @constant {string}
 */
const APP_VERSION = '2026-10-02.1';

/**
 * Constantes estructurales del sistema.
 * Implementa Object.freeze para garantizar la inmutabilidad de la configuración
 * durante el ciclo de vida de la ejecución.
 * @constant {Object}
 */
const CONFIG = Object.freeze({
  SHEETS: {
    // Nombre de la hoja de base de datos en el documento remoto
    DAPS: 'DAPs'
  },
  HEADERS: {
    // Estructura estricta de columnas para la persistencia de datos. Las columnas nuevas SIEMPRE
    // se agregan al final (`_assertSchema` migra hojas antiguas agregando las que falten).
    DAPS: [
      'ID_Interno',
      'ID_Operacion',
      'Monto',
      'Tipo_DAP',
      'Fecha_Inicio',
      'Fecha_Vencimiento',
      'Objetivo',
      'Fecha_Liquidacion',
      'Liquidado',
      'Estado_Cola',
      'ID_Mensaje_Email',
      'Notion_Page_ID',
      'Moneda',
      'Monto_Original',
      'Valor_UF',
      'Paso_Conversacion',
      'Ultimo_Aviso',
      'Avisos_Enviados',
      'Notion_Intentos',
      // Monto final del depósito (ver dap_final_amount.gs). Estas 5 columnas deben quedar contiguas
      // y en este orden: se escriben con un solo setValues (FINAL_COLUMNS).
      'Monto_Final',
      'Monto_Final_Original',
      'Valor_UF_Final',
      'Origen_Monto_Final',
      'ID_Mensaje_Liquidacion'
    ]
  },
  // Origen del monto final (columna Origen_Monto_Final): CAPTACION = proyección leída del correo de
  // toma (solo DAP fijos); LIQUIDACION = monto real del correo de liquidación (definitivo).
  FINAL_SOURCES: {
    CAPTACION: 'CAPTACION',
    LIQUIDACION: 'LIQUIDACION'
  },
  // Estados de la cola (columna Estado_Cola). Flujo normal:
  // PENDIENTE_OBJETIVO -> ESPERANDO_TELEGRAM -> COMPLETADO
  // Si Notion falla al finalizar: ESPERANDO_TELEGRAM -> PENDIENTE_NOTION -> (reintentos) -> COMPLETADO
  STATES: {
    PENDIENTE_OBJETIVO: 'PENDIENTE_OBJETIVO',
    ESPERANDO_TELEGRAM: 'ESPERANDO_TELEGRAM',
    PENDIENTE_NOTION: 'PENDIENTE_NOTION',
    COMPLETADO: 'COMPLETADO'
  },
  // Pasos de la conversación con el usuario (columna Paso_Conversacion)
  STEPS: {
    OBJETIVO: 'ESPERANDO_OBJETIVO',
    LIQUIDACION: 'ESPERANDO_LIQUIDACION'
  },
  FSM: {
    // Horas sin respuesta tras las cuales se reenvía la pregunta pendiente
    REMINDER_HOURS: 6,
    // Recordatorios máximos (además del aviso inicial) antes de alertar al administrador
    MAX_REMINDERS: 3
  },
  LIMITS: {
    OBJETIVO_MAX: 200,
    TELEGRAM_MESSAGE_MAX: 4096,
    // Presupuesto de tiempo de las ejecuciones largas (el tope de Apps Script es 6 min)
    RUNTIME_BUDGET_MS: 270000
  },
  ALERTS: {
    // Una misma alerta (misma clave) no se reenvía antes de este tiempo
    THROTTLE_SECONDS: 3600
  },
  NOTION: {
    VERSION: '2022-06-28',
    // Reintentos de sincronización con Notion antes de dejar de insistir y alertar
    MAX_SYNC_ATTEMPTS: 5,
    // Nombres EXACTOS de las propiedades de la base de datos de Notion (y su tipo esperado)
    PROPS: {
      OBJETIVO: 'Objetivo',
      ID_OPERACION: 'ID operación',
      MONTO: 'Monto',
      TIPO: 'Tipo DAP',
      FECHA_INICIO: 'Fecha inicio',
      FECHA_VENCIMIENTO: 'Fecha vencimiento',
      FECHA_LIQUIDACION: 'Fecha liquidación',
      LIQUIDADO: 'Liquidado',
      MONTO_FINAL: 'Monto final'
    },
    PROP_TYPES: {
      'Objetivo': 'title',
      'ID operación': 'number',
      'Monto': 'number',
      'Tipo DAP': 'select',
      'Fecha inicio': 'date',
      'Fecha vencimiento': 'date',
      'Fecha liquidación': 'date',
      'Liquidado': 'checkbox',
      'Monto final': 'number'
    }
  },
  BANKS: {
    BCI: {
      // Solo se aceptan correos cuyo remitente pertenezca a estos dominios (o subdominios)
      SENDER_DOMAINS: ['bci.cl'],
      // Los correos de liquidación se aceptan solo de estas direcciones exactas (más estricto que
      // el dominio: un comprobante falso marcaría un DAP como liquidado con un monto inventado)
      LIQUIDATION_SENDERS: ['contacto@bci.cl']
    }
  },
  // Feriados (fechas ISO 'yyyy-MM-dd') que se excluyen al contar los días hábiles de las
  // ventanas de renovación. Opcional: por defecto solo se excluyen sábados y domingos.
  HOLIDAYS: [],
  GMAIL: {
    // Etiqueta de idempotencia para marcar correos como procesados
    LABEL_DAP_PROCESSED: 'SaaS_Inversiones/DAP_Procesado',
    // Etiqueta para correos de DAP que no se pudieron interpretar (requieren revisión manual)
    LABEL_DAP_ERROR: 'SaaS_Inversiones/DAP_Error'
  },
  // Propiedades de script obligatorias (las verifica healthCheck)
  REQUIRED_PROPERTIES: [
    'SHARED_SPREADSHEET_ID',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_SECRET_TOKEN',
    'WEB_APP_URL',
    'NOTION_API_TOKEN',
    'NOTION_DAP_DATABASE_ID',
    'CMF_API_KEY'
  ]
});

/**
 * Índices de columna (base 1, aptos para Range.getRange) derivados de CONFIG.HEADERS.DAPS.
 * Evita "números mágicos" repetidos y mantiene el acceso a columnas sincronizado
 * automáticamente si el orden de HEADERS.DAPS cambia. `_assertSchema()` garantiza que el
 * encabezado real de la hoja coincida con este orden.
 * @constant {Object}
 */
const DAP_COLS = Object.freeze(
  CONFIG.HEADERS.DAPS.reduce((acc, header, index) => {
    acc[header] = index + 1;
    return acc;
  }, {})
);
