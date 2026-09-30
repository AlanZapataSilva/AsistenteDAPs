# AGENTS.md

## Overview & Architecture

Google Apps Script (GAS) microservice on V8 runtime (`America/Santiago` timezone) managing Term Deposits (DAPs, fixed and renewable, CLP and UF) across Gmail (BCI), Google Sheets, Telegram Bot, and Notion API.

Data pipeline:
`dap_extractor.gs` (Gmail BCI scraper) -> `dap_parser.gs` (strict regex parser) -> Google Sheets (`DAPs` sheet, durable state) -> `dap_queue.gs` (FIFO queue, one active DAP) -> Telegram webhook (`telegram.gs` FSM) -> Notion API (`notion.gs`) -> daily liquidation (`dap_cron.gs`).
Liquidation-email pipeline (parallel, closes the loop with the bank's own data): `dap_liquidation.gs` (Gmail `contacto@bci.cl` "Comprobante de liquidación de Depósito a plazo") -> `parseBciLiquidationEmailDetailed` (`dap_parser.gs`) -> Notion (`applyLiquidationToNotion`) -> Sheet (`Liquidado`, real `Fecha_Liquidacion`, final amount). One-off historical reprocess: `dap_reprocess.gs`.
Support: `config.gs` (constants), `utils.gs` (network, text, dates, locks, alerts, sheet access), `uf.gs` (UF value), `renewal.gs` (renewal windows), `setup.gs` (installation), `dap_ops.gs` (operations), `dap_final_amount.gs` (final-amount columns and CLP/UF conversion), `dap_health.gs` (health check, parser canary), `dap_archive.gs` (archived one-off code, **fully commented**).

Audit and roadmap: `AUDITORIA.md` (findings register + continuous improvement), `HOJA_DE_RUTA.md` (evolution). Change log: `CHANGES.md`.

## Entrypoints & Functions

Time-driven triggers (all created by `installDapApp()`, idempotent; table in `setup.gs` `_TRIGGER_SPECS`):
- `processDapEmails()` every 15 min · `processDapLiquidationEmails()` every 30 min · `checkAndLiquidateDaps()` daily 08:00 · `retryNotionSync()` every 30 min · `watchdogTick()` hourly · `healthCheck()` daily 07:00 · `parserCanary()` Mondays 09:00 · `backupSheet()` Sundays 03:00.

Web App (deployed, `ANYONE_ANONYMOUS`, executes as owner):
- `doPost(e)` (`telegram.gs`): Telegram webhook. `doGet(e)`: returns `APP_VERSION` only with the secret token (used by `healthCheck` to detect a stale deployment).
- Telegram commands: `/start`, `/version`, `/liquidar N`.

Manual tools:
- `installDapApp()` — sheet (headers migration, validations, checkboxes, formats, protected header), Notion property `Monto final` (created if missing, best effort), Gmail labels, triggers. Safe to re-run after every deploy.
- `reprocessFinalAmounts()` (simulation, log only) / `reprocessFinalAmountsApply()` (writes) — `dap_reprocess.gs`, optional `monthsBack` (default 24). Phase 1: liquidation emails (real final amount, `Liquidado`, real date; Sheet + Notion). Phase 2: fixed DAPs still without a final amount get the projected "Valor Final" from their capture email. Idempotent, time-budgeted (re-run if the log says "se agotó el tiempo"), reports what is still missing (renewables liquidated with no liquidation email) and sends a Telegram summary when applied.
- `setupWebhook()` — registers the Web App URL (`?token=`) with Telegram; resets `LAST_UPDATE_ID`. Run after creating a new deployment URL.
- `releaseDapQueue()` (`dap_ops.gs`) — returns `ESPERANDO_TELEGRAM` rows to `PENDIENTE_OBJETIVO`, clears legacy cache keys, re-runs the queue.
- `healthCheck()` — runs all checks now and returns the findings.
- Archived (commented) in `dap_archive.gs`: `backfillDapEmails`, `auditPendingDapOperaciones*`, `repairUfDapAmounts*`, `auditCompletedDaps` / `repairCompletedDapsApply` and their Notion helpers. The file lists origin, purpose, when to reuse, dependencies and order; `dap_repair.gs` and `dap_maintenance.gs` were deleted entirely.

## Environment Variables (`PropertiesService.getScriptProperties()`)

Retrieved via `getEnv(key)` (`config.gs`); the full list is `CONFIG.REQUIRED_PROPERTIES` and `healthCheck` verifies it:
- `SHARED_SPREADSHEET_ID` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_CHAT_ID` (authorized chat) · `TELEGRAM_SECRET_TOKEN` (webhook `?token=`; use ≥24 random chars) · `WEB_APP_URL` · `NOTION_API_TOKEN` · `NOTION_DAP_DATABASE_ID` · `CMF_API_KEY` (CMF, UF value; never in code, logs or the repo).
- Internal (managed by the code): `LAST_UPDATE_ID` (Telegram dedupe), `UF_FAILURES` (consecutive UF failures).

## Storage, Schema & Queue Protocol

- **Sheet** `DAPs` (`CONFIG.SHEETS.DAPS`). Column order = `CONFIG.HEADERS.DAPS`: `ID_Interno, ID_Operacion, Monto, Tipo_DAP, Fecha_Inicio, Fecha_Vencimiento, Objetivo, Fecha_Liquidacion, Liquidado, Estado_Cola, ID_Mensaje_Email, Notion_Page_ID, Moneda, Monto_Original, Valor_UF, Paso_Conversacion, Ultimo_Aviso, Avisos_Enviados, Notion_Intentos, Monto_Final, Monto_Final_Original, Valor_UF_Final, Origen_Monto_Final, ID_Mensaje_Liquidacion`. New columns are always appended; `_assertSchema()` (called by `_openDapSheet()`) adds missing trailing headers and **throws if an existing column was renamed/moved**. `Monto` is always CLP (UF DAPs: `Monto_Original` = UF amount, `Valor_UF` = value used). `ID_Operacion` is stored as a number (leading zeros are not significant).
- **Final amount** (same convention as `Monto`): `Monto_Final` is always CLP; `Monto_Final_Original` is in the DAP's currency (UF with decimals, or CLP); `Valor_UF_Final` is the UF value used to convert (UF DAPs). `Origen_Monto_Final` = `CAPTACION` (projection from the capture email's "Valor Final"; **fixed DAPs only**, because a renewable renews and that value is only its first period) or `LIQUIDACION` (real amount from the liquidation email; definitive, replaces any projection, and is never overwritten by a later email). `ID_Mensaje_Liquidacion` is the Gmail message that produced it. The 5 final-amount columns are contiguous (`FINAL_COLUMNS`, `dap_final_amount.gs`) and are written with one `setValues`. A UF DAP's projection may have only `Monto_Final_Original` (CLP is unknown until the UF of the maturity date exists).
- **States** (`CONFIG.STATES`): `PENDIENTE_OBJETIVO` -> `ESPERANDO_TELEGRAM` (with `Paso_Conversacion` = `ESPERANDO_OBJETIVO` | `ESPERANDO_LIQUIDACION`) -> `COMPLETADO`; if Notion fails on finalize: `PENDIENTE_NOTION` (`Notion_Intentos`) -> `retryNotionSync` -> `COMPLETADO`.
- **Conversation state is in the Sheet, not the cache** (cache can be evicted). The active DAP is the single row in `ESPERANDO_TELEGRAM`. `Ultimo_Aviso`/`Avisos_Enviados` drive reminders (after `CONFIG.FSM.REMINDER_HOURS`, max `CONFIG.FSM.MAX_REMINDERS`, then an admin alert).
- **Gmail labels**: `SaaS_Inversiones/DAP_Procesado` (done) and `SaaS_Inversiones/DAP_Error` (email the parser could not read, or a liquidation whose deposit number is not in the Sheet; needs manual review and triggers an alert). A thread is labeled "processed" only if every message was resolved. Both labels are shared by capture and liquidation emails (the subject differs, so the searches never mix).

## Technical Conventions & Gotchas

- **Locks**: never nest `LockService`. Use `_withScriptLock(fn, timeoutMs)` (`utils.gs`) — it reuses the lock already held by the execution. `doPost`, the queue, the extractor, cron, outbox and backup all go through it.
- **Telegram idempotency**: `doPost` dedupes by `update_id` (`_registerUpdate`); Telegram retries slow webhooks. `sendTelegramMessage` returns a boolean, retries as plain text on HTML parse errors and splits >4096 chars — always escape user text with `_escapeHtml`.
- **User text**: the Objetivo is validated (`_validateObjetivo`, ≤200 chars) and written as plain text (`_setPlainText`) so it can never be a formula.
- **Parser is strict** (`parseBciDapEmailDetailed` → `{ok, dto | error{code,message}}`): missing/incoherent data is an error, never a default. Do not reintroduce defaults (Tipo→FIJO, dates→email date, currency→CLP). Every new bank template or parser change needs a real anonymized fixture in `tests/parser.test.js`.
- **Email regex line-crossing**: the shared `_GAP` (`dap_parser.gs`) lets a label and its value sit on the same line or on following lines as long as intermediate lines contain only separators (spaces, `:`, `$`, `UF`) or are blank; it never crosses a line holding another label. Do not use a bare `[^\d]*`. `OPERACION_CANDIDATES` is a priority list (first pattern that matches anywhere wins). `_GAP` is built with `new RegExp(string)`: double the backslashes.
- **Sheets dates**: values from `getValues()` come from another realm, so `instanceof Date` is `false`. Use `_toIsoDate()` / `_isDateObject()` / `_toEpochMs()` (never `new Date(text)`: MM/DD ambiguity).
- **Column access**: always `DAP_COLS.<Header>`, never raw numbers. Open the sheet with `_openDapSheet()`; look rows up with `_findRowByInternalId` / `_findActiveConversation`.
- **Notion**: `pushDapToNotion` is an upsert by `ID operación` (newest page wins when duplicated) that only fills empty fields (including `Monto final`) and upgrades `Liquidado` false→true. Property names live in `CONFIG.NOTION.PROPS` (`_validateNotionSchema` checks them; `Monto final` is a number property that `installDapApp()` creates if missing, copying `Monto`'s number format). Notion errors never block the flow: finalize → `PENDIENTE_NOTION`; cron marks the Sheet only after Notion succeeded. The only writers that **overwrite** are `applyLiquidationToNotion` (real liquidation date + final amount, from the bank's email) — everything else is fill-only (`fillNotionMontoFinal` too).
- **Liquidation emails** (`dap_liquidation.gs`): sender must be an exact address in `CONFIG.BANKS.BCI.LIQUIDATION_SENDERS` (`contacto@bci.cl`), not just the domain. The parser (`parseBciLiquidationEmailDetailed`) is strict and deliberately has **no generic deposit-number fallbacks** (`Número`/`Operación`): a wrong number would liquidate another DAP with someone else's amount. Order is Notion first, Sheet after (Notion failure → thread left unlabeled → retried in 30 min; Sheet never ahead of Notion). Idempotency is **per message** (`ID_Mensaje_Liquidacion`) and per DAP (`Origen_Monto_Final = LIQUIDACION`), not only per thread label: Gmail can merge same-subject emails into an already-labeled thread and `-label:` would hide the new one forever, so the search excludes only `DAP_Error`. A deposit number that is not in the Sheet → `DAP_Error` + one grouped alert (never an invented DAP). The email's date replaces the tentative `Fecha_Liquidacion`. A DAP still in the Telegram queue keeps its state and only stores the liquidation data; `handleDapConversation` then skips the date question and never overwrites the real date. The daily cron ignores rows already `Liquidado`; a row the cron liquidated by tentative date still gets its amount when the email arrives.
- **Network**: all outbound HTTP goes through `_fetchWithRetry` (retries network errors, 5xx and 429 honoring `Retry-After`). URLs are logged only through `_redactUrl` — never put secrets in log text.
- **Gmail search**: `-label:` with nested labels is undocumented, so both `Parent/Child` and `Parent-Child` forms are excluded, labeled threads are also skipped in code, and `healthCheck` verifies the exclusion. Sender is validated by exact domain (`_isAllowedSender`), not by Gmail's partial `from:`.
- **UF**: `getUfValue` (CMF, cached; fallback mindicador.cl; alert after 3 consecutive failures). If the value is unavailable the email is neither enqueued nor labeled (retried next run).
- **Renewable DAPs** (`renewal.gs`): plazo = `Fecha_Vencimiento − Fecha_Inicio`; the email's expiry is the first renewal date; windows are `[Fecha1 + k·plazo, +2 business days]` (Mon–Fri minus `CONFIG.HOLIDAYS`); the tentative liquidation date must fall inside one (the bot proposes the nearest valid date until it does).
- **Deployment versions**: the Telegram webhook runs the **deployed version** of the Web App, not the latest editor code (editor runs and triggers do use the latest). After every import/push create a new version (Deploy → Manage deployments → edit → Version: New version); the URL stays the same. Verify with `/version` or `healthCheck` (compares `doGet` with `APP_VERSION`). Bump `APP_VERSION` on every delivery.
- **Explicit OAuth scopes** (`appsscript.json`): Gmail, Sheets, external requests, triggers. If Apps Script reports insufficient permissions after an import, re-authorize by running any function; last resort: remove `oauthScopes`.
- **Code style**: vanilla modern JS (ES6+, `'use strict'`), JSDoc with types on every function, private helpers prefixed with `_`, no comments that explain the obvious.

## Runbook

- **Deploy**: import the code → run `installDapApp()` (adds the 5 final-amount columns, the trigger `processDapLiquidationEmails` and, if the integration may edit the database, the Notion property `Monto final`; if the log says to create it by hand, add a **Number** property named exactly `Monto final`) → create a new Web App version → send `/version` → run `healthCheck()`.
- **Backfill final amounts** (after the deploy above, once): run `reprocessFinalAmounts()`, read the log (`🧪 [SIMULACIÓN]` lines, per-phase summaries, renewables still without a liquidation email), then `reprocessFinalAmountsApply()`. Re-run if it reports "se agotó el tiempo". Use `monthsBack` (max 120) for older liquidation emails.
- **Liquidation email not applied** (alert "No pude procesar un correo de liquidación" or "no están registrados como DAP"): the thread carries `DAP_Error`. If the deposit is missing from the Sheet add it first (its capture email via `processDapEmails()`, or the archived `backfillDapEmails` for old ones); if the template changed add a fixture to `tests/parser.test.js` and fix `parseBciLiquidationEmailDetailed`; then remove the label from the thread and run `processDapLiquidationEmails()` (the weekly `parserCanary` also re-parses liquidation emails to catch template changes early).
- **Conversation stuck / no prompts**: run `releaseDapQueue()`; the hourly `watchdogTick` also re-drives the queue and sends reminders.
- **Notion down**: DAPs stay `PENDIENTE_NOTION`; `retryNotionSync` retries every 30 min (max `CONFIG.NOTION.MAX_SYNC_ATTEMPTS`, then an alert). After fixing the cause reset `Notion_Intentos` to 0 in the Sheet.
- **Unreadable email** (alert "No pude interpretar un correo de DAP"): review the thread labeled `DAP_Error`; if the template changed add a fixture and fix the parser, deploy, remove the label from the thread and run `processDapEmails()`.
- **Rotate secrets**: change the property, run `setupWebhook()` if the bot token or `TELEGRAM_SECRET_TOKEN` changed, then create a new Web App version. Regenerate the CMF key if it was ever shared.
- **Restore data**: copy a hidden `Backup_YYYY-MM-DD` tab (8 kept) over the `DAPs` tab; Google Sheets version history covers loss of the whole file.
- **Reuse archived tools**: see the header of `dap_archive.gs` (select the code block, toggle comments with Ctrl+/, run the simulation first, comment it again afterwards).
- **Alerts for failures before Telegram can be used**: link the script to a standard GCP project and create a Cloud Logging alert on `severity=ERROR`.

## Local Development

- `package.json` + `eslint` + `jest` (+ `clasp`) live on disk but are **not tracked** (`.gitignore`): only `.gs`, `appsscript.json` and `.md` files are committed. `.eslintrc.js` generates the shared globals from the top-level declarations of every `.gs`.
- Commands: `npm test`, `npm run lint`. Tests load the whole project into one context with in-memory Sheets, Gmail, Notion, Telegram, cache, locks and triggers (`tests/helpers/harness.js`); `tests/archive.test.js` uncomments `dap_archive.gs` in memory and runs the archived functions, so the archive stays valid. Archived code is edited by hand in `dap_archive.gs` (each line prefixed with `// `).
- Not testable locally: real Gmail/Sheets/Telegram/Notion behavior; after deploying run `installDapApp()`, `healthCheck()` and answer one DAP end to end.
