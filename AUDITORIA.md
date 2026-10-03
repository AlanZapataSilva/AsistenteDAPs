# Auditoría de producción — AsistenteDAPs

Estado del código auditado: commit `eecce51` (etiqueta git `pre-produccion`). Versión resultante: `APP_VERSION` en `config.gs`.
Cada corrección referencia el ID del hallazgo. Los tests que las cubren están en `tests/` (locales; ver "Mejora continua").

## Resumen

Se auditó todo el pipeline (Gmail → parser → Sheet → cola → Telegram → Notion, cron, UF, renovables, mantenimiento) buscando bugs, casos borde, fallas en el manejo de errores y oportunidades de evolución. Se encontraron **13 hallazgos de severidad alta, 13 medios y 7 bajos**. De los altos, 11 quedaron corregidos y 2 (H12, H13) parcialmente, con el resto en la hoja de ruta; de los medios, 11 corregidos y 2 (M2, M3) parciales; lo demás queda como evolución.

Hechos de plataforma verificados en la documentación oficial de Apps Script (no supuestos):
- `CacheService`: "los datos pueden eliminarse antes de la expiración"; máximo 21600 s y 100 KB por clave → **no sirve como fuente de verdad** del estado de la conversación.
- `LockService`: la re-entrada del lock dentro de una misma ejecución **no está documentada** → el código nunca anida locks (`_withScriptLock`).
- Cuotas de cuenta personal: 6 min por ejecución, 90 min/día de triggers, 20.000 llamadas UrlFetch/día, 20.000 lecturas de correo/día. El diseño actual las respeta con holgura (ver "Cuotas").
- La sintaxis de `-label:` con etiquetas anidadas **no está documentada** por Gmail → se excluyen las dos formas (`Padre/Hijo` y `Padre-Hijo`), se descartan en código los hilos ya etiquetados y `healthCheck()` lo verifica empíricamente.

## Hallazgos de severidad ALTA

| ID | Hallazgo | Corrección | Estado |
|---|---|---|---|
| H1 | `doPost` sin dedupe: Telegram reintenta el webhook si tarda (Notion lento) y el mismo mensaje se procesaba dos veces | `_registerUpdate`: solo se procesan `update_id` mayores al último (`LAST_UPDATE_ID`, en Properties) | Corregido |
| H2 | La ruta de conversación no usaba lock; el auto-rescate de filas huérfanas podía re-avisar un DAP que se estaba finalizando | Todo `doPost` bajo `_withScriptLock` (25 s); la cola, el cron y el extractor usan el mismo lock; sin anidar | Corregido |
| H3 | Un correo no interpretable se etiquetaba igual como "procesado": pérdida silenciosa tras un cambio de plantilla | Etiqueta `SaaS_Inversiones/DAP_Error` + alerta con asunto y motivo; nunca `DAP_Procesado` | Corregido |
| H4 | `sendTelegramMessage` ignoraba 400/403/429 y la cola marcaba el estado antes de enviar | Devuelve boolean, registra el error (URL redactada), reintenta como texto plano ante error de HTML, trocea >4096; la cola envía y revierte a `PENDIENTE_OBJETIVO` si falla | Corregido |
| H5 | El Objetivo se insertaba sin escapar en mensajes HTML, sin límite y como posible fórmula del Sheet | `_validateObjetivo` (no vacío, ≤200), `_escapeHtml` en todos los mensajes, `_setPlainText` (formato texto) | Corregido |
| H6 | Deriva Sheet↔Notion sin reintento (COMPLETADO sin página; Liquidado sin Notion) | Estado `PENDIENTE_NOTION` + `retryNotionSync` (cada 30 min, backoff por intentos, alerta al 5.º fallo); el cron ya no marca el Sheet si Notion falla | Corregido |
| H7 | `_fetchWithRetry` no reintentaba 429 (Notion: 3 req/s) | Reintenta 429 respetando `Retry-After` / `retry_after` (tope 10 s) | Corregido |
| H8 | El parser inventaba datos (Tipo→FIJO, fechas→fecha del correo, moneda→CLP, Monto NaN/≤0, `YYYY-MM-DD` invertido) | `parseBciDapEmailDetailed` estricto: códigos de error explícitos, moneda extranjera rechazada, fechas validadas y coherentes | Corregido |
| H9 | Sin guardia de esquema; `_generateNextInternalId` miraba solo la última fila | `_assertSchema` en cada punto de entrada (migra columnas nuevas; falla con alerta si se renombra/mueve una); ID interno = máximo de la columna | Corregido |
| H10 | Estado de la conversación en caché (evictable) y sin watchdog | Estado durable en el Sheet (`Paso_Conversacion`, `Ultimo_Aviso`, `Avisos_Enviados`); `watchdogTick` horario con recordatorios (máx. 3) y alerta | Corregido |
| H11 | Sin alertas ni health check | `_alertAdmin` (throttle 1 h por clave) en todos los `catch`; `healthCheck()` diario; `parserCanary()` semanal | Corregido |
| H12 | Endpoint público protegido solo por token en la URL + `chat_id` (no secreto); remitente `from:bci.cl` sin validar | Remitente validado por dominio exacto/subdominio; token débil detectado por `healthCheck`. **Pendiente (hoja de ruta):** eliminar el endpoint público (polling o proxy que valide el header `secret_token`) y verificar DKIM | Parcial |
| H13 | Despliegue manual → Web App desactualizado (ya ocurrió) | `doGet` devuelve `APP_VERSION`; `healthCheck` compara la versión desplegada con la del código y alerta; `/version` en el bot. Desde 2026-10-03 el despliegue es con `clasp` (`npm run deploy`: tests + lint + push + nueva versión del Web App). **Pendiente (hoja de ruta):** ejecutarlo en CI | Mitigado |

## Hallazgos de severidad MEDIA

| ID | Hallazgo | Corrección | Estado |
|---|---|---|---|
| M1 | Filas duplicadas si el banco reenvía un comprobante | Dedupe por N° de operación además del ID de mensaje | Corregido |
| M2 | Cron: marca liquidado sin confirmar (renovables), sin `try` por fila, reporte sin escapar/sin trocear | `try` por fila, Notion→Sheet, escape y troceo. **Pendiente:** confirmar con el usuario la liquidación de renovables (hoja de ruta) | Parcial |
| M3 | Búsqueda en Notion devolvía una página arbitraria entre duplicadas; ID NaN; nombres de propiedades sin validar; `Notion-Version` 2022-06-28 | Orden por `created_time` desc; validación de ID; `CONFIG.NOTION.PROPS` + `_validateNotionSchema` en `healthCheck`. **Pendiente:** migrar a la API de *data sources* | Parcial |
| M4 | Fallback HTML sin decodificar entidades ni saltos | `_htmlToText` (entidades, saltos por celda/fila) | Corregido |
| M5 | `/liquidar` laxo, sin validar, marcaba el Sheet aunque Notion fallara | Regex estricta, idempotente, no marca si Notion falla | Corregido |
| M6 | FSM: paso desconocido o fila no encontrada dejaba estado colgado | El estado vive en la fila; paso desconocido → aviso y alerta; comandos desconocidos ya no se toman como respuesta | Corregido |
| M7 | `_toIsoDate` usaba `new Date(texto)` (ambiguo MM/DD) | Solo `yyyy-MM-dd` y `dd-MM-yyyy`/`dd/MM/yyyy`; el resto → vacío | Corregido |
| M8 | `ID_Operacion` inconsistente (número vs texto, ceros) | Canónico: número (`_normalizeOperationId`); formato de columna `0` | Corregido |
| M9 | `-label:` no verificado; etiqueta ausente ignorada | Ambas sintaxis + descarte en código + creación automática + verificación en `healthCheck` | Corregido |
| M10 | OAuth scopes implícitos y amplios | `oauthScopes` explícitos y mínimos (`appsscript.json`) | Corregido |
| M11 | CMF único proveedor de UF | Respaldo mindicador.cl + alerta tras 3 fallos seguidos | Corregido |
| M12 | Estructura lock/try del extractor | Un solo `_withScriptLock`; hoja/etiquetas validadas dentro del `try`; per-hilo `try` | Corregido |
| M13 | Sin backup del Sheet | `backupSheet` semanal: pestaña oculta `Backup_YYYY-MM-DD` (8 vigentes). *Decisión:* se usa una copia dentro del mismo documento en vez de Drive para no ampliar los permisos; el historial de versiones de Sheets cubre la pérdida del archivo | Corregido |

## Hallazgos de severidad BAJA

| ID | Hallazgo | Estado |
|---|---|---|
| L1 | Números mágicos (TTL ×6, anchos de columna) | Corregido (`CONFIG.*`, `DAP_COLS`) |
| L2 | Búsqueda de fila duplicada 3 veces | Corregido (`_findRowByInternalId`, `_findActiveConversation`) |
| L3 | JSDoc incompleto, sin type-check | JSDoc con tipos en todo lo tocado y en el archivo; `@ts-check` en la hoja de ruta |
| L4 | README desactualizado (mencionaba Gemini) y sin runbook | Corregido (README + runbook en AGENTS.md) |
| L5 | 0 cobertura en extractor, setup, doPost, finalize | Corregido: 237 tests sobre un arnés con Sheets/Gmail/Notion/Telegram simulados. Siguen en local (fuera del repo, decisión previa) |
| L6 | Globals sin namespace | Hoja de ruta |
| L7 | `.gitignore` se ignora a sí mismo; `CHANGES`/`APP_VERSION` manuales | `APP_VERSION` verificado por `healthCheck`; resto en hoja de ruta (Fase 3) |

## Casos borde revisados (resumen)

Correo sin texto plano · plantilla nueva/antigua de BCI (2 y 3 celdas, con y sin "del") · UF con coma o punto decimal · moneda extranjera · fechas imposibles/incoherentes · comprobante reenviado · remitente falsificado (`bci.cl.evil.com`) · hilo con varios mensajes · UF sin valor disponible (se reintenta) · Telegram reintenta un update · dos mensajes seguidos · Telegram caído al avisar · HTML/fórmulas en el Objetivo · Notion caído / 429 / propiedad renombrada · hoja ordenada o con columnas movidas · conversación abandonada · reinicio del sistema a mitad de conversación (estado durable) · cron con Notion caído · reporte >4096 caracteres · presupuesto de 6 min en tareas largas.

## Cuotas (cuenta personal)

`processDapEmails` (15 min, ~3 s), `retryNotionSync` (30 min), `watchdogTick` (1 h) y los diarios/semanales suman menos de ~10 min/día de los 90 permitidos; el uso de UrlFetch es de decenas por día (límite 20.000). Vigilar solo si se agregan bancos (ver hoja de ruta).

## Suposiciones y verificaciones pendientes en producción

1. **Exclusión `-label:`**: `healthCheck()` la prueba automáticamente en cuanto exista al menos un hilo etiquetado; revisar su primer informe.
2. **`oauthScopes` explícitos**: si al subir el código Apps Script pide permisos o falla por "scope insuficiente", volver a autorizar ejecutando cualquier función; como último recurso, quitar `oauthScopes` de `appsscript.json`.
3. **Respaldo de UF (mindicador.cl)**: el formato de respuesta se leyó de su documentación pública y el parseo es tolerante (`serie[0].valor` o `valor`); se ejercita solo si falla la CMF.
4. **Nueva versión del Web App**: tras subir el código, crear una nueva versión de la implementación (`npm run deploy`) y comprobar `/version` (el `healthCheck` diario también lo verifica).
5. **Correos de liquidación (`dap_liquidation.gs`)**: el parser se validó con **una sola plantilla real** (DAP renovable en pesos, `contacto@bci.cl`). No hay muestra real de una liquidación de DAP **en UF** ni de un DAP **fijo**: el formato del monto/moneda en UF y el caso "DAP en UF pagado en pesos" son suposiciones cubiertas por tests sintéticos. Al llegar la primera de cada tipo, revisar el resultado (log / aviso de Telegram) y agregar su fixture anonimizado a `tests/parser.test.js`.
6. **Un correo de liquidación por DAP renovable**: se asume que BCI envía el comprobante solo al liquidar (no en cada renovación automática). Si enviara uno por renovación, un renovable quedaría marcado como liquidado en la primera; se notaría porque el segundo correo del mismo N° de depósito quedaría como "repetido" (el monto guardado se conserva y, si el monto del correo difiere, el log lo advierte). Verificar con los primeros casos reales.
7. **Creación de la propiedad `Monto final` en Notion**: `installDapApp()` la crea con la API (`PATCH /databases`); depende de que la integración pueda editar la base. Si no puede, el log lo indica y hay que crearla a mano (Número, nombre exacto `Monto final`); `healthCheck` la exige.
8. **Agrupación de hilos en Gmail**: la búsqueda de liquidaciones no excluye `DAP_Procesado` (idempotencia por mensaje). El flujo de toma (`processDapEmails`) sí depende de la etiqueta del hilo: si Gmail unió alguna vez dos correos de toma en un hilo ya etiquetado, el segundo se habría omitido. Baja probabilidad y **no lo detecta ninguna verificación automática** (el canario solo compara los correos que sí están en el Sheet): se descubre contando los correos de toma de Gmail contra las filas del Sheet.

## Mejora continua

- **Registro**: cada corrección referencia su ID en `CHANGES.md`; los hallazgos nuevos se agregan aquí con severidad y estado.
- **Parser**: toda modificación del parser (o cada plantilla nueva del banco) agrega un fixture real anonimizado a `tests/parser.test.js`; `parserCanary()` semanal detecta cambios de plantilla antes de que se pierdan DAP.
- **Salud**: revisar el informe diario de `healthCheck()`; cualquier hallazgo rojo se trata como incidente. Vincular el proyecto a un proyecto GCP estándar y crear una alerta de Cloud Logging sobre `severity=ERROR` cubre los fallos que ocurran antes de que el código pueda avisar por Telegram.
- **Vigilancia de dependencias**: versión de la API de Notion (migrar al modelo de *data sources* antes de que retiren la actual), runtime V8 de Apps Script, API de la CMF y mindicador.cl, plantillas de BCI.
- **Recuperación**: simulacro trimestral — restaurar una pestaña `Backup_*` sobre una copia del Sheet y verificar `healthCheck()`.
- **Despliegue**: `APP_VERSION` se sube en cada entrega; nunca se da por desplegado un cambio sin `/version` (o el informe de `healthCheck`) mostrando la versión nueva.
- **Deuda técnica**: la hoja de ruta (`HOJA_DE_RUTA.md`) es el registro; revisarla cada trimestre.
