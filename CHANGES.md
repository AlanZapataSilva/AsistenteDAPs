# Registro de cambios

## 2026-10-01 — Auditoría de producción (versión 2026-10-01.1)

Auditoría completa del código y puesta en producción. Detalle de hallazgos, correcciones y verificaciones pendientes en `AUDITORIA.md`; evolución en `HOJA_DE_RUTA.md`. Etiqueta de rollback: `pre-produccion` (commit `eecce51`).

**Fase 0 — archivo de funciones de completado de datos**
- Nuevo `dap_archive.gs`: contiene, comentadas línea a línea, con JSDoc tipado y con fichas (ubicación original, para qué servían, cuándo reutilizarlas, dependencias, orden de ejecución y correcciones): `backfillDapEmails`, `auditPendingDapOperaciones` (+ Apply), `repairUfDapAmounts` (+ Apply), `auditCompletedDaps` / `repairCompletedDapsApply` (+ `_planSheetFixes`, `_repairCompletedDaps`) y los ayudantes de Notion `_listAllNotionPages`, `_notionPageToDap`, `_planNotionDedupe`, `archiveNotionPage`, `updateNotionDapAmount`. Se corrigieron antes de archivarlas (comparación numérica de operaciones, no archivar páginas si falló el complemento, presupuesto de tiempo, argumentos validados, desborde de meses, desempate determinista, etc.).
- `dap_repair.gs` y `dap_maintenance.gs` **borrados completos**; `releaseDapQueue` sigue activa, ahora en `dap_ops.gs`.

**Fase 1 — correcciones críticas**
- Telegram: dedupe por `update_id`, todo bajo lock, `sendTelegramMessage` con resultado/troceo/fallback a texto plano, Objetivo validado/escapado/como texto plano, comandos desconocidos y `/liquidar` estrictos, `doGet` de versión.
- Extractor: correos no interpretables → etiqueta `DAP_Error` + alerta (ya no se marcan procesados), remitente por dominio exacto, dedupe por N° de operación, ID interno = máximo, `try` por hilo, etiquetas creadas si faltan, presupuesto de tiempo.
- Parser estricto (`parseBciDapEmailDetailed`): sin valores inventados, moneda extranjera rechazada, fechas validadas, fallback HTML decodificado.
- Red: `_fetchWithRetry` reintenta 429 con `Retry-After`. Cron: `try` por fila, Notion antes que el Sheet, reporte escapado y troceado. Notion: página más reciente entre duplicadas, IDs validados, propiedades centralizadas.
- Hoja: `_assertSchema` (migra columnas, falla si se renombra/mueve una), validaciones, casillas, formatos y encabezado protegido. `appsscript.json` con `oauthScopes` explícitos.

**Fase 2 — resiliencia y observabilidad**
- Estado de la conversación durable en el Sheet (`Paso_Conversacion`, `Ultimo_Aviso`, `Avisos_Enviados`), recordatorios y `watchdogTick` horario.
- Outbox hacia Notion (`PENDIENTE_NOTION`, `Notion_Intentos`, `retryNotionSync`).
- `_alertAdmin` con throttle; `healthCheck()` diario (propiedades, esquema, etiquetas y exclusión `-label:`, triggers, esquema de Notion, webhook, UF, versión desplegada, estados atascados); `parserCanary()` semanal; `backupSheet()` semanal; UF con respaldo en mindicador.cl.

**Documentación y pruebas**: `AUDITORIA.md`, `HOJA_DE_RUTA.md`, `README.md` y `AGENTS.md` (runbook) reescritos. Batería local de 200+ tests sobre un arnés con Sheets/Gmail/Notion/Telegram simulados (`tests/helpers/harness.js`), incluida la validación del archivo.

**Pasos de despliegue**: importar → `installDapApp()` (agrega las 4 columnas nuevas, validaciones y los 5 triggers nuevos) → crear una **nueva versión** del Web App → `/version` → `healthCheck()`. Si pide permisos, ejecutar cualquier función para autorizar los scopes explícitos.

## 2026-09-30 (2) — Auditoría y reparación completa de Sheet + Notion

`auditCompletedDaps()` pasa a ser la **simulación** de un pipeline completo (solo log) y `repairCompletedDapsApply()` lo aplica (nuevo `dap_repair.gs`). Orden obligatorio:
1. **Sheet a)** marca como liquidados los DAP cuya fecha de liquidación ya pasó (o que Notion ya marca liquidados).
2. **Sheet b)** DAP renovables sin liquidar con fecha tentativa fuera de ventana: se informan con 🚨 y se corrige la fecha a la válida más cercana (se interpretó "tipo fijo" del pedido como **renovable**, único tipo que tiene ventanas).
3. **Sheet c)** COMPLETADOS sin página en Notion: se envían (upsert por ID operación, así no se duplican) con la fecha ya corregida.
4. **Notion a)** duplicados por ID operación: se conserva la página más reciente (`created_time`), se complementa con lo que tenían las antiguas (solo campos vacíos y Liquidado false→true), se archivan las antiguas (restaurables desde la papelera de Notion), se re-enlazan las filas del Sheet que apuntaban a páginas archivadas y se reflejan en Notion los cambios de los pasos 1 y 2.

Salvaguardas: simulación por defecto; los grupos con Monto, tipo o fechas distintos se omiten (`⛔`) para revisión manual, y los conflictos de Objetivo se registran (`↔️`) antes de descartar el antiguo. Se reemplazó la auditoría de solo lectura anterior.
Cambios de apoyo: `_buildDapDtoFromRow`, `archiveNotionPage`, `_notionPageToDap`, `_planNotionDedupe` (notion.gs), `_planSheetFixes` (dap_repair.gs). Tests: 91.

## 2026-09-30 — Formato antiguo en mensajes por webhook, moneda original y auditoría

**Síntoma**: tras reanudar la cola, solo el primer mensaje salió con el formato nuevo; los siguientes con el antiguo (fecha `Mon Aug 03 2026 00:00:00 GMT-0400...`, sin N° de operación ni captación).

**Auditoría del código**: el texto antiguo no existe en el repo; el aviso se construye solo en `_buildNewDapMessage()` y se envía solo desde `pingNextPendingDap()`; no hay `.gs` duplicados. **Causa**: el webhook de Telegram (`doPost`) ejecuta la *versión desplegada* del Web App (antigua), mientras que `releaseDapQueue()` (ejecutado desde el editor) usa el código más reciente. **Solución**: crear una nueva versión de la implementación Web App tras cada importación (ver AGENTS.md, "Deployment Versions").

**Cambios**
- `dap_queue.gs`: el mensaje incluye "Moneda original" (Pesos chilenos (CLP) o UF convertida a pesos; `Moneda` vacía = CLP). El monto sigue mostrándose siempre en pesos.
- `config.gs` / `telegram.gs`: `APP_VERSION` y comando `/version` para verificar qué código corre el webhook.
- `notion.gs`: `_listAllNotionPages` (paginado) y `_groupNotionDuplicates`.
- `dap_maintenance.gs`: `auditCompletedDaps()` (solo lectura): duplicados en Notion, renovables con fecha de liquidación fuera de ventana y completados sin página de Notion — para revisar lo completado con el código antiguo.
- Tests: 88 en total.

## 2026-09-29 — DAP en UF, mensaje de Telegram mejorado y cola auto-reparable

**Problemas detectados al completar DAPs por Telegram**
- Los DAP en **UF** se registraban como pesos (`UF 4,4379` → `$44.379`) porque el parser eliminaba todo lo que no fuera dígito.
- El mensaje mostraba la fecha como `Thu Apr 02 2026 00:00:00 GMT-0300 (...)`. Causa: en Apps Script los valores de fecha de `getValues()` vienen de otro contexto y `instanceof Date` da `false`. El mismo patrón estaba en `dap_cron.gs`, así que el cron diario **probablemente nunca liquidó ningún DAP**.
- `_fetchWithRetry` logueaba la URL completa al fallar (habría filtrado la `apikey` de la CMF y ya filtraba el token del bot de Telegram).
- Una fila en `ESPERANDO_TELEGRAM` cuyo caché expiraba (TTL 6 h) quedaba huérfana para siempre.

**Cambios**
- `config.gs` / `setup.gs`: 3 columnas nuevas al final de la hoja (`Moneda`, `Monto_Original`, `Valor_UF`); `installDapApp()` agrega los encabezados que falten sin tocar filas existentes.
- `dap_parser.gs`: detecta moneda UF/CLP (por el prefijo del monto y el campo "Moneda"), parsea UF con coma decimal, y devuelve `Moneda`/`Monto_Original` (`Monto` = null en UF hasta convertir).
- Nuevo `uf.gs`: `getUfValue(fecha)` (API CMF, requiere Script Property `CMF_API_KEY`, cacheado) y `_enrichWithClpAmount()` (monto CLP = UF × valor UF de la fecha de captación).
- `dap_extractor.gs`: convierte UF antes de encolar (si falla, no encola ni etiqueta el hilo → reintento), arma la fila por nombre de columna y no duplica mensajes ya presentes.
- `utils.gs`: `_isDateObject`, `_toIsoDate`, `_formatDateLong` (`Jueves 02/Abril/2026`), `_parseChileanNumber`, `_redactUrl`. Usados en `dap_queue.gs`, `dap_cron.gs` y `telegram.gs` en lugar de `instanceof Date` / `new Date(...)`.
- `dap_queue.gs`: mensaje nuevo con N° de operación, fecha de captación y fechas legibles; para UF muestra `UF 4,4379 ≈ $X (UF del dd/mm/aaaa: $Y)`; retoma filas huérfanas en `ESPERANDO_TELEGRAM`.
- `notion.gs`: `patchNotionPageProperties` genérico + `updateNotionDapAmount`.
- `dap_maintenance.gs`: `releaseDapQueue()`, `repairUfDapAmounts()` (simulación) y `repairUfDapAmountsApply()`.
- Tests (locales): 36 en total; nuevos para UF, utilidades de fecha (incluye fechas de otro contexto), cron y mensaje.

**Fase B — DAP renovables** (con un correo renovable real)
- El correo renovable usa otra plantilla (3 celdas: etiqueta / `:` o `$` / valor; montos `1,525,000`). Se comprobó que el "gap" de un solo salto de línea de la entrada anterior fallaba en 2 de 4 layouts posibles de texto plano; ahora `_GAP` (`dap_parser.gs`) permite líneas intermedias que contengan solo separadores (`:`, `$`, `UF`, espacios) y sigue sin cruzar hacia otra etiqueta. `MONEDA` ahora es `Moneda[\s:]*(UF|Pesos)`.
- Nuevo `renewal.gs`: ventanas de renovación `[Fecha1 + k·plazo, +2 días hábiles]` (lunes a viernes; feriados opcionales en `CONFIG.HOLIDAYS`), validación de fecha con sugerencia de la más cercana y `_parseUserDate`.
- Mensaje de Telegram de un renovable: muestra "Plazo de renovación: N días" y "Próxima ventana de renovación: X al Y" en lugar de la fecha de vencimiento.
- Paso `ESPERANDO_LIQUIDACION`: la fecha debe caer dentro de una ventana; si no, el bot propone la fecha válida más cercana y vuelve a preguntar hasta que sea válida (`saltar` sigue permitido; acepta `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY`).
- `_parseFlexibleNumber` para montos en UF (formato de decimales distinto entre plantillas).
- Tests: 80 en total.

**Pasos de despliegue**: guardar `CMF_API_KEY` en Propiedades del script (y regenerar la clave si se compartió en un chat) → importar código → `installDapApp()` → `auditPendingDapOperaciones()` → `repairUfDapAmounts()` (revisar log) → `repairUfDapAmountsApply()` → `releaseDapQueue()`.

## 2026-09-24 (2) — Bug real: ID_Operacion capturaba el N° de Transacción en vez del N° de Depósito

**Cómo se detectó**: al revisar el DAP #13 (primero del backfill) en el Sheet, el `ID_Operacion` guardado (`31439026639`) no coincidía con ningún número real de la operación — el correo real tenía `N° Depósito: 071015510336` y, además, un campo nuevo `N° Transacción: W31439026639` que el parser no debía tocar.

**Causa raíz (dos problemas combinados)**:
1. BCI cambió el template: antes decía "N° del Depósito", ahora dice "N° Depósito" (sin "del"), así que la alternativa específica del regex de `dap_parser.gs` dejó de matchear.
2. Como la alternativa específica fallaba, el regex caía al fallback genérico `Operaci.n`, que hacía match con la palabra "operación" dentro de un encabezado de sección ("Detalle de la operación") que aparece **antes** de la tabla de datos en el correo. Como `[^\d]` (usado como "gap" entre etiqueta y valor) también cruza saltos de línea sin límite, el regex siguió de largo desde ese encabezado hasta encontrar el primer número más abajo — que resultó ser el de Transacción, no el de Depósito. En JavaScript, `string.match()` devuelve el match más a la izquierda del texto, no el de la alternativa "más específica", así que esto ganaba sin importar el orden de las alternativas dentro del regex.

Esto es crítico porque el upsert de Notion (agregado el mismo día, ver entrada anterior) depende de que `ID_Operacion` sea correcto para encontrar la página existente.

**Fix en `dap_parser.gs`**:
- El número de operación ahora se extrae probando una **lista ordenada de patrones por confiabilidad** (`OPERACION_CANDIDATES`, función `_extractIdOperacion`) y usando el primero que matchee en cualquier parte del correo — no un único regex combinado con alternación (que sufre el problema de "gana el que aparece primero en el texto", no el más específico).
- La alternativa de depósito ahora acepta tanto "N° del Depósito" como "N° Depósito" (`(?:del\s+)?` opcional).
- El "gap" entre etiqueta y valor en `MONTO`, `FECHA_INICIO`, `FECHA_VENCIMIENTO` y los `OPERACION_CANDIDATES` cambió de `[^\d]*` (cruza cualquier cantidad de saltos de línea) a `(?:[^\d\r\n]*\r?\n)?[^\d\r\n]*` (cruza como máximo UN salto de línea — soporta "Etiqueta: valor" en la misma línea o "Etiqueta" y "valor" en líneas separadas, pero nunca se cuela a una fila distinta de la tabla). Aplicado preventivamente a los 4 campos, no solo a `ID_Operacion`, porque comparten el mismo patrón de fallback genérico + regex sin techo.
- Nuevo test de regresión en `tests/dap_parser.test.js` que reproduce el correo real (encabezado + N° Transacción antes de N° Depósito) y verifica que se extraiga el número correcto.

**Nuevo: `dap_maintenance.gs` → `auditPendingDapOperaciones()`**. Los DAPs ya encolados por el backfill ANTES de este fix (fila 13 y posiblemente otras) quedaron con el `ID_Operacion` incorrecto en el Sheet; corregir el código no corrige datos ya escritos. Esta función (ejecución manual, una sola vez) recorre las filas que **no** están `COMPLETADO`, re-abre el correo original de cada una (vía `ID_Mensaje_Email`, ya guardado) con el parser corregido, y si el `ID_Operacion` no coincide con el guardado, lo corrige en el Sheet. No toca filas `COMPLETADO` (podrían ya estar sincronizadas con Notion).

Suite completa tras este cambio: 12/12 tests, lint 0 errores.

## 2026-09-24 — Causa real del fallo de import + upsert de DAPs en Notion

**Causa real del fallo de import a GAS**: no eran los tipos de archivo — la API de Google Apps Script estaba **desactivada** en la cuenta/proyecto de Google usado por la extensión "Google App Script GitHub Assistant". Al activarla, el import funcionó incluso con el repo completo. De todas formas, se decide **mantener** la política de dejar fuera del repo el tooling no-`.md` (ver política abajo), ya que igualmente evita fricción con ese conector y no tiene costo real.

**Política de `.gitignore` (permanente, no solo temporal)**: todo archivo que **no** sea parte del runtime de Apps Script (`.gs`, `appsscript.json`) ni sea documentación (`.md`) se agrega a `.gitignore`. Concretamente quedan fuera del repo (pero presentes en disco, funcionando con `npm install`/`npm test`/`npm run lint` normalmente): `package.json`, `package-lock.json`, `.eslintrc.json`, `.clasp.json.example`, `tests/`. `AGENTS.md`, `CHANGES.md`, `README.md` y `.gitignore` vuelven a trackearse (se habían agregado también al `.gitignore` durante el diagnóstico del punto anterior; ya no hace falta).

**Nuevo: upsert de DAPs en Notion (evita duplicados en el reprocesamiento)**. Al ejecutar `backfillDapEmails()` (ver entrada anterior), varios DAPs históricos ya existían como página en Notion (cargados ahí antes de que este pipeline etiquetara los correos), y `pushDapToNotion()` los habría duplicado. Cambios en `notion.gs`:
- `_findNotionPageByOperacion()`: busca en la base de datos de Notion por `ID operación` (`POST /v1/databases/{id}/query`) antes de crear.
- `pushDapToNotion()` ahora es un upsert: si no encuentra coincidencia, crea la página igual que antes (`_createNotionPage()`); si encuentra una página existente, la complementa (`_complementExistingNotionPage()`) — solo llena campos vacíos (`Objetivo`, `Fecha liquidación`, `Monto`, `Tipo DAP`, `Fecha inicio`, `Fecha vencimiento`) y sube `Liquidado` de `false` a `true` si corresponde; nunca pisa un valor ya presente, y nunca baja `Liquidado` de `true` a `false`. Si no hay nada que complementar, no hace ningún `PATCH`. En todos los casos retorna el ID de la página correcta (nueva o existente), así el Sheet queda enlazado a la página real y no se crean duplicados.
- Firma pública sin cambios (`pushDapToNotion(dap) -> pageId|null`), por lo que `telegram.gs` (`finalizeDap`) no requirió modificaciones.
- Nuevos tests: `tests/notion.test.js` (3 casos: crea si no existe, complementa campos vacíos si existe, no hace nada si ya está completo). Suite completa: 11/11 tests, lint 0 errores.

**Nota operativa sobre el backfill**: si el caché de Telegram (`${chatId}_ACTIVE_DAP`) queda con un valor viejo/huérfano (por ejemplo, de una prueba manual), `pingNextPendingDap()` no avanzará la cola aunque haya DAPs en `PENDIENTE_OBJETIVO`. Verificar con `CacheService.getScriptCache().get(...)`, limpiar con `.remove(...)` si corresponde, y llamar `pingNextPendingDap()` manualmente para reactivar la cola.

## 2026-09-23 — Exclusión temporal de archivos de tooling (diagnóstico de import a GAS)

**Motivo**: El commit `e5b357d` ("MejorasClaude") agregó, junto a las correcciones de código, un set de tooling de desarrollo local (`package.json`, `package-lock.json`, `.eslintrc.json`, `.clasp.json.example`, carpeta `tests/`). Tras pushear ese commit, la extensión de Chrome "Google App Script GitHub Assistant" empezó a fallar al importar el repo a Apps Script con el error `[github assistant] undefined`. Causa más probable: Apps Script es un proyecto **plano** (sin subcarpetas) y esa extensión no soporta ni la subcarpeta `tests/helpers/` ni múltiples archivos `.json` sueltos además del manifiesto `appsscript.json` (en particular `package-lock.json`, de ~7500 líneas).

**Acción tomada**: Se quitaron del control de versiones (con `git rm --cached`, es decir, **sin borrarlos del disco**) y se agregaron al `.gitignore` los siguientes archivos/carpetas:

| Archivo/Carpeta | Motivo | Estado |
|---|---|---|
| `package.json` | Manifiesto npm, no es un archivo GAS válido | En disco, sin trackear |
| `package-lock.json` | Archivo generado muy grande (~7500 líneas) | En disco, sin trackear |
| `.eslintrc.json` | Config de lint, no es el manifiesto GAS | En disco, sin trackear |
| `.clasp.json.example` | Plantilla de config de `clasp` | En disco, sin trackear |
| `tests/` (incluye `tests/dap_parser.test.js`, `tests/dap_queue.test.js`, `tests/helpers/loadGasFile.js`) | Subcarpeta anidada, no soportada por un proyecto GAS plano | En disco, sin trackear |

Estos archivos **siguen existiendo localmente** (no se borró nada) y `npm install` / `npm test` / `npm run lint` siguen funcionando en este equipo. Solo se excluyeron del repositorio remoto para que el import a Apps Script reciba únicamente archivos `.gs` + `appsscript.json` + `.md`, que es lo que ese conector soporta de forma confiable.

**Cómo restaurarlos en el repo** (una vez confirmado que el import a GAS funciona con el árbol reducido y se pruebe el fix de la cola/triggers):
```bash
# Quitar las líneas agregadas bajo "Excluido temporalmente" en .gitignore
git add .gitignore package.json package-lock.json .eslintrc.json .clasp.json.example tests/
git commit -m "Restaurar tooling de desarrollo local (clasp/eslint/jest)"
git push
```
Si en ese momento el import a GAS ya no depende de este mismo conector (por ejemplo, se migra a `clasp push` manual, que sí es la vía recomendada — ver sección "Local Development" de `AGENTS.md`), no haría falta volver a quitarlos.

**Qué quedó en el repo tras esta limpieza** (lo que la extensión debería poder importar sin error): todos los archivos `.gs`, `appsscript.json`, `AGENTS.md`, `README.md`, `.gitignore` y este mismo `CHANGES.md`.

---

## 2026-09-14 — Correcciones de código y tooling de desarrollo (commit `e5b357d`)

### Corrección crítica de concurrencia
- **`dap_queue.gs`**: `pingNextPendingDap()` ahora verifica `${chatId}_ACTIVE_DAP` en `CacheService` antes de avanzar la cola FIFO. Antes, si llegaba un nuevo correo mientras el usuario no había respondido el DAP anterior, la fila previa quedaba huérfana para siempre en `ESPERANDO_TELEGRAM` (el caché perdía la referencia y la fila ya no volvía a `PENDIENTE_OBJETIVO`).

### Robustez de red
- **`utils.gs`** (nuevo): `_fetchWithRetry(url, options, maxRetries)` — reintenta ante excepciones de red o respuestas 5xx (con backoff corto vía `Utilities.sleep`); no reintenta ante 4xx (errores de configuración, no transitorios).
- **`telegram.gs`**: `sendTelegramMessage()` usa `_fetchWithRetry`.
- **`notion.gs`**: `pushDapToNotion()` y `updateNotionDapStatus()` usan `_fetchWithRetry`.

### Automatización de infraestructura
- **`setup.gs`**: nueva función `_setupTriggers()`, invocada desde `installDapApp()`. Crea (de forma idempotente, sin duplicar) los triggers de tiempo `processDapEmails` (cada 15 min) y `checkAndLiquidateDaps` (diario, 08:00 `America/Santiago`). Antes había que configurarlos manualmente en la UI de Apps Script.

### Eliminación de números mágicos de columna
- **`config.gs`**: nueva constante `DAP_COLS`, derivada automáticamente de `CONFIG.HEADERS.DAPS` (índices base 1, listos para `Range.getRange`).
- **`dap_queue.gs`, `telegram.gs`, `dap_cron.gs`**: todos los accesos a columnas por número mágico (`row[9]`, `getRange(rowIndex, 7)`, etc.) fueron reemplazados por `DAP_COLS.<Nombre>`. Esto evita roturas silenciosas si el orden de `CONFIG.HEADERS.DAPS` cambia en el futuro.

### Documentación
- **`dap_extractor.gs`**: corregido el JSDoc de `_generateNextInternalId` (retorna un entero simple como `1`, `2`, `42`, no `DAP-001` como decía antes).
- **`AGENTS.md`**: agregada la sección "Known Gotchas" (documentando el invariante de un solo DAP activo en caché) y la sección "Local Development".

### Tooling de desarrollo local (ver sección de arriba: excluido temporalmente del repo el 2026-09-23)
- `package.json`, `package-lock.json`: dependencias `@google/clasp`, `eslint`, `jest`.
- `.eslintrc.json`: config de ESLint con los globals de Apps Script.
- `.clasp.json.example`: plantilla de configuración de `clasp`.
- `tests/helpers/loadGasFile.js`: loader basado en `vm` de Node para poder testear archivos `.gs` sin convertirlos a módulos CommonJS.
- `tests/dap_parser.test.js`: 6 tests sobre `parseBciDapEmail`/`_normalizeDate`.
- `tests/dap_queue.test.js`: 2 tests sobre el guard de concurrencia agregado a `pingNextPendingDap`.
- Verificado localmente: `npm test` (8/8 tests) y `npm run lint` sin errores.
