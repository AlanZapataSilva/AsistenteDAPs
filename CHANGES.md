# Registro de cambios

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
