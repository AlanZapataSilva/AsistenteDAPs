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
- **Lee los correos de liquidación** del banco (`contacto@bci.cl`, "Comprobante de liquidación de Depósito a plazo"): marca el DAP como liquidado en Sheet y Notion con la fecha real y guarda su **monto final** (para analizar ganancias). Los DAP fijos además registran una proyección del monto final desde el correo de toma; `reprocessFinalAmounts()` completa el historial.
- **Se vigila a sí mismo**: alertas por Telegram, `healthCheck` diario, canario semanal del parser y respaldo semanal del Sheet.

## Puesta en marcha

1. Crear el proyecto de Apps Script y subirle el código con `clasp` (ver *Flujo de trabajo* más abajo).
2. Configurar las **Propiedades del script** (ver la lista en `AGENTS.md`): `SHARED_SPREADSHEET_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_SECRET_TOKEN` (≥24 caracteres aleatorios), `WEB_APP_URL`, `NOTION_API_TOKEN`, `NOTION_DAP_DATABASE_ID`, `CMF_API_KEY`.
3. Ejecutar `installDapApp()` (hoja, etiquetas de Gmail y triggers).
4. Desplegar como **Aplicación web** (ejecutar como yo, acceso: cualquiera), copiar la URL en `WEB_APP_URL` y ejecutar `setupWebhook()`.
5. Verificar con `/version` en el bot y ejecutar `healthCheck()`.

Tras **cada** subida de código hay que crear una *nueva versión* de la implementación: el webhook ejecuta la versión desplegada, no la del editor. `npm run deploy` lo hace automáticamente.

## Flujo de trabajo (local ↔ Apps Script con `clasp`)

El código se edita en local y se sube a Apps Script con [`clasp`](https://github.com/google/clasp); **GitHub se usa solo para colaboración y versionamiento** (ramas, PRs, historial), nunca como vía de despliegue.

```
editar en local → npm test / npm run lint → npm run push → (Web App) npm run deploy → commit / PR en GitHub
```

| Comando | Qué hace |
|---|---|
| `npm run push` | Sube a Apps Script solo los `*.gs` y `appsscript.json` (filtro en `.claspignore`). Afecta de inmediato a los triggers (usan el código más reciente), **no** al webhook de Telegram. |
| `npm run deploy` | Tests + lint → `clasp push` → nueva versión del Web App **en el mismo deployment** (la URL no cambia). Después enviar `/version` al bot. |
| `npm run status` | Muestra qué archivos subiría `clasp`. |
| `npm run pull` | Baja el código remoto. Solo para cuando alguien editó en el editor web; quita saltos de línea finales (diff cosmético). |

Configuración inicial en un equipo nuevo:

1. `npm install` y `npx clasp login` (cuenta dueña del proyecto de Apps Script; hay que activar la *Apps Script API* en <https://script.google.com/home/usersettings>).
2. Copiar `.clasp.json.example` a `.clasp.json` y poner el `scriptId` (URL del editor de Apps Script o `npx clasp list-scripts`). Está fuera de git.
3. Para `npm run deploy`: crear `.clasp.deploy.json` con `{ "deploymentId": "..." }` (el deployment que **no** es `@HEAD` en `npx clasp deployments`). También fuera de git.

Regla: no editar en el editor web de Apps Script; si ocurre, hacer `npm run pull` y revisar el diff antes del siguiente `push` (que sobrescribe el remoto, incluido el manifiesto).

## Documentación

- [`AGENTS.md`](AGENTS.md) — arquitectura, esquema, convenciones y **runbook** operativo.
- [`AUDITORIA.md`](AUDITORIA.md) — auditoría de producción, registro de hallazgos y proceso de mejora continua.
- [`HOJA_DE_RUTA.md`](HOJA_DE_RUTA.md) — evolución: nuevas funciones, otros productos y otros bancos.
- [`CHANGES.md`](CHANGES.md) — historial de cambios.
- `dap_archive.gs` — funciones puntuales de completado/reparación de datos, archivadas y comentadas (con instrucciones para reactivarlas).
