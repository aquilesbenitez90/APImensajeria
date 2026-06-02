/**
 * IBT GTM Report — server.js v7.1
 *
 * Cambios v7.1 respecto a v7 (SOLO logging, lógica de negocio IDÉNTICA):
 *   - FIX DE LOGGING DE web_search: web_search es un SERVER TOOL de Anthropic.
 *     La API lo ejecuta sola y devuelve bloques `server_tool_use` +
 *     `web_search_tool_result`, NO bloques `tool_use`. El conteo viejo miraba
 *     solo bloques `tool_use`, así que SIEMPRE daba 0 y el WARNING "no usó
 *     web_search" se disparaba en todos los jobs, buscara o no.
 *     Ahora se cuenta con data.usage.server_tool_use.web_search_requests y se
 *     loguea cada query y cuántos resultados trajo. Aplica a gen y a fix.
 *   - Poné WS_DEBUG=1 para dumpear el `usage` crudo y los tipos de bloque una vez.
 *
 * Cambios previos (v7): prompt caching + logging de tokens. Sin cambios acá.
 * Los prompts y el flujo (gen → juez → fixer) son IDÉNTICOS a v7.
 */

const express = require('express');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { renderReport } = require('./render.js'); // plantilla fija + datos JSON -> HTML

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const MODEL_GEN = 'claude-sonnet-4-6';
const MODEL_JUDGE = 'claude-sonnet-4-6';
const MODEL_FIX = 'claude-sonnet-4-6';

const MCP_URL = 'https://backoffice-server-production.up.railway.app/api/mcp';
const IBT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'x-email': process.env.IBT_EMAIL,
  'x-password': process.env.IBT_PASSWORD
};

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 8
};

// Acumulador de tokens por job (total + desglose por etapa)
let tokenStats = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
// Desglose por etapa: cuánto costó cada parte del pipeline
let stageStats = {
  gen:   { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  judge: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  fix:   { input: 0, output: 0, cache_write: 0, cache_read: 0 }
};
// Etapa actual (la setea cada función antes de llamar a Claude)
let currentStage = 'gen';

function resetTokenStats() {
  tokenStats = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  stageStats = {
    gen:   { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    judge: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    fix:   { input: 0, output: 0, cache_write: 0, cache_read: 0 }
  };
  currentStage = 'gen';
}

function costoDe({ input, output, cache_write, cache_read }) {
  // Precios Sonnet 4.6: $3 input / $15 output por millón.
  // Cache write = 1.25x input ($3.75). Cache read = 0.1x input ($0.30).
  return (input * 3 + output * 15 + cache_write * 3.75 + cache_read * 0.30) / 1e6;
}

function logTokenCost(label) {
  const total = costoDe(tokenStats);
  console.log(`[TOKENS] ${label} | in:${tokenStats.input} out:${tokenStats.output} cache_w:${tokenStats.cache_write} cache_r:${tokenStats.cache_read} | ~$${total.toFixed(4)} (Sonnet)`);
  // Desglose: cuánto se fue en cada etapa
  for (const etapa of ['gen', 'judge', 'fix']) {
    const s = stageStats[etapa];
    const c = costoDe(s);
    if (s.input || s.output || s.cache_read || s.cache_write) {
      console.log(`[TOKENS]   └─ ${etapa.padEnd(5)} | in:${s.input} out:${s.output} cache_w:${s.cache_write} cache_r:${s.cache_read} | ~$${c.toFixed(4)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Conteo y log REAL de web_search  (NUEVO en v7.1)
// ---------------------------------------------------------------------------
// web_search es un SERVER TOOL: la API lo ejecuta del lado del servidor y
// devuelve bloques `server_tool_use` (la query) + `web_search_tool_result`
// (los resultados). NO produce bloques `tool_use` (esos son los client tools
// como IBT, que puenteamos nosotros). El número autoritativo de búsquedas está
// en data.usage.server_tool_use.web_search_requests.
function contarYLoguearWebSearch(data, stage) {
  if (process.env.WS_DEBUG === '1') {
    console.log(`[${stage}][WS-DEBUG] usage:`, JSON.stringify(data.usage));
    console.log(`[${stage}][WS-DEBUG] blocks:`, JSON.stringify((data.content || []).map(b => b.type)));
  }
  const n = data.usage?.server_tool_use?.web_search_requests || 0;
  for (const block of (data.content || [])) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      console.log(`[${stage}] web_search query: ${JSON.stringify(block.input?.query)}`);
    }
    if (block.type === 'web_search_tool_result') {
      const c = block.content;
      if (Array.isArray(c)) {
        console.log(`[${stage}] web_search → ${c.length} resultados`);
      } else if (c && c.type === 'web_search_tool_result_error') {
        console.log(`[${stage}] web_search ERROR: ${c.error_code}`);
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// MCP IBT con logs
// ---------------------------------------------------------------------------
async function callMCP(toolName, args) {
  console.log(`[MCP] Llamando ${toolName} con args:`, JSON.stringify(args).substring(0, 200));
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: IBT_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: Date.now()
    })
  });
  const text = await res.text();
  const match = text.match(/data: ({.*})\n\n/);
  if (!match) {
    console.error(`[MCP] ERROR: no se pudo parsear respuesta de ${toolName}`);
    throw new Error('No se pudo parsear respuesta MCP');
  }
  const parsed = JSON.parse(match[1]);
  const result = parsed?.result?.content?.[0]?.text || JSON.stringify(parsed?.result);
  console.log(`[MCP] ${toolName} OK (${result.length} chars)`);
  return result;
}

async function listMCPTools() {
  console.log(`[MCP] Listando tools disponibles...`);
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: IBT_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 1
    })
  });
  const text = await res.text();
  const match = text.match(/data: ({.*})\n\n/);
  if (!match) throw new Error('No se pudo listar tools');
  const parsed = JSON.parse(match[1]);
  const toolList = parsed?.result?.tools || [];
  console.log(`[MCP] ${toolList.length} tools disponibles`);
  return toolList;
}

// ---------------------------------------------------------------------------
// PROMPTS (idénticos a v7)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT_HTML = `# IBT GTM Report — Skill completo

Generás un reporte GTM de EXACTAMENTE 4 páginas A4 que IBT manda a prospectos: identificás 6 decisores reales en LinkedIn que encajan con el ICP del cliente, los organizás en un HTML branded. El PDF se renderiza después con Puppeteer.

---

## Workflow completo

### 1. Research REAL de la empresa con web_search (OBLIGATORIO)

REGLA CRÍTICA: PROHIBIDO inventar o asumir datos de la empresa. TODOS los datos del overview (año de fundación, tracción, modelo de negocio, stage, número de clientes/productos, funding) deben salir de búsquedas reales con la tool web_search.

Pasos obligatorios:
- Buscar el nombre de la empresa + "fundada" o "founded" → confirmar año de fundación
- Buscar el nombre + "funding" o "seed" o "Series A" → confirmar stage real
- Buscar el nombre + "crunchbase" o "linkedin" → confirmar modelo de negocio
- Buscar noticias recientes (último año) sobre la empresa

PROHIBIDO escribir el reporte sin tener al menos 3 fuentes web verificables sobre la empresa.

Si la información es ambigua o no se puede confirmar:
- Usar fórmulas conservadoras ("startup en etapa temprana", "company builder")
- NO inventar números específicos (NUNCA "+30 productos", "Series A", "$X ARR" si no está confirmado)
- En duda → usar formulación genérica verificada en lugar de número específico inventado

Extraer del research:
- Qué hace el producto/empresa (1-2 oraciones)
- Modelo de negocio REAL (no asumir B2B SaaS si no está confirmado)
- País de origen y expansión
- Tracción / métricas públicas VERIFICADAS (funding real, clientes públicos, etc.)
- Stage real (seed / Series A / Series B / etc.) — solo si está confirmado
- Año de fundación REAL

### 2. Definir el ICP del cliente
A partir del research VERIFICADO (no asumido), definir:
- Tamaño de empresa target (headcount, revenue)
- Rol del decisor
- Industrias donde el producto tiene fit claro según lo que la empresa REALMENTE hace
- País(es) donde tiene sentido hacer outreach

REGLA: el ICP debe alinearse con el modelo de negocio REAL verificado, no con un modelo asumido.

REGLA DE COHERENCIA: las 6 cuentas son PROSPECTS — empresas que aún NO son clientes del producto. NUNCA incluir como cuenta target a una empresa que ya es proof point o cliente conocido del producto.

### 3. Buscar 6 perfiles REALES en Sales Navigator

PROHIBIDO inventar URLs, nombres o slugs de LinkedIn. TODOS los perfiles DEBEN salir de la búsqueda real en Sales Navigator.

**Paso 3.1: Resolver IDs con resolve_sales_navigator_id**

search_sales_navigator_filtered NO acepta nombres como strings. Necesita IDs.
Llamar primero a resolve_sales_navigator_id con:
- type: "LOCATION", keywords: nombre del país
- type: "SALES_INDUSTRY", keywords: nombre de la industria
- type: "SENIORITY", keywords: nivel
- type: "FUNCTION", keywords: función

**Paso 3.2: Buscar perfiles con search_sales_navigator_filtered**

Llamar con:
{
  "category": "people",
  "degreeOfConnection": ["2nd"],
  "location": { "include": ["<ID de location>"] },
  "industry": { "include": ["<ID de industria>"] },
  "seniority": { "include": ["<ID de seniority>"] },
  "function": { "include": ["<ID de función>"] },
  "profilesLimit": 20
}

De los resultados, seleccionar EXACTAMENTE 6 perfiles considerando:
1. Rol / seniority (decision-makers, no ICs junior)
2. Empresa ancla reconocible
3. Fit con el pain del producto

Usar el publicIdOrUrl que devuelve search_sales_navigator_filtered como slug en la URL final.
URL final: https://www.linkedin.com/in/[publicIdOrUrl]

LinkedIn acepta tanto slugs limpios como member IDs opacos (ACwAA...) — ambos resuelven al perfil correcto.

**Paso 3.3: REGLA ANTI-INVENCIÓN de cargo, empresa y grado (CRÍTICO)**

El nombre y el URL (publicIdOrUrl) salen de campos estructurados → son confiables.
PERO el cargo y la empresa salen del campo "headline" (texto libre) → ACÁ ES DONDE NO DEBÉS INVENTAR.

Reglas estrictas:
- El cargo y la empresa de cada tarjeta deben tomarse TEXTUALMENTE del headline del perfil que devuelve la búsqueda. PROHIBIDO inventar, deducir o "completar" un nombre de empresa o cargo que no aparezca literalmente en el headline.
- Si el headline viene LIMPIO con formato "Rol @ Empresa" (ej: "CPO & Co-Founder @ Agree") → usar ese rol y esa empresa.
- Si el headline viene SUCIO (en español con "en", con pipes "|", con varios fragmentos "||", o sin un "@" claro) → NO intentes adivinar la empresa. Mostrá el headline tal cual viene, o solo el primer rol mencionado. NUNCA fabriques un nombre de startup ni un título de "Founder/CEO" para que encaje con el ICP.
- Si NO podés determinar con certeza el cargo y empresa de un perfil → ese perfil NO sirve para el reporte: DESCARTALO y elegí otro de los resultados de la búsqueda que tenga headline claro.
- PROHIBIDO forzar a una persona dentro del molde del ICP distorsionando su cargo. Si su rol real no encaja con el ICP (ej: es un CTO de una empresa de 3 personas cuando buscás founders SaaS), DESCARTALO y buscá otro. Es preferible un perfil real que encaje a uno distorsionado.

**Paso 3.4: Grado de conexión REAL**

PROHIBIDO hardcodear "2do grado" en todas las tarjetas.
Usar el grado de conexión REAL que devuelve search_sales_navigator_filtered para cada perfil (1er, 2do o 3er grado).
Si la búsqueda se filtró por degreeOfConnection: ["2nd"], entonces los resultados ya son 2do grado y podés indicarlo. Pero si un perfil viene de otra búsqueda o el grado no está claro, usar el valor real o no mostrar el grado.

### 4. Estructura del reporte — EXACTAMENTE 4 páginas

PROHIBIDO agregar páginas extra como "playbook", "secuencia operativa", "plan de 30 días" o cualquier otra cosa fuera del scope.

- Página 1: Overview estratégico
- Página 2: Account cards 1 y 2
- Página 3: Account cards 3 y 4
- Página 4: Account cards 5 y 6

NO agregar página 5. EXACTAMENTE 4 divs .page.

#### Página 1 — Overview estratégico
[HEADER IBT] + [RIBBON: Vertical · País · Fundada · ARR/Tracción] — DATOS VERIFICADOS con web_search
[EYEBROW Geist Mono uppercase] + [H1: "6 [tipo de cuenta] para escalar [Empresa] en [País]"]
[Lead: 2-3 oraciones, ancla el proof point REAL VERIFICADO del cliente]
[STATS — 4 chips]: Fecha · "6 · Priorizadas" · Métrica clave VERIFICADA · Meta comercial
[ICP GRID — 4 tarjetas]
[CONTEXTO MACRO]: 2-3 bullets con datos de mercado verificados
[ÁNGULOS DE APERTURA]: 3 hooks para LinkedIn
[CHIPS de prioridad]

#### Páginas 2-4 — Account cards (2 por página)
[NÚMERO] · [EMPRESA tomada TEXTUAL del headline]
[Avatar] + [Nombre decisor] + [Cargo · Empresa — TEXTUAL del headline, sin inventar]
[linkedin.com/in/[publicIdOrUrl] → link clicable] + [País · grado REAL · Año en rol si está disponible]
[ÁNGULO PERSONALIZADO]: 3-4 oraciones específicas basadas en el cargo/empresa REAL del perfil
[HOOK DE APERTURA]: una oración entre comillas

REGLA ICE: cada card 100% única.
REGLA ANTI-INVENCIÓN: el ángulo personalizado debe basarse en datos REALES del perfil (su headline, su empresa real). PROHIBIDO inventar contexto sobre la empresa de la persona si no lo verificaste. Si solo tenés el headline, basá el ángulo en ese headline, no en suposiciones.

### 5. Design system CommerceGlass v8

Variables CSS:
\`\`\`css
:root {
  --ink: #0A0C14; --ink-2: #3A3F4A; --ink-3: #6B717B; --ink-4: #A0A5AE;
  --bg: #F0F2F7; --panel: #FFFFFF; --panel-2: #F2F4F8; --line: rgba(10,12,20,0.10);
  --accent: #2B4BFF; --accent-soft: rgba(43,75,255,0.08); --accent-edge: rgba(43,75,255,0.25);
  --cta: #0A0C14; --cta-fg: #FFFFFF; --radius: 10px;
  --font: 'Geist', 'Inter', sans-serif; --mono: 'Geist Mono', 'JetBrains Mono', monospace;
}
\`\`\`

Fuentes:
\`\`\`html
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
\`\`\`

Tipografía:
- Eyebrow: Geist Mono · 8-9px · uppercase · letter-spacing 0.14em
- H1: 28px · weight 700 · letter-spacing -0.03em
- H2: 14-15px · weight 600
- Cuerpo: 11px · line-height 1.55
- Acento: <span style="color:var(--accent)">texto</span>

CSS de página:
\`\`\`css
.page {
  width: 210mm; min-height: 297mm; margin: 24px auto;
  padding: 12mm 15mm 10mm; background: #fff;
  border: 1px solid var(--line); border-radius: 4px;
  box-shadow: 0 20px 60px -30px rgba(10,12,20,0.25);
  display: flex; flex-direction: column;
}
@page { size: A4; margin: 0; }
@media print {
  html, body { background: #fff; }
  .page {
    width: 210mm; min-height: 297mm; height: 297mm;
    margin: 0; border: none; box-shadow: none; border-radius: 0;
    page-break-after: always;
  }
  .page:last-child { page-break-after: avoid; }
}
\`\`\`

Header en cada página:
\`\`\`html
<header class="page-header">
  <div class="logo-pill" style="background:#0A0C14;padding:6px 12px;border-radius:6px;display:inline-flex;align-items:center;">
    <img src="https://apimensajeria-production.up.railway.app/logo-white.png" alt="IBT" height="22">
  </div>
  <div class="header-meta">
    <span class="tag-accent">GTM INTELLIGENCE</span>
    <span class="doc-title">[EMPRESA] · ANÁLISIS GTM</span>
    <span class="doc-date">[MES AÑO]</span>
  </div>
</header>
\`\`\`

Footer:
\`\`\`html
<footer class="page-footer">
  <span>INBOUND-TOOLS.COM ● ANÁLISIS GTM · [EMPRESA]</span>
  <span>PÁGINA [N] / 4</span>
</footer>
\`\`\`

---

## Anti-patterns
- DATOS INVENTADOS de la empresa → SIEMPRE verificar con web_search antes de escribir el overview
- CARGO/EMPRESA INVENTADO de un decisor → tomar TEXTUAL del headline; si está sucio, no adivinar; si no se entiende, descartar el perfil
- Forzar a una persona dentro del ICP distorsionando su cargo real → DESCARTAR y elegir otra
- "2do grado" hardcodeado en todas las tarjetas → usar el grado REAL
- Año de fundación, stage, métricas asumidas sin búsqueda web → PROHIBIDO
- URL tipo linkedin.com/company/X → usar /in/
- URL inventada sin pasar por search_sales_navigator_filtered → PROHIBIDO
- Empresa proof point/cliente del producto como cuenta target → excluirla
- PDF en 5+ páginas con playbook extra → ELIMINAR
- Copy-paste de ángulos entre cards
- Datos rotos: [INSERT], TODO, undefined, lorem ipsum

---

## Output FINAL
- Empezar con <!DOCTYPE html>
- Terminar con </html>
- NO escribir nada antes del <!DOCTYPE html>
- NO usar bloques de código markdown
- EXACTAMENTE 4 divs .page`;

// ===========================================================================
// JUEZ de calidad — evalúa el HTML renderizado y devuelve veredicto + fixes.
// ===========================================================================

const SYSTEM_PROMPT_JUDGE = `Sos un juez de control de calidad EXTREMADAMENTE ESTRICTO para reportes GTM de IBT.

Recibís el HTML del reporte + el número de páginas del PDF ya renderizado. Validás los 8 criterios y retornás un JSON.

Tu objetivo: detectar reportes con DATOS INVENTADOS o INCONSISTENCIAS. Sé paranoico. En duda → FAIL.

QUÉ ES REAL Y QUÉ ESCRIBE LA IA (importante para no marcar falsos positivos):
- Los datos DUROS de cada card —nombre, cargo, empresa, ubicación, grado de conexión y el link de LinkedIn (member id opaco ACwAA... o slug)— vienen de una búsqueda REAL en Sales Navigator. NO los inventa la IA. Confiá en ellos: NO los marques como "inventados", "rotos" ni "sospechosos" solo por su forma. En particular: (a) un href con id opaco ACwAA... ES un link válido y correcto, no un dato roto; (b) que el grado de conexión sea el mismo en varias cards (ej. todas "2do grado") es dato REAL, no hardcodeo.
- Lo que SÍ escribe la IA y tenés que auditar por invención/genericidad: el ÁNGULO y el HOOK de cada card, y TODO el contenido de la página 1 (overview, stats, contexto de mercado, proof). Ahí enfocá la paranoia.


Criterios:

1. **LinkedIn /in/ format** — todos los URLs usan linkedin.com/in/[algo], NUNCA linkedin.com/company/
   PASS si las URLs son /in/ — son aceptables tanto slugs limpios (juan-perez) como member IDs opacos (ACwAA...) porque LinkedIn los resuelve igual
   FAIL solo si encuentras linkedin.com/company/

2. **Exactamente 6 cuentas** — ni más ni menos

3. **EXACTAMENTE 4 páginas PDF** — usá el conteo provisto en el mensaje
   FAIL si tiene 5+ páginas o 3 o menos

4. **VERACIDAD de los datos de la empresa** (CRÍTICO):
   FAIL si el overview contiene datos que parecen inventados o demasiado específicos sin verificación:
   - Año de fundación específico ("Fundada 2020") sin que pueda confirmarse
   - Stage de funding ("Series A", "$X ARR") sin evidencia clara
   - Número de productos/clientes específico ("+30 productos") sin fuente
   - Métricas sospechosamente redondas ("38% reply rate", "4x pipeline") sin contexto
   Si todo el overview suena demasiado a "marketing copy genérico de SaaS B2B" → FAIL

5. **Coherencia interna** — el reporte trata sobre la empresa correcta, las cuentas hacen sentido para ese ICP
   FAIL si una de las 6 cuentas target es la misma empresa mencionada como proof point/cliente del producto en el overview

6. **Personalización del ÁNGULO y el HOOK** (CRÍTICO — esto lo escribe la IA):
   - Cada card debe tener ángulo y hook ÚNICOS y específicos de ESA persona/empresa, con un pain concreto.
   - FAIL si hay frases genéricas tipo "escalar tu operación" / "mejorar la eficiencia", o si los 6 ángulos repiten la MISMA estructura/proof copiada sin diferenciar el dolor de cada cuenta.
   - FAIL si el ángulo o el hook hablan de OTRA persona o empresa distinta a la de la card (ángulo CRUZADO/copiado): ej. la card es de Clara @ ISDIN pero el texto menciona a "Gabriel" o a "OCASA". El hook debe nombrar a la persona de ESA card.
   - FAIL si el ángulo inventa datos de la empresa que NO se pueden inferir del cargo/headline.
   (El cargo y la empresa que figuran en la card son datos REALES de la búsqueda — NO los marques como inventados.)

7. **Sin datos rotos** — sin [INSERT], TODO, undefined, lorem ipsum, placeholders {{...}} crudos, ni cards VACÍAS (card sin nombre/empresa/cargo/link, o link que termina en /in/ sin nada). Sin fechas incoherentes.
   (Que varias cards compartan el mismo grado de conexión, ej. todas "2do grado", NO es error: es dato real.)

8. **Proof points presentes y plausibles** — al menos 1 ancla de credibilidad del cliente
   FAIL si los proof points suenan fabricados (porcentajes redondos sin contexto, métricas sin fuente)

Respondé EXCLUSIVAMENTE con JSON válido, sin markdown, sin texto extra:
{"veredicto":"APROBADO"|"RECHAZADO","score":<0-8>,"fixes":["fix concreto 1","fix concreto 2"]}

APROBADO solo si pasa los 8/8. Si RECHAZADO, "fixes" lista instrucciones concretas.`;

const SYSTEM_PROMPT_FIX = `Sos el corrector del reporte GTM de IBT. Recibís los DATOS del reporte en JSON y una lista de correcciones del juez. Aplicá SOLO las correcciones necesarias y devolvé el MISMO objeto JSON corregido, con la MISMA estructura y nombres de campo (sin HTML, sin markdown, sin texto alrededor). Mantené intactos los campos que el juez no observó.

IMPORTANTE:
- Si el juez detectó datos inventados de la empresa, USAR web_search para verificar y corregir.
- Si detectó CARGO/EMPRESA inventado de un decisor, volvé a llamar get_contact_profile o search_sales_navigator_filtered para el headline REAL y usá ese cargo/empresa textual. Si el headline está sucio, mostralo crudo o reemplazá ese perfil por otro real.
- Si detectó "2do grado" hardcodeado, usá el grado de conexión real.
- Si detectó una cuenta que es proof point/cliente del producto, reemplazala por otro perfil real.
- Mantené las cantidades EXACTAS: ribbon 5, stats 4, icp 4, context 3, apertura 3, prioridades 4, cards 6.
- En cada card, slug y urn deben apuntar a la MISMA persona.
- NUNCA inventes datos. Si no podés verificar, usá formulación conservadora o descartá.`;

// ---------------------------------------------------------------------------
// Llamadas a Claude — CON PROMPT CACHING + logging de tokens
// ---------------------------------------------------------------------------
async function callClaude({ model, system, messages, tools = [], stopSequences = [], maxTokens = 16000 }) {
  // PROMPT CACHING:
  // 1) system como bloque con cache_control → cachea el skill completo (lo más grande)
  // 2) última tool con cache_control → cachea todo el bloque de definiciones de tools
  const body = {
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages
  };

  if (tools.length > 0) {
    // Clonamos las tools y marcamos la ÚLTIMA con cache_control.
    // Eso cachea el bloque entero de tools hasta ese punto.
    const cachedTools = tools.map((t, i) => {
      if (i === tools.length - 1) {
        return { ...t, cache_control: { type: 'ephemeral' } };
      }
      return t;
    });
    body.tools = cachedTools;
  }

  if (stopSequences.length > 0) body.stop_sequences = stopSequences;

  // Timeout + retry: un cuelgue transitorio de la API (UND_ERR_HEADERS_TIMEOUT,
  // fetch failed, 429, 5xx) ya no mata el job. Hasta 3 intentos con backoff.
  const MAX_INTENTOS = Number(process.env.CLAUDE_MAX_RETRIES) || 3;
  const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 240000; // 4 min
  let data, lastErr;
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
      }
      data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      break; // OK
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const transitorio = e.name === 'AbortError' ||
        /UND_ERR|fetch failed|HTTP 429|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up|terminated/i.test(e.message || '');
      if (intento < MAX_INTENTOS && transitorio) {
        const espera = 2000 * intento;
        console.warn(`[API] intento ${intento}/${MAX_INTENTOS} falló (${e.name === 'AbortError' ? 'timeout ' + TIMEOUT_MS + 'ms' : (e.message || '').slice(0, 80)}). Reintento en ${espera}ms...`);
        await new Promise(r => setTimeout(r, espera));
        continue;
      }
      throw e;
    }
  }

  // Acumular tokens para el log de costo (total + etapa actual)
  if (data.usage) {
    const i = data.usage.input_tokens || 0;
    const o = data.usage.output_tokens || 0;
    const cw = data.usage.cache_creation_input_tokens || 0;
    const cr = data.usage.cache_read_input_tokens || 0;
    tokenStats.input += i;
    tokenStats.output += o;
    tokenStats.cache_write += cw;
    tokenStats.cache_read += cr;
    const st = stageStats[currentStage];
    if (st) {
      st.input += i;
      st.output += o;
      st.cache_write += cw;
      st.cache_read += cr;
    }
  }

  return data;
}

// Extrae el objeto JSON que devuelve el gen (tolera fences/markdown y texto suelto).
// Extrae el objeto JSON por balance de llaves, respetando strings/escapes.
// Así ignora cualquier prosa/markdown que el modelo agregue DESPUÉS del objeto
// (ej: "*Nota: ...") que rompía el JSON.parse.
function _extraerJSON(t){
  const i = t.indexOf('{'); if(i<0) return null;
  let depth=0, inStr=false, esc=false;
  for(let j=i;j<t.length;j++){
    const c=t[j];
    if(inStr){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inStr=false; continue; }
    if(c==='"') inStr=true; else if(c==='{') depth++; else if(c==='}'){ depth--; if(depth===0) return t.slice(i,j+1); }
  }
  return t.slice(i);
}
function parseReporteJSON(raw) {
  if (!raw || !raw.trim()) throw new Error('El generador devolvió vacío (sin JSON)');
  const t = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const block = _extraerJSON(t);
  if (!block) throw new Error('El generador no devolvió un JSON parseable');
  // Intentos en capas: crudo -> sin markdown bold -> sin comentarios -> sin trailing commas.
  const intentos = [
    block,
    block.replace(/\*\*/g, ''),
    block.replace(/\*\*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''),
    block.replace(/\*\*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*([}\]])/g, '$1')
  ];
  let lastErr;
  for (const cand of intentos) { try { return JSON.parse(cand); } catch (e) { lastErr = e; } }
  throw new Error('JSON inválido tras limpieza: ' + (lastErr && lastErr.message));
}

async function runJudge(html, pageCount) {
  currentStage = 'judge';
  console.log(`[JUDGE] Evaluando reporte (${pageCount} páginas)...`);
  // El juez evalúa contenido y estructura — NO necesita el logo base64 ni el CSS,
  // que tokenizan carísimo. Se los saco para no inflar el costo del juez.
  const htmlLite = String(html || '')
    .replace(/src="data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+"/gi, 'src="[LOGO]"')
    .replace(/<style>[\s\S]*?<\/style>/i, '<style>/* css omitido para el juez */</style>');
  const data = await callClaude({
    model: MODEL_JUDGE,
    system: SYSTEM_PROMPT_JUDGE,
    messages: [{
      role: 'user',
      content: `Páginas del PDF renderizado: ${pageCount}\n\nHTML del reporte:\n${htmlLite}`
    }],
    maxTokens: 2000
  });

  const raw = data.content.find(b => b.type === 'text')?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : raw);
    const result = {
      veredicto: parsed.veredicto || 'APROBADO',
      score: parsed.score ?? 0,
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes : []
    };
    console.log(`[JUDGE] Veredicto: ${result.veredicto} ${result.score}/8`);
    if (result.fixes.length > 0) {
      console.log(`[JUDGE] Fixes: ${result.fixes.join(' | ')}`);
    }
    return result;
  } catch (e) {
    console.error('[JUDGE] No se pudo parsear, aprobando por defecto:', e.message);
    return { veredicto: 'APROBADO', score: 0, fixes: [] };
  }
}

// ---------------------------------------------------------------------------
// GATE de integridad de links  (NUEVO)
// ---------------------------------------------------------------------------
// Verifica que el href (member URN) de cada card apunte a la MISMA persona que
// nombra el slug visible del link. Si no coincide, re-busca al correcto en IBT
// y reemplaza el URN en el HTML. Determinístico, sin LLM. Corre después de
// gen/fix y ANTES del juez. Lo que no puede corregir lo deja flageado.
function _stripTags(s){return (s||'').replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();}
function _norm(s){return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
function _profileName(txt){return ((txt||'').match(/Profile:\s*(.+?)\s*(?:\[profileId|\u2014|@|$)/i)||[])[1]?.trim()||'';}
function _esc(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function _gradoReclamado(win){const m=win.match(/([123])\s*(?:er|do|ro|\u00b0|\u00ba)?\s*grado/i);return m?parseInt(m[1],10):null;}
function _degOrdinal(n,sample){if(/[\u00b0\u00ba]/.test(sample))return n+'\u00b0';const w={1:'1er',2:'2do',3:'3er'}[n]||(n+'do');return /[A-Z\u00c1\u00c9\u00cd\u00d3\u00da]{2,}/.test(sample)?w.toUpperCase():w;}

async function _buscarPersona(first,last){
  try{
    const res=await callMCP('search_sales_navigator_filtered',{category:'people',first_name:first,last_name:last,profilesLimit:5});
    return [...res.matchAll(/id=([A-Za-z0-9_\-]+)\s+"([^"]+)"\s+([^(]*)\(DISTANCE_(\d)/g)]
      .map(x=>({id:x[1],name:x[2],head:x[3],dist:parseInt(x[4],10)}));
  }catch{ return []; }
}

async function verificarLinks(html){
  const anchorRe=/<a\b[^>]*href="https?:\/\/(?:www\.)?linkedin\.com\/in\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches=[]; let m;
  while((m=anchorRe.exec(html))!==null) matches.push({urnRaw:m[1],inner:m[2],idx:m.index,end:anchorRe.lastIndex});

  const swaps=[], corregidos=[], noResueltos=[], gradosCorregidos=[], gradosMal=[], degFixes=[];

  // FASE 1: scan sobre el html original (sin mutar) — posiciones estables
  for(const a of matches){
    const urn=decodeURIComponent(a.urnRaw);
    const innerTxt=_stripTags(a.inner);
    const slug=((innerTxt.match(/\/in\/([^\s/]+)/)||[])[1]||innerTxt).trim();
    const slugTokens=_norm(slug.replace(/[-_]/g,' ')).split(' ').filter(t=>t.length>2 && !/^\d+$/.test(t));
    const slugEsUrn=/^ac[a-z0-9]{12,}$/i.test(slug) || slugTokens.length===0;
    const ventana=_stripTags(html.slice(Math.max(0,a.idx-250),Math.min(html.length,a.end+250)));
    const ventanaNorm=_norm(html.slice(Math.max(0,a.idx-700),a.idx));

    let realName='';
    try{ realName=_profileName(await callMCP('get_contact_profile',{publicIdOrUrl:urn,noCache:true})); }
    catch{ noResueltos.push({urn,motivo:'el URN no resuelve'}); continue; }

    let realDist=null;
    if(slugEsUrn){
      noResueltos.push({urn,resuelveA:realName,motivo:'slug visible opaco, no se pudo cruzar'});
    }else{
      const realTokens=_norm(realName).split(' ').filter(t=>t.length>2);
      const realApellido=realTokens[realTokens.length-1];
      const linkOk=realApellido && slugTokens.includes(realApellido);

      if(linkOk){
        const cands=await _buscarPersona(slugTokens[0]||'',slugTokens[1]||'');
        const me=cands.find(c=>c.id===a.urnRaw||c.id===urn);
        if(me) realDist=me.dist;
      }else{
        console.log(`[LINKS] Mismatch: slug "${slug}" pero el URN resuelve a "${realName}"`);
        const cands=await _buscarPersona(slugTokens[0]||'',slugTokens[1]||'');
        const pick=cands.find(c=>_norm(c.head).split(' ').filter(t=>t.length>3).some(w=>ventanaNorm.includes(w)))||cands[0];
        if(pick && pick.id!==a.urnRaw){
          swaps.push({from:a.urnRaw,to:pick.id});
          corregidos.push({slug,de:urn,a:pick.id});
          realDist=pick.dist;
          console.log(`[LINKS] Corregido: ${slug} -> ${pick.id}`);
        }else{
          noResueltos.push({urn,slug,resuelveA:realName,motivo:'no encontre el URN correcto'});
        }
      }
    }

    // grado: comparar reclamado vs real
    const claimed=_gradoReclamado(ventana);
    if(realDist && claimed && realDist!==claimed){
      gradosMal.push({slug:slug||urn,dice:claimed,real:realDist});
      degFixes.push({anchor:a.urnRaw,real:realDist,slug:slug||urn,claimed});
    }
  }

  // FASE 2: aplicar correcciones (string-based, sin depender de posiciones)
  // 2a) grados — se anclan al URN ORIGINAL (todavía presente en el html)
  for(const f of degFixes){
    const re=new RegExp(_esc(f.anchor)+'([\\s\\S]{0,220}?)([123])((?:er|do|ro|\u00b0|\u00ba)?)(\\s*)(grado)','i');
    let hecho=false;
    const out=html.replace(re,(full,mid,dnum,ord,sp,gr)=>{hecho=true;return f.anchor+mid+_degOrdinal(f.real,dnum+ord)+sp+gr;});
    if(hecho){ html=out; gradosCorregidos.push({slug:f.slug,de:f.claimed,a:f.real}); console.log(`[LINKS] Grado corregido: ${f.slug} ${f.claimed} -> ${f.real}`); }
  }
  // 2b) swaps de URN
  for(const s of swaps) html=html.split(s.from).join(s.to);

  return {html,corregidos,noResueltos,gradosCorregidos,gradosMal};
}

// ---------------------------------------------------------------------------
// GATE data-based (NUEVO, reemplaza al de HTML): verifica los URN del JSON
// contra el nombre real de cada card. Lee CACHEADO primero (no throttlea);
// noCache solo de fallback, sin ráfaga. Corrige el urn dentro de los datos.
// ---------------------------------------------------------------------------
function _nombreApellido(nombre){
  const t=_norm(nombre).split(' ').filter(x=>x.length>1);
  return { first:t[0]||'', last:t[t.length-1]||'', tokens:t };
}
function _coincideNombre(a,b){
  const x=_nombreApellido(a), y=_nombreApellido(b);
  if(!x.tokens.length || !y.tokens.length) return false;
  if(x.last && y.tokens.includes(x.last)) return true;
  if(y.last && x.tokens.includes(y.last)) return true;
  return x.tokens.filter(t=>y.tokens.includes(t)).length>=2;
}
// Saca caracteres invisibles (zero-width, soft hyphen) y espacios que el modelo
// a veces inyecta en un urn/slug y rompen el link. Determinístico.
function _limpiarId(s){ return String(s||'').replace(/[\u200B-\u200D\uFEFF\u00AD\s]/g,'').trim(); }

async function _resolverNombre(urn){
  try{ const n=_profileName(await callMCP('get_contact_profile',{publicIdOrUrl:urn})); if(n) return n; }catch{}
  try{ return _profileName(await callMCP('get_contact_profile',{publicIdOrUrl:urn,noCache:true})); }catch{}
  return '';
}
// Headline limpio: saca el prefijo "Nombre [profileId: N] —" y el sufijo "(N employees, ...)".
function _headlineLimpio(txt){
  return String(txt||'').replace(/^[^—\n]*—\s*/,'').replace(/\s*\([^)]*\)\s*$/,'').trim();
}
// Resuelve un urn/slug al PERFIL real: nombre + empresa (del headline) + headline limpio.
// Determinístico y cero tokens (llama a IBT directo). Cacheado primero, noCache de fallback.
async function _resolverPerfil(urn){
  for(const args of [{publicIdOrUrl:urn},{publicIdOrUrl:urn,noCache:true}]){
    try{
      const txt=await callMCP('get_contact_profile',args);
      const name=_profileName(txt);
      if(name) return { name, empresa:_empresaDeHeadline(txt), headline:_headlineLimpio(txt), txt:String(txt||'') };
    }catch{}
  }
  return { name:'', empresa:'', headline:'', txt:'' };
}
async function verificarLinksData(data){
  // NUEVA ARQUITECTURA: cada card ya trae su urn REAL (el id opaco del pool, que vino
  // de la búsqueda — ground-truth). Re-buscar por nombre acá reasignaba HOMÓNIMOS
  // equivocados (ej: "Sofia Costa" de Radio Victoria -> otra "Sofia Costa" de PwC).
  // Como el urn ya es correcto, este gate NO re-busca ni sobrescribe identidad: pasa
  // los datos tal cual. Se conserva la firma para no romper call sites ni el mapeo n8n.
  return { data, corregidos:[], noResueltos:[], descartados:[], gradosCorregidos:[], gradosMal:[] };
}

// ---------------------------------------------------------------------------
// HTML -> PDF
// ---------------------------------------------------------------------------
function limpiarHtml(html) {
  if (!html) return null;
  const match = html.match(/<!DOCTYPE[\s\S]*/i);
  let clean = match ? match[0] : html;
  if (!clean.includes('</html>')) clean = clean + '\n</html>';
  return clean;
}

async function renderizarPdf(cleanHtml) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(cleanHtml, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' }
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

async function contarPaginas(pdfBuffer) {
  try {
    const doc = await PDFDocument.load(pdfBuffer);
    return doc.getPageCount();
  } catch (e) {
    console.error('No se pudo contar páginas:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Resolución de identidad del cliente (DETERMINÍSTICA, ancla en el perfil del chat)
// Prioridad: profileId del chat (lo más confiable) -> dominio corporativo -> sin anclar.
// NO inventa: si no puede anclar con confianza, marca anclado:false (n8n decide no mandar).
// ---------------------------------------------------------------------------
function _empresaDeHeadline(txt){let m=(txt||'').match(/@\s*([^·•|(\n]+)/);if(!m)m=(txt||'').match(/\bat\s+([^·•|(\n]+)/i);return m?m[1].trim():'';}
function _empresaDeLookup(txt){const m=(txt||'').match(/Company:\s*(.+?)\s*(?:\[|—|\u2014|,|$)/i);return m?m[1].trim():'';}
function _headcountDe(txt){const m=(txt||'').match(/([\d][\d.,]*)\s*employees/i);return m?(parseInt(m[1].replace(/[.,]/g,''),10)||null):null;}
function _tier(h){if(h==null)return null;if(h<10)return'micro';if(h<50)return'chica';if(h<500)return'media';if(h<5000)return'grande';return'enterprise';}
function _esEmailGratuito(d){return /(gmail|yahoo|hotmail|outlook|icloud|live|aol|proton|protonmail|gmx)\./i.test((d||'').trim());}
function _mismaEmpresa(a,b){a=_norm(a);b=_norm(b);if(!a||!b)return false;if(a===b||a.includes(b)||b.includes(a))return true;const ta=new Set(a.split(' ').filter(w=>w.length>2));return b.split(' ').filter(w=>w.length>2).some(w=>ta.has(w));}

async function resolverCliente({ profileId, dominio, empresa }) {
  const dominioReal = !!(dominio && !_esEmailGratuito(dominio));

  // Cruza un ancla ya resuelta contra el dominio corporativo (corroboración -> veracidad).
  // 2 fuentes que coinciden = confianza ALTA; si discrepan, flag (NO rechaza).
  async function corroborar(base) {
    if (!dominioReal) return { ...base, confianza: base.confianza || 'media' };
    try {
      const txt = await callMCP('lookup_company', { companyUrlOrName: dominio });
      const empD = _empresaDeLookup(txt), hcD = _headcountDe(txt);
      if (empD && _mismaEmpresa(base.empresa, empD)) {
        const hc = base.headcount ?? hcD;
        console.log(`[CLIENTE] ✓ corroborado: perfil "${base.empresa}" == dominio "${empD}" -> confianza ALTA`);
        return { ...base, headcount: hc, tier: _tier(hc), confianza: 'alta', corroborado: true };
      }
      if (empD) {
        console.warn(`[CLIENTE] ⚠️ discrepancia: perfil="${base.empresa}" vs dominio="${empD}" -> confianza media + flag`);
        return { ...base, confianza: 'media', discrepancia: { perfil: base.empresa, dominio: empD } };
      }
    } catch (e) { console.warn(`[CLIENTE] cruce con dominio falló:`, e.message); }
    return { ...base, confianza: base.confianza || 'media' };
  }

  // 1) profileId del chat -> el perfil de la PERSONA dice dónde trabaja (ancla fuerte)
  if (profileId != null && String(profileId).trim() !== '' && !isNaN(Number(profileId))) {
    try {
      const txt = await callMCP('get_contact_profile', { profileId: Number(profileId) });
      const emp = _empresaDeHeadline(txt);
      const hc = _headcountDe(txt);
      if (emp) {
        console.log(`[CLIENTE] anclado por profileId ${profileId} -> "${emp}" (${hc ?? '?'} empleados, tier ${_tier(hc)})`);
        return await corroborar({ empresa: emp, dominio: dominio || '', headcount: hc, tier: _tier(hc), anclado: true, fuente: 'profile' });
      }
    } catch (e) { console.warn(`[CLIENTE] profileId ${profileId} no resolvió:`, e.message); }
  }
  // 2) dominio corporativo real -> lookup_company
  if (dominio && !_esEmailGratuito(dominio)) {
    try {
      const txt = await callMCP('lookup_company', { companyUrlOrName: dominio });
      const emp = _empresaDeLookup(txt) || empresa || dominio;
      const hc = _headcountDe(txt);
      console.log(`[CLIENTE] anclado por dominio ${dominio} -> "${emp}" (${hc ?? '?'} empleados, tier ${_tier(hc)})`);
      return { empresa: emp, dominio, headcount: hc, tier: _tier(hc), anclado: true, fuente: 'dominio', confianza: 'media' };
    } catch (e) { console.warn(`[CLIENTE] dominio ${dominio} no resolvió:`, e.message); }
  }
  // 3) sin ancla confiable (ej: email gratuito + empresa genérica). NO inventamos.
  console.warn(`[CLIENTE] ⚠️ SIN ANCLAR (dominio="${dominio}", empresa="${empresa}") -> anclado:false`);
  return { empresa: empresa || dominio || '', dominio: dominio || '', headcount: null, tier: null, anclado: false, fuente: 'sin_anclar', confianza: 'baja' };
}

// ===========================================================================
// PIPELINE FULL (3 fases). Principio: la IA aporta CRITERIO + REDACCIÓN; los
// HECHOS (quién existe, su id real, su cargo) los trae el CÓDIGO desde Sales Nav.
// La IA elige de una lista REAL -> es imposible inventar una persona o un link.
//   Fase 1 (runPlan, IA):   research del cliente + ICP + contenido de página 1.
//   Fase 2 (sourceCandidates, CÓDIGO): pool real de candidatos desde Sales Nav.
//   Fase 3 (runSelectWrite, IA): elige los 6 mejores del pool + escribe ángulos.
// ===========================================================================

function _parsePeople(res){
  return [...String(res||'').matchAll(/id=([A-Za-z0-9_\-]+)\s+"([^"]+)"\s+(.*?)\s*\(DISTANCE_(\d|OUT_OF_NETWORK)[^,)]*(?:,\s*([^)]+))?\)/g)]
    .map(x=>({ id:x[1], name:x[2], head:(x[3]||'').trim(), dist: x[4]==='OUT_OF_NETWORK'?9:parseInt(x[4],10), loc:(x[5]||'').trim() }));
}
function _slugCos(n){ return _norm(n).split(' ').filter(Boolean).join('-'); }
function _rankSenioridad(head){
  const h=_norm(head);
  if(/\b(cmo|cto|cfo|ciso|chro|coo|cro|ceo|chief|c level|vp|vice president|vicepresidente)\b/.test(h)) return 5;
  if(/\b(director|directora|head|jefe|jefa)\b/.test(h)) return 4;
  if(/\b(gerente|manager|lead|leader|lider|owner|founder|co-founder)\b/.test(h)) return 3;
  if(/\b(analyst|analista|trainee|intern|becari|pasant|junior|assistant|asistente|associate)\b/.test(h)) return 0;
  return 2;
}

// Rank RELATIVO al cliente: lo "mejor" depende de a QUIÉN le vende el cliente.
// `titulos` = títulos del comprador que define el PLAN (ej. agencia de marketing ->
// cmo, head of marketing, brand manager...). Un decisor de ESA función va al tope;
// un C-level genérico (CEO/dueño) sirve solo si la empresa es chica (lo refina el
// tamaño + la IA); un senior de otra área (CTO/CFO/RRHH) va al fondo.
function _rankFit(head, titulos){
  const h=_norm(head);
  const lista = Array.isArray(titulos) ? titulos : [];
  const matchFuncion = lista.some(t=>{ const n=_norm(t); return n && n.length>=2 && h.includes(n); });
  const sen=_rankSenioridad(head);
  // El "mejor" es RELATIVO al cliente: SOLO el comprador que define el PLAN
  // (titulos_objetivo) va al tope. Un C-level de otra área (CEO/CTO/CFO ajeno) NO
  // recibe bonus — eso floteaba chiefs equivocados. Si para el ICP el comprador es
  // el dueño/CEO (empresas chicas), el PLAN incluye "ceo/founder/owner" y matchea acá.
  return (matchFuncion ? 100 : 10) + sen;
}

// FASE 2 — determinística, SIN IA. Pool real de candidatos desde Sales Nav.
// Búsqueda AMPLIA (país + función, sin restringir grado ni apilar industrias): así
// puebla de verdad (la restricción "2do grado" + industrias apiladas devolvía vacío).
// Parsea get_contact_profile -> headcount (señal de empresa ancla) + headline rico.
// Formato: "Profile: NAME [profileId: N] — HEADLINE (?, NNN employees, LOC)"
function _parseProfile(res){
  const s=String(res||'');
  const hc=(s.match(/(\d[\d,]*)\s+employees/)||[])[1];
  const headRich=((s.match(/—\s*(.+?)\s*\(\s*(?:\?|\d)/)||[])[1]||'').trim();
  return { headcount: hc?parseInt(hc.replace(/,/g,''),10):null, headRich };
}
// Boost por tamaño de empresa. Si el ICP define tamano_min, es RELATIVO al ICP
// (no "más grande = mejor", que rompería la utilidad si el ICP son PyMEs).
function _sizeBoost(hc, tamMin){
  if(hc==null) return 0;
  if(tamMin && tamMin>0) return hc>=tamMin ? 2 : (hc>=tamMin*0.5 ? 1 : 0);
  return hc>=1000?3 : hc>=200?2 : hc>=50?1 : 0;
}

// El país, la función y los títulos del comprador SALEN del cliente (los define el
// PLAN según qué hace la empresa). Si el PLAN no los definió, NO adivinamos —
// "marketing en Argentina" para un cliente que no tiene nada que ver es peor que no
// mandar nada. Abortamos el reporte con un error claro.
function validarPlan(plan){
  const p = (plan && plan._plan) || {};
  const faltan = [];
  if(!p.funcion   || !String(p.funcion).trim())   faltan.push('funcion');
  if(!p.geografia || !String(p.geografia).trim()) faltan.push('geografia');
  if(!Array.isArray(p.titulos_objetivo) || !p.titulos_objetivo.length) faltan.push('titulos_objetivo');
  if(faltan.length) throw new Error(`PLAN incompleto: falta ${faltan.join(', ')} — no se genera el reporte (no se asume función ni país por defecto).`);
  return plan;
}

async function sourceCandidates(plan, cliente){
  validarPlan(plan);                 // sin función/país/títulos NO seguimos
  const icp = plan._plan;
  const geografia = icp.geografia;   // del cliente, no hay default
  const funcion   = icp.funcion;     // del cliente, no hay default
  let locId=null, fnId=null;
  try{ locId=(String(await callMCP('resolve_sales_navigator_id',{type:'LOCATION',keywords:geografia,limit:1})).match(/id="?([0-9]+)"?/)||[])[1]||null; }catch{}
  try{ fnId =(String(await callMCP('resolve_sales_navigator_id',{type:'FUNCTION',keywords:funcion,limit:3})).match(/id="?([A-Za-z0-9_]+)"?/)||[])[1]||null; }catch{}

  // El filtro `function` se IGNORA en esta cuenta (el cursor no lo persiste) -> la
  // búsqueda volvía "cualquiera en el país". `keywords` SÍ se aplica, así que es el
  // que trae de verdad a los de la función. Mandamos function igual por si algún día aplica.
  const f1={ category:'people', profilesLimit:50, keywords: funcion };
  if(locId) f1.location={ include:[locId] };
  if(fnId)  f1.function={ include:[fnId] };
  let pool=[];
  try{ pool=_parsePeople(await callMCP('search_sales_navigator_filtered', f1)); }catch{}
  // Segunda pasada con otra palabra clave del comprador si vino flojo.
  if(pool.length < 10){
    const kw2 = (Array.isArray(icp.titulos_objetivo) && icp.titulos_objetivo[0]) || funcion;
    const f2={ category:'people', profilesLimit:50, keywords: kw2 };
    if(locId) f2.location={ include:[locId] };
    try{ pool=pool.concat(_parsePeople(await callMCP('search_sales_navigator_filtered', f2))); }catch{}
  }
  // Dedup + sacar juniors puros + no targetear al propio cliente.
  const vistos=new Set(); const out=[]; const empCliente=_norm((cliente&&cliente.empresa)||'');
  for(const p of pool){
    if(!p.id || vistos.has(p.id)) continue; vistos.add(p.id);
    if(_rankSenioridad(p.head) < 1) continue;
    const emp=_empresaDeHeadline(p.head)||'';
    if(empCliente && emp && _mismaEmpresa(empCliente, emp)) continue;
    out.push({ id:p.id, name:p.name, head:p.head, empresa:emp, dist:p.dist, loc:p.loc, rank:_rankSenioridad(p.head), fit:_rankFit(p.head, icp.titulos_objetivo) });
  }
  out.sort((a,b)=> (b.fit-a.fit) || (a.dist-b.dist));   // pre-orden: FIT al comprador del cliente, luego grado

  // ENRIQUECER el tope del pool con el perfil real -> headcount (señal de empresa
  // ancla, para EMOCIÓN) + headline rico (material para el ángulo, para UTILIDAD).
  // Infra gratis (IBT). Acotado a K llamadas. El sesgo a ancla queda en el CÓDIGO.
  const K = parseInt(process.env.SOURCE_ENRICH_TOP || '14', 10);
  const noCache = String(process.env.SOURCE_ENRICH_NOCACHE||'').toLowerCase()==='true';
  const tamMin = parseInt(icp.tamano_min || 0, 10) || 0;
  // Piso DURO de ICP: por debajo de esto es freelance/micro-agencia (par/competidor), no un
  // comprador del rango objetivo. Nunca supera el piso del ICP (no descarta targets chicos legítimos).
  const _microBase = parseInt(process.env.ICP_MIN_HEADCOUNT || '20', 10);
  const MICRO = Math.min(_microBase, tamMin>0 ? tamMin : _microBase);
  const top = out.slice(0, K);
  for(const c of top){
    try{
      let prof=_parseProfile(await callMCP('get_contact_profile',{ publicIdOrUrl: c.id, noCache }));
      if(!prof.headRich && !noCache){
        // El perfil cacheado vino escueto (sin headline parseable) -> lo traemos FRESCO de
        // LinkedIn, SOLO para este. Caza el cargo viejo/inflado (ej. la card decía
        // "Head of Marketing" cuando el real es "Growth Hacker"). 1 call extra solo en escuetos.
        try{ const fresco=_parseProfile(await callMCP('get_contact_profile',{ publicIdOrUrl: c.id, noCache:true })); if(fresco.headRich || fresco.headcount!=null){ prof=fresco; c._fresco=true; } }catch{}
      }
      if(prof.headcount!=null) c.headcount=prof.headcount;
      if(prof.headRich && prof.headRich.length>=3){
        // Perfil REAL traído por urn (sin riesgo de homónimo) = FUENTE DE VERDAD.
        // Pisa el headline de la búsqueda (que puede venir viejo) para fit + cargo + empresa.
        // Acá se cae sola la card tipo "Sofia": si el perfil real no es de la función, el
        // fit baja y se hunde; y si igual entrara, el cargo sale del perfil real, no inventado.
        const fresh = prof.headRich;
        if(_norm(fresh)!==_norm(c.head)) c._headViejo = c.head;   // dejá registro si cambió
        c.head    = fresh;
        c.headRich= fresh;
        c.empresa = _empresaDeHeadline(fresh) || c.empresa;
        c.fit     = _rankFit(fresh, icp.titulos_objetivo);
      }
    }catch{}
    const warmth = c.dist===1?2 : c.dist===2?1 : 0;
    c.score = c.fit*3 + _sizeBoost(c.headcount, tamMin)*2 + warmth;   // fit manda; tamaño (ancla) y grado refinan
  }
  // Filtro ICP por tamaño (hard drop con headcount real del enriquecimiento): saca a los
  // freelance/micro-agencias tipo Bernardo (5 emp) — son pares/competidores, no compradores.
  const fueraICP = top.filter(c => c.headcount!=null && c.headcount < MICRO);
  for(const p of fueraICP) console.warn(`[SOURCE] fuera de ICP por tamaño (${p.headcount} emp < ${MICRO}), descartado: ${p.name} @ ${p.empresa||'?'}`);
  const topICP = top.filter(c => !(c.headcount!=null && c.headcount < MICRO));
  topICP.sort((a,b)=> (b.score-a.score) || (a.dist-b.dist));
  const final = topICP.concat(out.slice(K)).slice(0, 12);
  const refit = top.filter(c=>c._headViejo).length;
  const refrescados = top.filter(c=>c._fresco).length;
  console.log(`[SOURCE] Pool: ${out.length} reales | enriquecidos ${top.length}${noCache?' (noCache)':''} | re-fit ${refit} | refrescados ${refrescados} | fuera-ICP ${fueraICP.length} | devueltos ${final.length} (loc=${locId||'?'}, fn=${fnId||funcion}, tamMin=${tamMin||'-'}, micro<${MICRO}).`);
  return final;
}

// FASE 1 — IA: research del cliente (web_search) + ICP + contenido de página 1.
const SYSTEM_PROMPT_PLAN = `# IBT GTM — Fase PLAN (research + ICP + página 1)

Generás la PARTE 1 de un reporte de prospección GTM que IBT manda a un prospecto. NO elegís personas todavía: eso lo hace el sistema. Vos investigás al cliente y definís a QUIÉN hay que buscar.

## Qué hacer
1. Research REAL del cliente con web_search: qué hace/vende, modelo de negocio, país, año de fundación, stage, tracción/proof point. PROHIBIDO inventar — si no lo verificás, no lo afirmes.
2. Definí el ICP del COMPRADOR del cliente: la función/área del decisor depende de lo que el cliente VENDE (una agencia de marketing vende a marketing; una de ciberseguridad a un CISO; una fintech B2B a finanzas). Pensá a quién le compra el producto.
3. Escribí TODO el contenido de página 1 (ribbon, stats, icp, contexto, aperturas, prioridades, lead, proof, h1).

## Reglas
- "fecha" = EXACTAMENTE la fecha de hoy que te paso en el mensaje (no inventes otra).
- Datos de mercado (context): solo si salen de web_search; NO inventes porcentajes redondos.
- El ICP card "Rol del decisor" y el bloque _plan.funcion deben describir al MISMO comprador.
- _plan.titulos_objetivo es CRÍTICO: el sistema rankea los candidatos buscando estas palabras DENTRO del cargo. Poné palabras SUELTAS (no frases), ES+inglés+abreviaturas. Así matchea cualquier variante ("Marketing Director", "VP of Marketing", "Head of Growth" → con "marketing" y "growth" alcanza). Si faltan, el sistema trae el cargo equivocado (un CEO/CTO en vez del decisor del área). Pensá: ¿qué palabra está sí o sí en el título de quien COMPRA esto? Si el ICP apunta a empresas chicas donde el que compra es el dueño/CEO, incluí también "ceo, founder, owner, dueño, fundador" para que esos suban.

## Output — SOLO JSON (sin texto ni markdown alrededor)
{
  "fecha": "Mes Año (la de hoy)",
  "eyebrow": "Reporte de prospección GTM · ... (uppercase corto)",
  "h1_pre": "6 [tipo de cuenta] para escalar",
  "h1_company": "Nombre del cliente (resaltado)",
  "h1_post": "en [País]",
  "lead": "2-3 oraciones que anclan el proof point REAL del cliente.",
  "proof": "El proof point / origen del cliente (texto del box PROOF).",
  "ribbon": [ {"label":"Vertical","value":"..."}, {"label":"País","value":"..."}, {"label":"Fundada","value":"..."}, {"label":"Stage","value":"..."}, {"label":"Modelo","value":"..."} ],
  "stats": [ {"num":"...","label":"..."}, {"num":"6","label":"Cuentas priorizadas"}, {"num":"...","label":"..."}, {"num":"...","label":"..."} ],
  "icp": [ {"title":"Rol del decisor","desc":"..."}, {"title":"Tamaño de empresa","desc":"..."}, {"title":"Geografía","desc":"..."}, {"title":"Vertical / industria","desc":"..."} ],
  "context": [ "bullet 1", "bullet 2", "bullet 3" ],
  "apertura": [ "hook 1", "hook 2", "hook 3" ],
  "prioridades": [ "Alta — ...", "Media — ...", "...", "..." ],
  "_plan": { "funcion": "función del comprador en 1-2 palabras (ej: marketing, ventas, customer experience, finanzas, recursos humanos)", "titulos_objetivo": ["PALABRAS SUELTAS (no frases) que aparecen en el cargo de quien COMPRA lo que vende el cliente, ES+EN+abreviaturas. ej. agencia de marketing: marketing, brand, growth, cmo, comunicacion, publicidad, demand. ej. ciberseguridad: seguridad, security, ciso, infosec. ej. ventas B2B: ventas, sales, comercial, revenue, cro"], "geografia": "País objetivo (ej: Argentina)", "industrias": ["industrias con fit"], "tamano_min": 0 }
}
CANTIDADES EXACTAS: ribbon 5, stats 4, icp 4, context 3, apertura 3, prioridades 4. NADA fuera del objeto JSON.`;

async function runPlan({ empresa, dominio, email, nombre, cliente, fechaHoy }){
  currentStage = 'gen';
  const bloqueCliente = (cliente && cliente.anclado)
    ? `\n\nDATOS VERIFICADOS DEL CLIENTE (NO inventes otra empresa, usá ESTOS): Empresa: ${cliente.empresa}; Tamaño: ${cliente.headcount ?? '?'} empleados${cliente.tier ? ` (tier ${cliente.tier})` : ''}.`
    : '';
  const messages = [{ role:'user', content:`Cliente a analizar:\n- Empresa: ${empresa}\n- Dominio: ${dominio}\n- Email contacto: ${email}\n- Nombre contacto: ${nombre}${bloqueCliente}\n\nFecha de hoy (usala en "fecha"): ${fechaHoy}\n\nInvestigá la empresa con web_search y devolvé SOLO el JSON del schema.` }];
  const MAX = parseInt(process.env.PLAN_MAX_TOOL_ITERS || '8', 10);
  let it=0, cerrar=false;
  while(true){
    const data = await callClaude({ model:MODEL_GEN, system:SYSTEM_PROMPT_PLAN, messages, tools: cerrar?[]:[WEB_SEARCH_TOOL], maxTokens:8000 });
    contarYLoguearWebSearch(data, 'PLAN');
    messages.push({ role:'assistant', content:data.content });
    if(data.stop_reason==='end_turn' || data.stop_reason==='stop_sequence')
      return parseReporteJSON(data.content.find(b=>b.type==='text')?.text);
    if(data.stop_reason==='tool_use'){
      const tr=[]; for(const b of data.content){ if(b.type!=='tool_use') continue; tr.push({type:'tool_result',tool_use_id:b.id,content:await callMCP(b.name,b.input)}); }
      it++; if(it>=MAX) cerrar=true;
      if(tr.length){ if(cerrar) tr.push({type:'text',text:'Suficiente research. Devolvé YA el JSON.'}); messages.push({role:'user',content:tr}); }
      else return parseReporteJSON(messages.filter(m=>m.role==='assistant').pop()?.content?.find(b=>b.type==='text')?.text||'');
    }
  }
}

// FASE 3 — IA: elige los 6 MEJORES del pool REAL + escribe ángulo/hook. Sin tools.
const SYSTEM_PROMPT_SELECT = `# IBT GTM — Fase SELECT (elegir 6 + escribir)

Te paso una LISTA REAL de candidatos (gente que existe, con su id, nombre, cargo textual, empresa y grado de conexión) y el contexto del cliente. Elegís los 8 MEJORES decisores EN ORDEN de prioridad (el mejor primero) y escribís, para cada uno, un ángulo y un hook. El sistema usa los primeros 6 válidos.

## Cómo elegir (en este orden)
1. FIT de función: el cargo tiene que ser CLARAMENTE del rol que compra lo del cliente (ej: si la función es marketing → CMO/VP/Head/Director/Gerente de Marketing o Growth). Un "CEO" o "Dueño" de una empresa chica puede servir porque ahí decide marketing; pero un C-level de un rubro que NO tiene que ver (ej: un CEO inmobiliario en una búsqueda de marketing) NO va, aunque sea senior. Ante la duda de fit, descartalo.
2. Decisor real: nada de analistas, trainees ni juniors.
3. Empresa ANCLA con fit de ICP: usá los "empleados" que te muestro. Preferí empresas reconocibles y del tamaño que le sirve al cliente. Una marca grande y conocida emociona al prospecto; una startup de 8 personas desconocida, no. Pero si el ICP del cliente son PyMEs, una empresa enorme NO sirve aunque sea famosa: priorizá el FIT real, no el tamaño por el tamaño.
4. Coherencia / credibilidad: si una combinación cargo+empresa+ubicación se ve rara o confusa (nombres que no cierran con la geografía, datos contradictorios), no la elijas — genera desconfianza en el prospecto.
5. Diversidad: no repitas la misma empresa salvo que valga mucho.
6. Grado más cálido primero (1er/2do).

## Reglas DURAS
- Elegí SOLO ids que estén en la lista. PROHIBIDO inventar una persona, un id, un cargo o una empresa.
- LOS 8 ids tienen que ser DISTINTOS. Prohibido repetir la misma persona dos veces. Cada uno es una cuenta única.
- CADA uno DEBE tener angulo y hook NO vacíos. Nunca dejes un angulo o un hook en blanco.
- PROHIBIDO copiar/pegar un ángulo o hook de una persona a otra. El ángulo y el hook de cada id tienen que hablar SOLO de ESA persona y ESA empresa. Antes de cerrar, revisá que el nombre y la empresa que mencionás en cada ángulo sean los de ESE id (un error típico es dejar el texto de otra cuenta).
- El hook DEBE empezar nombrando a la persona por su PRIMER NOMBRE (ej: "Clara, ..."). Si la card es de Clara, el hook arranca con "Clara"; nunca con el nombre de otra persona.
- El ángulo (3-4 oraciones) es ESPECÍFICO de esa persona/empresa: usá su cargo, empresa y —si está— el "perfil" REALES + lo que ofrece el cliente. Cuanto más uses su propuesta de valor/contexto real del perfil, mejor el ángulo. Prohibido inventar datos que no estén en lo que te paso. Cada ángulo 100% único — nada de frases genéricas repetidas.
- NUNCA menciones el grado de conexión (1er/2do/3er grado) en el ángulo ni en el hook. El grado lo muestra la tarjeta aparte; si lo escribís y no coincide, queda una contradicción. No hables de "conexión de 1er grado" ni nada por el estilo.
- El hook: UNA sola oración de apertura entre comillas, lista para copiar y mandar.
- Texto plano: NADA de markdown (sin **negritas**, sin asteriscos, sin comentarios). Solo el objeto JSON.

## Output — SOLO JSON (sin texto alrededor)
{ "seleccion": [ {"id":"<id EXACTO de la lista>", "angulo":"...", "hook":"\\"...\\""} ] }
EXACTAMENTE 8 elementos distintos, en orden de prioridad. NADA fuera del objeto JSON.`;

async function runSelectWrite({ cliente, plan, pool, fixes }){
  currentStage = 'gen';
  const lista = pool.map((p,i)=>{
    const tam = p.headcount!=null ? ` (~${p.headcount} empleados)` : '';
    const ctx = (p.headRich && p.headRich!==p.head) ? ` | perfil: ${p.headRich}` : '';
    return `${i+1}. id=${p.id} | ${p.name} | ${p.head} | empresa: ${p.empresa||'?'}${tam} | grado ${p.dist===9?'fuera de red':p.dist+'°'}${ctx}`;
  }).join('\n');
  const ctx = `Cliente: ${(cliente&&cliente.empresa)||plan.h1_company||''}. Qué ofrece / proof: ${String(plan.proof||plan.lead||'').slice(0,500)}. Función del comprador: ${(plan._plan&&plan._plan.funcion)||''}.`;
  const fixBloque = (fixes&&fixes.length) ? `\n\nCORRECCIONES del juez (aplicalas re-eligiendo o reescribiendo):\n- ${fixes.join('\n- ')}` : '';
  const messages = [{ role:'user', content:`${ctx}\n\nLISTA REAL DE CANDIDATOS (elegí de ACÁ, por id EXACTO):\n${lista}${fixBloque}\n\nElegí los 8 MEJORES en ORDEN de prioridad (el mejor primero). Devolvé SOLO el JSON {"seleccion":[...]} con EXACTAMENTE 8 elementos distintos. El sistema arma el reporte con los primeros 6 válidos, así que un error puntual en uno no rompe nada — pero los primeros 6 tienen que ser tus mejores.` }];
  const data = await callClaude({ model:MODEL_GEN, system:SYSTEM_PROMPT_SELECT, messages, tools:[], maxTokens:6000 });
  const j = parseReporteJSON(data.content.find(b=>b.type==='text')?.text);
  return Array.isArray(j && j.seleccion) ? j.seleccion : [];
}

// Ensamblado: los HECHOS de cada card salen del pool (código); la IA solo aportó
// el id elegido + ángulo + hook. Imposible que una card apunte a alguien inexistente.
function armarReporte(plan, seleccion, pool){
  const byId = new Map(pool.map(p=>[p.id, p]));
  const cards=[]; const usados=new Set();
  for(const s of (seleccion||[])){
    if(cards.length >= 6) break;                       // ya tenemos las 6, listo
    const p = byId.get(s.id);
    if(!p){ console.warn(`[SELECT] id fuera del pool, ignorado: ${s.id}`); continue; }
    if(usados.has(s.id)){ console.warn(`[SELECT] id DUPLICADO, ignorado: ${p.name}`); continue; }
    const angulo=String(s.angulo||'').trim(), hook=String(s.hook||'').trim();
    if(!angulo || !hook){ console.warn(`[SELECT] card sin ángulo/hook, descartada: ${p.name}`); continue; }
    const empresa = p.empresa || _empresaDeHeadline(p.head) || '';
    if(!empresa){ console.warn(`[SELECT] card sin empresa real, descartada: ${p.name}`); continue; }
    usados.add(s.id);
    const cargoLimpio = String(p.head||'').split('@')[0].split('|')[0].trim() || _headlineLimpio(p.head) || p.head;
    cards.push({
      empresa,
      nombre: p.name,
      cargo: cargoLimpio,
      urn: p.id, slug: _slugCos(p.name),
      ubicacion: p.loc || ((plan._plan && plan._plan.geografia) || ''),
      grado: _degOrdinal(p.dist===9?3:p.dist, '2do') + ' grado',
      angulo, hook
    });
  }
  if(cards.length < 6) console.warn(`[SELECT] ⚠️ solo ${cards.length}/6 cards válidas tras dedupe/limpieza.`);
  const { _plan, ...base } = plan;
  if(!base.empresa) base.empresa = base.h1_company || '';   // título/headers/footers usan {{empresa}} = cliente
  return { ...base, cards };
}

// Una card está COMPLETA solo si tiene los 5 campos que el prospecto va a ver en el PDF.
function _cardCompleta(c){
  return !!c && ['nombre','empresa','cargo','angulo','hook'].every(k => String(c[k]||'').trim().length > 0);
}
function _cuentaCompletas(data){
  return (((data && data.cards) || []).filter(_cardCompleta)).length;
}

// Selección + armado con REINTENTO determinístico. La IA a veces devuelve un id que no
// existe en el pool, repite, o deja una card sin campos -> quedaríamos en <6. En vez de
// shippear una card vacía (y que el juez lo deje pasar), reintentamos hasta tener 6
// completas. Garantía estructural EN CÓDIGO, no delegada al juez. Devuelve el mejor intento.
async function seleccionarConRetry({ cliente, plan, pool, fixes }){
  const MIN = parseInt(process.env.MIN_CARDS_OK || '6', 10);
  const MAX = parseInt(process.env.SELECT_MAX_TRIES || '2', 10);
  let best=null, bestN=-1;
  for(let i=1;i<=MAX;i++){
    const extra = i>1 ? [`INTENTO ${i}: el intento previo no llegó a ${MIN} cuentas completas. Devolvé 8 ids EXACTOS de la lista (copiá el id tal cual, sin inventar), todos distintos, cada uno con empresa real + ángulo + hook.`] : [];
    const seleccion = await runSelectWrite({ cliente, plan, pool, fixes: (fixes||[]).concat(extra) });
    const data = armarReporte(plan, seleccion, pool);
    const n = _cuentaCompletas(data);
    if(n > bestN){ best=data; bestN=n; }
    if(n >= MIN){ if(i>1) console.log(`[SELECT] OK en intento ${i}: ${n} cards completas.`); return data; }
    console.warn(`[SELECT] intento ${i}: ${n}/${MIN} cards completas — ${i<MAX?'reintento':'sin más reintentos'}.`);
  }
  return best;
}

// Fecha real del server (arregla la fecha "stale" del header).
function _fechaHoy(){
  const meses=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const d=new Date(); return `${meses[d.getMonth()]} ${d.getFullYear()}`;
}
// Nombre profesional del PDF que ve el prospecto en el adjunto.
// Saca caracteres ilegales para nombres de archivo. n8n usa este campo.
function _nombreArchivoPDF(empresa){
  const limpia = String(empresa||'Empresa').replace(/[\\/:*?"<>|]/g,'').replace(/\s+/g,' ').trim() || 'Empresa';
  return `Análisis de Mercado - ${limpia}.pdf`;
}

async function procesar(jobId, { email, dominio, empresa, nombre, profileId }) {
  try {
    console.log(`\n========== Job ${jobId} - Inicio ==========`);
    console.log(`Empresa: ${empresa} | Email: ${email} | Dominio: ${dominio} | profileId: ${profileId ?? '-'}`);
    resetTokenStats();

    // Anclar la identidad del cliente ANTES de generar (perfil del chat -> empresa real + tamaño)
    const cliente = await resolverCliente({ profileId, dominio, empresa });
    const empresaFinal = cliente.empresa || empresa;

    // FASE 1: research del cliente + ICP + página 1 (IA, 1 call con web_search)
    const fechaHoy = _fechaHoy();
    const plan = await runPlan({ empresa: empresaFinal, dominio, email, nombre, cliente, fechaHoy });
    // FASE 2: pool REAL de candidatos desde Sales Nav (código, sin IA)
    const pool = await sourceCandidates(plan, cliente);
    // FASE 3: la IA elige del pool real + escribe ángulos, con REINTENTO hasta 6 completas.
    let data = await seleccionarConRetry({ cliente, plan, pool });

    let cleanHtml = limpiarHtml(renderReport(data));   // datos JSON -> HTML con plantilla fija
    if (!cleanHtml) throw new Error('No se pudo renderizar el reporte');

    let pdfBuffer = await renderizarPdf(cleanHtml);
    let pageCount = await contarPaginas(pdfBuffer);

    let judgeResult = await runJudge(cleanHtml, pageCount);

    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      console.log(`[Job ${jobId}] Juez rechazó ${judgeResult.score}/8 — aplicando fixes...`);
      try {
        const fixedData = await seleccionarConRetry({ cliente, plan, pool, fixes: judgeResult.fixes });
        // No aceptamos el fix si EMPEORA el conteo de cards completas (jamás degradar a card vacía).
        const compFixed = _cuentaCompletas(fixedData), compPrev = _cuentaCompletas(data);
        if (compFixed >= compPrev) {
          data = fixedData;
          cleanHtml = limpiarHtml(renderReport(data));
          pdfBuffer = await renderizarPdf(cleanHtml);
          pageCount = await contarPaginas(pdfBuffer);
          console.log(`[Job ${jobId}] Re-validando con el juez después de fixes...`);
          judgeResult = await runJudge(cleanHtml, pageCount);
        } else {
          console.warn(`[FIX] el fix dio ${compFixed} cards completas vs ${compPrev} previas — conservo el reporte previo.`);
        }
      } catch (e) {
        console.warn(`[FIX] Falló, conservo el reporte previo:`, e.message);
      }
    }

    // INTEGRIDAD determinística (EN CÓDIGO, no delegada al juez): exactamente 6 cards
    // COMPLETAS (nombre, empresa, cargo, ángulo, hook) o NO es apto para envío.
    const MIN_CARDS_OK = parseInt(process.env.MIN_CARDS_OK || '6', 10);
    const cardsValidas = _cuentaCompletas(data);
    // El juez NUNCA puede dejar pasar un reporte incompleto: lo pisamos a RECHAZADO.
    if (cardsValidas < MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO') {
      console.warn(`[INTEGRIDAD] Override: juez dijo APROBADO con ${cardsValidas}/${MIN_CARDS_OK} cards completas → RECHAZADO.`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 5),
        fixes: [`Reporte INCOMPLETO: ${cardsValidas}/${MIN_CARDS_OK} cuentas completas. Faltan decisores reales con empresa, cargo, ángulo y hook — el sourcing/selección debe entregar 6.`].concat(judgeResult.fixes||[]) };
    }
    // Apto para envío automático = 6 cards COMPLETAS *y* el juez aprobó la calidad.
    const aptoEnvio = cardsValidas >= MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO';
    const descartadas = [];
    console.log(aptoEnvio
      ? `[INTEGRIDAD] OK: ${cardsValidas} cards completas + juez APROBADO.`
      : `[INTEGRIDAD] ⚠️ NO apto: ${cardsValidas}/${MIN_CARDS_OK} completas, juez ${judgeResult.veredicto}.`);

    // Log de tokens/costo del reporte completo
    logTokenCost(`Job ${jobId}`);

    jobs.set(jobId, {
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: empresaFinal,
      anclado: cliente.anclado,
      cliente_resuelto: cliente,
      apto_envio: aptoEnvio,
      cards_validas: cardsValidas,
      cards_descartadas: descartadas,
      nombre,
      email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: [],
      links_no_resueltos: [],
      grados_corregidos: [],
      grados_mal: [],
      tokens: { ...tokenStats },
      // Campos planos para mapear fácil en n8n / Google Sheets
      tokens_input: tokenStats.input,
      tokens_output: tokenStats.output,
      tokens_cache_write: tokenStats.cache_write,
      tokens_cache_read: tokenStats.cache_read,
      finishedAt: Date.now()
    });
    console.log(`========== Job ${jobId} - OK ${pageCount} páginas, juez FINAL ${judgeResult.veredicto} ${judgeResult.score}/8 ==========\n`);
  } catch (err) {
    console.error(`[Job ${jobId}] Error:`, err);
    jobs.set(jobId, { status: 'error', error: err.message, finishedAt: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

const jobs = new Map();

setInterval(() => {
  const limite = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if ((job.finishedAt || job.createdAt || 0) < limite) jobs.delete(id);
  }
}, 30 * 60 * 1000);

app.post('/generar', (req, res) => {
  const { email, dominio, empresa, nombre, profileId } = req.body || {};
  if (!empresa && !dominio && !profileId) {
    return res.status(400).json({ error: 'Falta empresa, dominio o profileId' });
  }
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'processing', createdAt: Date.now() });
  res.status(202).json({ jobId, status: 'processing' });
  procesar(jobId, { email, dominio, empresa: empresa || dominio, nombre: nombre || '', profileId });
});

app.get('/resultado/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
  res.json(job);
});

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio, empresa, nombre, profileId } = req.body || {};
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  try {
    resetTokenStats();
    const cliente = await resolverCliente({ profileId, dominio, empresa: empresa || dominio });
    const empresaFinal = cliente.empresa || empresa || dominio;
    const fechaHoy = _fechaHoy();
    const plan = await runPlan({ empresa: empresaFinal, dominio, email, nombre: nombre || '', cliente, fechaHoy });
    const pool = await sourceCandidates(plan, cliente);
    let data = await seleccionarConRetry({ cliente, plan, pool });

    let cleanHtml = limpiarHtml(renderReport(data));
    if (!cleanHtml) return res.status(500).json({ error: 'No se pudo renderizar el reporte' });

    let pdfBuffer = await renderizarPdf(cleanHtml);
    let pageCount = await contarPaginas(pdfBuffer);
    let judgeResult = await runJudge(cleanHtml, pageCount);

    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      try {
        const fixedData = await seleccionarConRetry({ cliente, plan, pool, fixes: judgeResult.fixes });
        const compFixed = _cuentaCompletas(fixedData), compPrev = _cuentaCompletas(data);
        if (compFixed >= compPrev) {
          data = fixedData;
          cleanHtml = limpiarHtml(renderReport(data));
          pdfBuffer = await renderizarPdf(cleanHtml);
          pageCount = await contarPaginas(pdfBuffer);
          judgeResult = await runJudge(cleanHtml, pageCount);
        } else {
          console.warn(`[FIX] el fix dio ${compFixed} cards completas vs ${compPrev} previas — conservo el reporte previo.`);
        }
      } catch (e) {
        console.warn(`[FIX] Falló, conservo el reporte previo:`, e.message);
      }
    }

    const MIN_CARDS_OK = parseInt(process.env.MIN_CARDS_OK || '6', 10);
    const cardsValidas = _cuentaCompletas(data);
    if (cardsValidas < MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO') {
      console.warn(`[INTEGRIDAD] Override: juez dijo APROBADO con ${cardsValidas}/${MIN_CARDS_OK} cards completas → RECHAZADO.`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 5),
        fixes: [`Reporte INCOMPLETO: ${cardsValidas}/${MIN_CARDS_OK} cuentas completas.`].concat(judgeResult.fixes||[]) };
    }
    const aptoEnvio = cardsValidas >= MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO';
    const descartadas = [];
    console.log(aptoEnvio
      ? `[INTEGRIDAD] OK: ${cardsValidas} cards completas + juez APROBADO.`
      : `[INTEGRIDAD] ⚠️ NO apto: ${cardsValidas}/${MIN_CARDS_OK} completas, juez ${judgeResult.veredicto}.`);

    logTokenCost('generar-reporte');

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: empresaFinal,
      anclado: cliente.anclado,
      cliente_resuelto: cliente,
      apto_envio: aptoEnvio,
      cards_validas: cardsValidas,
      cards_descartadas: descartadas,
      nombre: nombre || '',
      email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: [],
      links_no_resueltos: [],
      grados_corregidos: [],
      grados_mal: [],
      tokens: { ...tokenStats },
      tokens_input: tokenStats.input,
      tokens_output: tokenStats.output,
      tokens_cache_write: tokenStats.cache_write,
      tokens_cache_read: tokenStats.cache_read
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, jobs_activos: jobs.size }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
}

// Export para el verificador local (verificar.js). NO afecta el arranque normal:
// con `node server.js` sigue levantando el server; al requerirlo desde un test, no.
module.exports = {
  validarPlan, sourceCandidates, armarReporte, verificarLinksData,
  parseReporteJSON, _rankFit, _rankSenioridad, _parseProfile, _sizeBoost,
  _parsePeople, _norm, _empresaDeHeadline, _slugCos, _degOrdinal, _headlineLimpio, _fechaHoy
};
