# Contrato de datos — Diagnóstico ROI Delta Teams

Este documento define el objeto `data` que produce el pipeline y consume `template-delta.html` (111 placeholders únicos, 4 páginas A4). Es el equivalente del schema de GTM en CLAUDE.md. **Regla madre (heredada de GTM): la IA nunca escribe números de dinero ni datos duros de empresas; eso viene de `calculo.js` y del research real (MCP + web_search con fuente).**

## Origen de cada campo

### 1. CÓDIGO (`calculo.js`) — la IA no los toca
Los 18 montos USD, todos formateados `$92,160 USD`:
`INEFF_COST_ANNUAL`, `INEFF_COST_MONTHLY`, `SAVINGS_CONSERVATIVE_ANNUAL`, `SAVINGS_OPTIMISTIC_ANNUAL`,
`PROJ_SQ_Y1..Y3`, `PROJ_SQ_TOTAL`, `PROJ_CONS_Y1..Y3`, `PROJ_CONS_TOTAL`, `PROJ_OPT_Y1..Y3`, `PROJ_OPT_TOTAL`.
Además: `REPORT_DATE` (mes y año en español, ej. "Junio 2026").

Inputs del motor: `headcountLeadership` (research), `costoHora` y `horasPerdidas` (los propone la IA en RESEARCH con justificación; `clampCostoHora`/`clampHorasPerdidas` los encierran en los benchmarks del skill). Crecimiento proyección: 12% anual fijo.
Verificado: reproduce 16/16 cifras del PDF de ejemplo (Optimissa México, 8 líderes × $40/h × 6h).

### 2. RESEARCH REAL (MCP + web_search, nunca inventado)
| Placeholder | Fuente |
|---|---|
| `COMPANY_NAME`, `COMPANY_INDUSTRY`, `COMPANY_HEADCOUNT_TOTAL`, `COMPANY_LOCATION`, `COMPANY_COUNTRY` | `lookup_company` / `get_contact_profile` (MCP). Industria confiable viene de la búsqueda de empresas, no del perfil (ver memoria). |
| `COMPANY_HEADCOUNT_LEADERSHIP` | Conteo de líderes REALES vía Sales Nav company-first (seniority director+ anclado a la empresa). Fallback: `liderazgoEstimado()` de la tabla del skill, marcando "estimado". |
| `REF_NAME`, `REF_DESC`, `REF_METRIC_1..4_LABEL/VALUE`, `REF_FUENTE` | web_search con guarda de recencia. **Toda métrica del referente necesita fuente; `REF_FUENTE` no puede quedar vacía.** |

### 3. IA (copy con presupuesto de caracteres)
| Campo | Máx. chars | Nota |
|---|---|---|
| `HEADLINE` | 110 | |
| `SUBHEADLINE` | 220 | |
| `DIAGNOSIS_HEADING` | 60 | |
| `DIAGNOSIS_BODY` | 520 | Patrón de industria, JAMÁS afirmaciones sobre el CEO/contacto |
| `BENCHMARK_NOTA` | 160 | "Estimación basada en benchmark operativo para [industria] en [país]" |
| `INEFF_1..4_TITLE` / `_DESC` | 55 / 220 | Elegir 4 fuentes de fricción distintas (lista del skill) |
| `TIMEBARS_HEADING` | 70 | |
| `BAR_1..4_LABEL` / `_PCT` | 45 / entero | PCT: enteros 5-60, **suma exacta 100** (distribución ilustrativa) |
| `REF_NARRATIVA` | 480 | Solo hechos con fuente + espejo con el prospecto |
| `GAP_1..6_DIM` / `_PROSPECT` / `_REF` | 30 / 40 / 45 | Lado prospecto = observado o patrón declarado; lado referente = investigado o benchmark |
| `GAP_CLOSING_BODY` | 440 | |
| `PLAN_INTRO` | 220 | |
| `OKR_1..2_OBJETIVO` | 80 | |
| `OKR_x_KR_1..3` | 70 | |
| `OKR_x_HOY/META/REF_1..3` | 15 | Cifras "Referente" solo de whitelist Delta o benchmark citado |
| `BENEFIT_1..2_TITLE` / `_DESC` | 55 / 150 | Del catálogo de beneficios del skill |
| `PROJ_NOTA` | 320 | Debe mencionar el supuesto de crecimiento 12% |
| `QUOTE` | 260 | Sin métricas inventadas |
| `CTA_HEADING` / `CTA_BODY` | 90 / 200 | Body siempre "con Camila", nunca el nombre del prospecto |

Fijo en template (la IA no interviene): logo SVG, headers de página, footer, etiquetas del hero, headings fijos, badges Q1/Q2, labels de la tabla de proyección, botón y URL del CTA (calendly de Camila).

## Guardas determinísticas (el juez no las puede saltar)

1. **Presupuestos de longitud** por campo (tabla de arriba) → recorte o re-generación.
2. **`_sinGuiones`**: sin em dashes (—) en ningún campo (ya existe en server.js).
3. **Framing TEPI**: regex case-sensitive `\b(DOS|Rocks|L10|People Analyzer|EOS|Traction)\b` → rechazo. Ojo: "DOS" solo en mayúsculas ("dos" en español es válido).
4. **Sin montos en copy IA**: `$\d` en campos de IA → rechazo salvo que coincida exactamente con un monto calculado.
5. **Nombre del contacto en `DIAGNOSIS_BODY`** → rechazo (regla 3 del skill).
6. **Bars**: 4 enteros en [5,60] que suman 100.
7. **Cantidades exactas**: 4 fricciones, 4 bars, 4 métricas de referente, 6 gaps, 2 OKRs × 3 KRs, 2 benefits.
8. **CTA**: contiene "Camila", no contiene el nombre del prospecto.
9. **Whitelist de cifras Delta/IBT** en copy: 61.4%, 81.7%, -30%, +20-40%, 90 días.
10. **`REF_FUENTE` no vacía** si hay métricas de referente.
11. **PDF = 4 páginas exactas** (pdf-lib, equivalente a EXPECTED_PAGES=4) + chequeo de overflow.
12. **Clamps de supuestos**: `clampCostoHora` (benchmark país×industria), `clampHorasPerdidas` (5-8).

## Juez (fail-closed, 8 criterios propuestos)

1. Anti-invención de datos del prospecto. 2. Referente verificable con fuente y reciente. 3. Diagnóstico = patrón de industria. 4. Framing TEPI (voz ejecutiva, sin metodología interna). 5. Español LATAM neutro, sin voseo, trato profesional. 6. Coherencia numérica copy ↔ montos calculados. 7. Roles confirmados vs inferidos declarados con honestidad. 8. CTA y branding correctos.

## Diferencias vs el skill manual (decisiones de productización)

- **Checkpoints A y B (aprobación humana) se eliminan**: los reemplazan las guardas + el juez, igual que en GTM.
- **weasyprint → Puppeteer** (ya está en Railway); el hack del `linear-gradient` en las barras se conserva porque también evita depender de `width%` dinámico.
- **El skill dice "1 página, máx 2"; el template de referencia tiene 4 páginas.** Se productiza la versión de 4 páginas (instrucción del 2026-07-06). `EXPECTED_PAGES_DELTA=4`.
- **Benefits**: el skill pide 3, el template usa 2 cards en página 3 → schema fija 2.
- Research de líderes: de búsquedas manuales (RocketReach/ZoomInfo) → Sales Nav company-first vía MCP (más confiable, personas reales con URN).
