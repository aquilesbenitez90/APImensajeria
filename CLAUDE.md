# CLAUDE.md — IBT GTM Report Service

Servicio que genera **lead magnets** automáticos: PDFs de análisis de mercado personalizados que IBT envía a sus prospectos. El producto es la **credibilidad del lead**, por eso casi toda la lógica está orientada a **no inventar datos**.

## Arquitectura

```
N8N (cada 5 min) → lee chats IBT → detecta email + keyword "mercado"
  → POST /generar → polling /resultado → envía PDF por Gmail
                          │
                     server.js (Express en Railway)
   PIPELINE 3 FASES:
   1. PLAN   — Claude + web_search → investiga cliente + define ICP + página 1
   2. SOURCE — código + MCP Sales Navigator → busca candidatos REALES
   3. SELECT — Claude → elige personas (por id) + escribe ángulo/hook
   → render.js (template.html + data) → HTML → Puppeteer → PDF
   → JUEZ (Claude, 8 criterios) → guardas determinísticas → veredicto
```

## Archivos

- **server.js** (~1357 líneas) — todo el pipeline, el juez, las guardas y los endpoints.
- **render.js** — pega el objeto `data` en `template.html` (placeholders `{{key}}`). La IA **NO** genera HTML, solo el objeto `data`. Sanea links de LinkedIn e inyecta el logo del repo.
- **template.html** — diseño fijo del PDF.
- **logo-white.png** — logo inyectado como data URI, pisa el embebido de la plantilla.
- **Lead Magnet generator - GTM (2).json** — workflow N8N (34 nodos) que dispara y distribuye. No es código del servicio; es el orquestador externo.

## Endpoints

| Método | Ruta | Notas |
|---|---|---|
| POST | `/generar` | Async. Body `{email,dominio,empresa,nombre,profileId,destinatario}`. `destinatario` = link/public-id de LinkedIn de la persona que RECIBE el reporte (opcional): ancla el país y el alcance del documento a su operación (clave en multinacionales). Devuelve `{jobId}`. **Idempotente** por lead (dedup `enProgreso`). |
| GET | `/resultado/:jobId` | Estado del job. `status`: processing / ok / error. |
| POST | `/generar-reporte` | **Síncrono**. Requiere `email` y `dominio`. `eval:true` o `debug:true` incluye el objeto `data` estructurado en `reporte` (úsalo para auditar). |
| GET | `/health` | `{ok, jobs_activos, cuentas}`. |

## Comandos

```powershell
npm install        # instala express, puppeteer, pdf-lib
npm start          # node server.js (PORT o 3000)
```

Deploy: Railway (nixpacks.toml instala chromium para Puppeteer). El N8N en producción apunta a `https://apimensajeria-production.up.railway.app`.

## Variables de entorno

Obligatorias: `ANTHROPIC_API_KEY`, `IBT_EMAIL`, `IBT_PASSWORD`. Opcional `PORT`.
Tuning (con default): `NUM_CUENTAS=3`, `EXPECTED_PAGES=0` (0 = el juez NO valida páginas), `SOURCE_CONCURRENCY=4`, `SOURCE_HOME_MIN`, `SOURCE_ENRICH_TOP=12`, `SOURCE_TO_IA=18`, `SOURCE_MIN_2ND=4`, `ICP_MIN_HEADCOUNT=20`, `PLAN_MAX_TOOL_ITERS=8`, `SELECT_MAX_TRIES=3`, `PEER_INDUSTRY_CHECK=on` (filtro anti-peer por industria de empresa), `MIN_CARDS_OK`, `CLAUDE_MAX_RETRIES=3`, `CLAUDE_TIMEOUT_MS=240000`, `WS_DEBUG=1` (log de web_search), `LOGO_PATH`.

## Modelos

`MODEL_GEN` = `claude-sonnet-4-6` (generador). `MODEL_JUDGE` = `claude-opus-5` (jueces: veracidad + comercial) — modelo DISTINTO del generador a propósito (self-preference bias; votos del mismo modelo son correlacionados). Ambos overrideables por env. `JUDGE_VOTES=1` default (la diversidad viene de dos jueces de lente distinta, no de N copias). OJO: Opus 5 rechaza `temperature` (callClaude la filtra por modelo) y piensa por default (los llamados del juez llevan maxTokens holgado). Caching de prompts activado. Costeo en `costoDe()` con tarifas por modelo (`_ratesDe`: Sonnet/Haiku/Opus).

## Schema del objeto `data` (lo que devuelve el pipeline y consume render.js)

```
empresa, fecha, eyebrow, h1_pre, h1_company, h1_post, lead, proof,
ribbon[3]{label,value}, stats[4]{num,label}, icp[4]{title,desc},
context[3], apertura[3], prioridades[4],
cards[NUM_CUENTAS]{empresa,nombre,cargo,slug,urn,ubicacion,grado,angulo,hook}
```
`urn` = member URN real de LinkedIn (`ACwAA...`); el href usa `urn`, el texto visible usa `slug`.

## Reglas que NO se pueden romper (el corazón del producto)

- **Anti-invención**: la IA solo aporta `id` + `angulo` + `hook` en SELECT, y el contenido de página 1 en PLAN. Los datos duros de cada persona (nombre, cargo, empresa, link, grado) vienen de Sales Navigator **real** — nunca se inventan.
- **Principio rector** (prompt PLAN): el nivel de certeza al escribir debe igualar al de la fuente. Prohibido inventar métricas, años de fundación, certificaciones, nombres de terceros.
- **Sin guiones** (— ni -) como conectores en ningún texto generado (`_sinGuiones`).
- **Español neutro latinoamericano**, trato de "usted", sin voseo.
- **Cantidades exactas** del schema: ribbon 3, stats 4, icp 4, context 3, apertura 3, prioridades 4.
- **Geografía**: las cards deben estar en el/los país(es) del ICP. `_geoIncoherente` lo fuerza.

## Defensas (defensa en profundidad)

1. Prompts anti-invención (PLAN/SELECT).
2. **Juez** (`SYSTEM_PROMPT_JUDGE`, server.js:176) — 8 criterios, APROBADO solo 8/8, **fail-closed** (si no parsea → RECHAZADO).
3. Guardas determinísticas que el juez no puede saltar: `_geoIncoherente`, `_tamanoIncoherente`, override de integridad (`cardsValidas < MIN_CARDS_OK`), `_sinInventos` (regex que borra "+300 servicios" típicos).
4. Reintentos: `seleccionarConRetry` (hasta SELECT_MAX_TRIES), 1 ronda de fixes del juez.

## Gotchas

- **Dos endpoints duplican ~90 líneas** de lógica de evaluación (`procesar` vs `/generar-reporte`). Si cambiás la evaluación, cambiá en LOS DOS.
- **MCP_URL hardcodeada** (server.js:50).
- `EXPECTED_PAGES=0` por default → el juez no valida el número de páginas. Setear `=2` cuando se confirme.
- `Date.now()` como id JSON-RPC del MCP puede colisionar bajo concurrencia (menor).
- Estado de tokens aislado por job con `AsyncLocalStorage` (no usar globales mutables).

## Convenciones de código

- Español en comentarios y logs. Logs con prefijo `[ETAPA]`: `[MCP]`, `[CLIENTE]`, `[SOURCE]`, `[SELECT]`, `[JUDGE]`, `[GEO]`, `[TAM]`, `[TOKENS]`, `[FIX]`, `[INTEGRIDAD]`.
- Helpers privados con `_` (ej. `_norm`, `_empKey`, `_parsePeople`).
- Sin framework de tests por ahora; `module.exports` al final expone helpers puros para testear.
