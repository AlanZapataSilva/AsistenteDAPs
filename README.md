# AsistenteDAPs

Asistente de gestión de Depósitos a Plazo (DAP) automatizado con Google Apps Script (GAS): lee los comprobantes del BCI en Gmail, los registra en Google Sheets, conversa con su dueño por Telegram para completar el objetivo de cada DAP y los sincroniza con una base de datos de Notion. Soporta DAP fijos y renovables, en pesos y en UF (convertidos con el valor de la UF de la fecha de captación).

```
Gmail (BCI) → parser estricto → Google Sheets → cola FIFO → Telegram ↔ usuario → Notion
                                                    ↑                          ↓
                                         watchdog / recordatorios      liquidación diaria
```

## Qué hace

- **Detecta** correos de toma de DAP y los interpreta de forma estricta (si un dato falta o no cuadra, el correo queda marcado con `DAP_Error` y se avisa; nunca se inventan datos).
- **Pregunta** por Telegram, de a un DAP a la vez, el objetivo del dinero (y, en los renovables, una fecha de liquidación dentro de una ventana de renovación).
- **Sincroniza** con Notion sin duplicar (upsert por número de operación) y reintenta solo si Notion falla.
- **Liquida** automáticamente los DAP vencidos y avisa.
- **Se vigila a sí mismo**: alertas por Telegram, `healthCheck` diario, canario semanal del parser y respaldo semanal del Sheet.

## Puesta en marcha

1. Crear el proyecto de Apps Script con los archivos `.gs` y `appsscript.json` de este repositorio.
2. Configurar las **Propiedades del script** (ver la lista en `AGENTS.md`): `SHARED_SPREADSHEET_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_SECRET_TOKEN` (≥24 caracteres aleatorios), `WEB_APP_URL`, `NOTION_API_TOKEN`, `NOTION_DAP_DATABASE_ID`, `CMF_API_KEY`.
3. Ejecutar `installDapApp()` (hoja, etiquetas de Gmail y triggers).
4. Desplegar como **Aplicación web** (ejecutar como yo, acceso: cualquiera), copiar la URL en `WEB_APP_URL` y ejecutar `setupWebhook()`.
5. Verificar con `/version` en el bot y ejecutar `healthCheck()`.

Tras **cada** importación de código hay que crear una *nueva versión* de la implementación: el webhook ejecuta la versión desplegada, no la del editor.

## Documentación

- [`AGENTS.md`](AGENTS.md) — arquitectura, esquema, convenciones y **runbook** operativo.
- [`AUDITORIA.md`](AUDITORIA.md) — auditoría de producción, registro de hallazgos y proceso de mejora continua.
- [`HOJA_DE_RUTA.md`](HOJA_DE_RUTA.md) — evolución: nuevas funciones, otros productos y otros bancos.
- [`CHANGES.md`](CHANGES.md) — historial de cambios.
- `dap_archive.gs` — funciones puntuales de completado/reparación de datos, archivadas y comentadas (con instrucciones para reactivarlas).
