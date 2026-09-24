# Registro de cambios

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
