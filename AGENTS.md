# AGENTS.md

## Overview & Architecture

Google Apps Script (GAS) microservice on V8 runtime (`America/Santiago` timezone) managing Term Deposits (DAPs) across Gmail (BCI), Google Sheets, Telegram Bot, and Notion API.

Data Pipeline:
`dap_extractor.gs` (Gmail BCI scraper) -> `dap_parser.gs` (Regex DTO parser) -> Google Sheets (`DAPs` sheet) -> `dap_queue.gs` (FIFO queue) -> Telegram Webhook (`telegram.gs` FSM) -> Notion API (`notion.gs`) -> Daily liquidation cron (`dap_cron.gs`).

## Trigger Entrypoints & Functions

- **Infrastructure Setup**: `installDapApp()` (`setup.gs`) — Prepares Sheet headers, Gmail label, and time-driven triggers (`processDapEmails`, `checkAndLiquidateDaps`) via `_setupTriggers()`. Idempotent; run manually once (safe to re-run after redeploys).
- **Webhook Registration**: `setupWebhook()` (`telegram.gs`) — Registers GAS Web App URL with Telegram Bot API. Run manually after deployment.
- **Email Processing Trigger**: `processDapEmails()` (`dap_extractor.gs`) — Scheduled time-driven trigger.
- **Daily Liquidation Trigger**: `checkAndLiquidateDaps()` (`dap_cron.gs`) — Scheduled daily time-driven trigger.
- **Webhook Endpoint**: `doPost(e)` (`telegram.gs`) — Receives Telegram updates.
- **Historical Backfill**: `backfillDapEmails(monthsBack, maxThreads)` (`dap_extractor.gs`) — Manual one-off run to reprocess emails outside the normal 30-day window. Safe to re-run (Gmail label exclusion prevents duplicates).
- **Data Repair**: `auditPendingDapOperaciones()` (`dap_maintenance.gs`) — Manual one-off run after a `dap_parser.gs` fix: re-parses the original email (via `ID_Mensaje_Email`) for every row not yet `COMPLETADO` and corrects `ID_Operacion` if it no longer matches. Never touches `COMPLETADO` rows (may already be synced to Notion).

## Environment Variables (`PropertiesService.getScriptProperties()`)

Retrieved via `getEnv(key)` defined in `config.gs`. Required keys:
- `SHARED_SPREADSHEET_ID`: Target Google Sheet ID.
- `TELEGRAM_BOT_TOKEN`: Telegram bot auth token.
- `TELEGRAM_CHAT_ID`: Authorized Telegram user/chat ID (enforced by security check).
- `TELEGRAM_SECRET_TOKEN`: Secret query token (`?token=`) for webhook URL validation.
- `WEB_APP_URL`: URL of deployed GAS Web App.
- `NOTION_API_TOKEN`: Notion Integration Bearer token.
- `NOTION_DAP_DATABASE_ID`: Notion target database UUID.

## Storage, Schema & Queue Protocol

- **Sheet Name**: `DAPs` (`CONFIG.SHEETS.DAPS`).
- **Strict Column Order**: `[ID_Interno, ID_Operacion, Monto, Tipo_DAP, Fecha_Inicio, Fecha_Vencimiento, Objetivo, Fecha_Liquidacion, Liquidado, Estado_Cola, ID_Mensaje_Email, Notion_Page_ID]`
- **Queue States (`Estado_Cola`)**: `PENDIENTE_OBJETIVO` -> `ESPERANDO_TELEGRAM` -> `COMPLETADO`.
- **FSM Cache Keys (`CacheService`)**: `${chatId}_ACTIVE_DAP` & `${chatId}_DAP_STEP` (6-hour / 21600s TTL).
- **Gmail Idempotency Label**: `SaaS_Inversiones/DAP_Procesado` (`CONFIG.GMAIL.LABEL_DAP_PROCESSED`).

## Technical Conventions & Gotchas

- **Concurrency Locks**: `dap_cron.gs`, `dap_queue.gs`, and `dap_extractor.gs` acquire `LockService.getScriptLock().tryLock(10000)` to prevent parallel executions.
- **Sheet Mutation**: Always execute `SpreadsheetApp.flush()` after modifying Sheet values before calling external APIs (Notion/Telegram).
- **Webhook Security**: `doPost(e)` verifies both `e.parameter.token === TELEGRAM_SECRET_TOKEN` and `incomingChatId === TELEGRAM_CHAT_ID`.
- **Single Active DAP Invariant**: `pingNextPendingDap()` (`dap_queue.gs`) must check `${chatId}_ACTIVE_DAP` in `CacheService` before advancing the queue. Without this guard, a new email arriving mid-conversation overwrites the FSM cache and permanently orphans the previous row in `ESPERANDO_TELEGRAM` (it's no longer `PENDIENTE_OBJETIVO`, so the queue never revisits it, and the cache no longer points to it). Do not remove this check.
- **Column Access**: Never index sheet rows/ranges with raw numbers. Use `DAP_COLS.<HeaderName>` (`config.gs`, derived from `CONFIG.HEADERS.DAPS`) so column access stays correct if the header order ever changes.
- **Outbound HTTP**: `sendTelegramMessage`, `pushDapToNotion`, and `updateNotionDapStatus` go through `_fetchWithRetry()` (`utils.gs`), which retries on network exceptions/5xx and gives up immediately on 4xx.
- **Notion Upsert**: `pushDapToNotion()` (`notion.gs`) looks up the DAP by `ID operación` (`_findNotionPageByOperacion`) before creating. If found, it complements only empty fields and upgrades `Liquidado` false→true (never the reverse, never overwrites a present value) instead of creating a duplicate page. Relies on `ID_Operacion` being extracted correctly — see next point.
- **Email Regex Line-Crossing**: In `dap_parser.gs`, `[^\d]` character classes match newlines too. A bare `[^\d]*` gap between a label and its value can silently cross into an unrelated table row/section if a generic fallback alternative (e.g. `Operaci.n`) matches earlier in the email than the intended field (e.g. a "Detalle de la operación" heading before the real data table) — this actually happened in production (captured "N° Transacción" instead of "N° Depósito"). All label→value gaps in `MONTO`, `FECHA_INICIO`, `FECHA_VENCIMIENTO`, and `OPERACION_CANDIDATES` use `(?:[^\d\r\n]*\r?\n)?[^\d\r\n]*` instead: allows the label and value to be on the same line OR adjacent lines, but never further apart. `OPERACION_CANDIDATES` is also tried as a priority-ordered list (first pattern that matches anywhere wins), not a single combined alternation, specifically to avoid leftmost-match picking a less-specific alternative over a more reliable one. Don't revert to a single unbounded `[^\d]*` or a combined alternation for these fields.
- **Code Style**: Vanilla modern JS (ES6+, `'use strict'`), JSDoc comments, private helpers prefixed with `_`.

## Local Development

- **Tooling**: `package.json` + `clasp` (Google Apps Script CLI) for local edit/push, `eslint` for linting, `jest` for unit tests. No transpilation/bundling — files stay plain `.gs`/CommonJS-free scripts pushed as-is.
- **Setup**: `npm install`, then `npx clasp login` and copy `.clasp.json.example` to `.clasp.json` with your own `scriptId` (never commit `.clasp.json` — it's gitignored).
- **Commands**: `npm run lint`, `npm test`, `npm run push` (`clasp push`).
- **Tests**: `tests/` loads `.gs` files via `tests/helpers/loadGasFile.js` (a small `vm`-based loader with stubbed GAS globals), since these files aren't CommonJS modules. Covers `dap_parser.gs` (regex extraction, including a regression test for the "N° Transacción vs N° Depósito" bug), the `pingNextPendingDap` active-session guard, and the `notion.gs` upsert logic.
- **What's not testable here**: end-to-end Gmail/Sheets/Telegram/Notion flows require a real deployment; after `clasp push`, run `installDapApp()` once from the Apps Script editor to confirm triggers are created, then send a test BCI email through `processDapEmails()`.
