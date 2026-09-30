# Hoja de ruta — evolución de AsistenteDAPs

Ideas priorizadas por **valor** (V) y **esfuerzo** (E), de 1 (bajo) a 3 (alto). Nada de esto está implementado: es el registro de deuda técnica y de evolución (revisar cada trimestre, ver `AUDITORIA.md`).

## 1. Con los productos actuales (DAP en CLP y UF, fijos y renovables)

| Idea | V | E | Detalle |
|---|---|---|---|
| Alertas de vencimiento y de ventana | 3 | 1 | Avisar 7/3/1 día antes del vencimiento de un DAP fijo y al abrirse cada ventana de renovación (los datos ya están: `renewal.gs`). Nuevo trigger diario. |
| Confirmar la liquidación de renovables | 3 | 2 | Hoy el cron marca `Liquidado` por la fecha *tentativa*. Preguntar por Telegram con botones (Sí / No, sigue renovándose) y registrar la respuesta. |
| Eventos en Google Calendar | 2 | 1 | Crear un evento por vencimiento/ventana (`CalendarApp`, un scope más) con recordatorios. |
| `/resumen` y `/proximos` | 3 | 2 | Capital por moneda, tasa ponderada, vencimientos del mes y flujo mensual esperado. Comandos nuevos en `_routeMessage`. |
| Extraer Tasa, Ganancia y Valor Final | 3 | 1 | El correo los trae y hoy se descartan. Con ellos: TEA real, "recibirás $X el DD", proyección de flujo de caja. Requiere columnas nuevas y ampliar el parser + fixtures. |
| Leer correos de renovación y pago | 3 | 2 | Cerrar el ciclo de forma automática en vez de depender de la fecha tentativa (nueva plantilla → nuevo fixture). |
| Metas por Objetivo | 2 | 2 | Monto objetivo por meta y progreso; vistas/rollups de Notion por Objetivo. |
| Botones en Telegram | 2 | 2 | Teclados en línea para `/liquidar`, confirmaciones y "saltar" (menos errores de tipeo). Comandos `/cancelar` y `/descartar` para falsos positivos. |
| Consultas en lenguaje natural | 2 | 3 | "¿Cuánto vence en noviembre?" resuelto con Gemini/Claude sobre el Sheet (solo lectura, con esquema fijo). |
| Feriados de Chile | 1 | 1 | Cargar `CONFIG.HOLIDAYS` automáticamente desde una API pública (hoy solo se excluyen fines de semana). |
| Fecha de inicio de la ventana en día no hábil | 1 | 1 | Si `Fecha1 + k·plazo` cae en fin de semana/feriado, desplazar la ventana (el banco renueva el siguiente día hábil). |

## 2. Otros productos financieros

- **Modelo `Instrumento`** (`DAP`, `FONDO_MUTUO`, `APV`, `AHORRO`, `ETF`…): columna `Instrumento` y clave compuesta (`Banco` + `ID_Operacion`) para que los números de operación de distintos productos/bancos no colisionen. Cada instrumento define su parser, su conversación de Telegram y sus campos de Notion.
- **Fondos mutuos / APV**: valor cuota diario (CMF publica valores de fondos), rentabilidad acumulada y aportes; el flujo "correo → cola → objetivo" se reutiliza.
- **Moneda genérica**: hoy CLP y UF. Agregar USD/EUR con un proveedor de tipo de cambio (CMF/mindicador), generalizando `getUfValue` a `getFxRate(moneda, fecha)`.

## 3. Otros bancos

- **Registro de parsers** `BANK_PARSERS = { bci: {...}, chile: {...} }` con `{dominios, asunto, patrones, fixtures}`; `_isAllowedSender`, `_buildDapSearchQuery` y el parser se resuelven por banco. Columna `Banco`.
- Candidatos: Banco de Chile, Santander, Itaú, Scotiabank, BancoEstado, Falabella. Cada uno exige **fixtures reales anonimizados** y el canario del parser para detectar cambios de plantilla.
- **Parser con LLM como respaldo** (Gemini/Claude): cuando los patrones fallan, extraer con salida estructurada validada por el mismo esquema estricto (`parseBciDapEmailDetailed`), enmascarando datos sensibles y **confirmando por Telegram** antes de encolar. Acelera la incorporación de bancos nuevos.
- **Sistema de Finanzas Abierto** (Chile): monitorear su disponibilidad como fuente directa de datos en vez de leer correos.

## 4. Infraestructura, calidad y seguridad

| Idea | V | E | Detalle |
|---|---|---|---|
| Fase 3: DevOps | 3 | 2 | Llevar `package.json`, tests y ESLint al repo con `.claspignore`; GitHub Actions (lint, tests, type-check); `clasp push` + `clasp deploy --deploymentId` automático. Elimina la clase de errores "Web App desactualizado". |
| Eliminar el endpoint público | 3 | 3 | Hoy `doPost` es público y protegido por token en la URL + `chat_id`. Alternativas: *polling* (`getUpdates`, sin endpoint) con trigger de 1 min, o un proxy (Cloudflare Worker) que valide el header `X-Telegram-Bot-Api-Secret-Token` y reenvíe. |
| Verificar autenticidad del correo | 2 | 2 | Leer `Authentication-Results` (DKIM/SPF) con la API avanzada de Gmail en vez de confiar en el `From`. |
| Migrar a la API de Notion con *data sources* | 2 | 2 | Cambiar `Notion-Version` (hoy `2022-06-28`) y usar `data_source_id`; planificar antes de que retiren la versión actual. |
| `@ts-check` + `@types/google-apps-script` | 2 | 2 | Type-check en CI; los tipos ya están documentados en JSDoc. |
| Namespaces por módulo | 1 | 3 | Hoy todos los `.gs` comparten scope global; agrupar en objetos (`Notion.*`, `Parser.*`) evita colisiones cuando crezca el proyecto. |
| Multiusuario | 1 | 3 | Hoy un único `TELEGRAM_CHAT_ID` y un Sheet. Separar estado y configuración por usuario. |
| Registro de auditoría | 1 | 1 | Pestaña `Bitacora` con las transiciones de estado (quién/cuándo/qué) para trazabilidad. |
| Alertas de Cloud Logging | 2 | 1 | Vincular el script a un proyecto GCP estándar y crear una política sobre `severity=ERROR` (cubre fallos previos al envío de Telegram). |

## Orden sugerido

1. Alertas de vencimiento + Calendar + extraer Tasa/Ganancia/Valor Final (valor alto, esfuerzo bajo; usan datos que ya se leen).
2. Fase 3 DevOps y alertas de Cloud Logging (protegen todo lo demás).
3. Confirmación de liquidación de renovables y botones de Telegram (cierran los últimos puntos manuales).
4. Registro de parsers + segundo banco, con el canario y los fixtures como red de seguridad.
5. Eliminar el endpoint público y verificar DKIM antes de manejar más productos o más dinero.
