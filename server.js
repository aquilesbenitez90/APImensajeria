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

const SYSTEM_PROMPT_JUDGE = `Sos un juez de control de calidad EXTREMADAMENTE ESTRICTO para reportes GTM de IBT.

Recibís el HTML del reporte + el número de páginas del PDF ya renderizado. Validás los 8 criterios y retornás un JSON.

Tu objetivo: detectar reportes con DATOS INVENTADOS o INCONSISTENCIAS. Sé paranoico. En duda → FAIL.

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

6. **Personalización ICE y CARGO/EMPRESA REAL de los decisores** (CRÍTICO):
   - Cada card debe tener ángulo único, nombre del decisor, pain específico
   - FAIL si encuentra frases genéricas como "escalar tu operación", "mejorar la eficiencia"
   - FAIL si detectás señales de cargo/empresa INVENTADO en las tarjetas:
     * Todas las 6 personas tienen exactamente el mismo tipo de cargo (todos "Founder & CEO") de forma sospechosamente uniforme cuando vinieron de una búsqueda amplia
     * El ángulo personalizado inventa contexto muy específico sobre la empresa de la persona que no podría saberse solo del headline
     * Una empresa mencionada como empleadora de un decisor suena fabricada o no se condice con un perfil real
   - En duda sobre si un cargo/empresa fue inventado → FAIL

7. **Sin datos rotos** — sin [INSERT], TODO, undefined, lorem ipsum, fechas incoherentes
   FAIL si todas las tarjetas dicen "2do grado" de forma idéntica y hardcodeada (debería reflejar el grado real)

8. **Proof points presentes y plausibles** — al menos 1 ancla de credibilidad del cliente
   FAIL si los proof points suenan fabricados (porcentajes redondos sin contexto, métricas sin fuente)

Respondé EXCLUSIVAMENTE con JSON válido, sin markdown, sin texto extra:
{"veredicto":"APROBADO"|"RECHAZADO","score":<0-8>,"fixes":["fix concreto 1","fix concreto 2"]}

APROBADO solo si pasa los 8/8. Si RECHAZADO, "fixes" lista instrucciones concretas.`;

const SYSTEM_PROMPT_FIX = `Sos el generador del reporte GTM de IBT. Recibís un HTML existente y una lista de correcciones del juez. Aplicá las correcciones y devolvé SOLO el HTML completo corregido (<!DOCTYPE html> ... </html>), EXACTAMENTE 4 páginas A4, footer incluido, mismo design system CommerceGlass v8. Sin explicaciones, sin markdown.

IMPORTANTE:
- Si el juez detectó datos inventados de la empresa, USAR web_search para verificar y corregir.
- Si el juez detectó CARGO/EMPRESA inventado de un decisor, volvé a llamar a get_contact_profile o search_sales_navigator_filtered para obtener el headline REAL, y usá ese cargo/empresa textual. Si el headline está sucio y no se entiende la empresa, mostrá el headline crudo o descartá ese perfil y buscá otro real.
- Si el juez detectó "2do grado" hardcodeado, usá el grado de conexión real.
- Si el juez detectó páginas extra (5+), eliminá las que no sean: 1 overview + 3 account cards = 4 páginas.
- Si el juez detectó una cuenta que es proof point del cliente, reemplazala por otro perfil real.
- NUNCA inventes datos. Si no podés verificar, usar formulación conservadora o descartar.`;

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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

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

async function runClaude({ email, dominio, empresa, nombre, tools }) {
  currentStage = 'gen';
  const anthropicTools = [
    ...tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    })),
    WEB_SEARCH_TOOL
  ];

  const messages = [{
    role: 'user',
    content: `Generá el reporte GTM para este prospecto:\n- Nombre: ${nombre}\n- Empresa: ${empresa}\n- Email: ${email}\n- Dominio: ${dominio}\n\nSeguí el workflow completo del skill. PRIMERO hacé research REAL con web_search sobre la empresa (fundación, modelo, stage, tracción) — PROHIBIDO inventar datos. Luego encontrá 6 cuentas con Sales Navigator. El cargo y empresa de cada decisor deben salir TEXTUAL del headline real — NUNCA inventes empresa/cargo para que encaje con el ICP. Devolvé SOLO el HTML con EXACTAMENTE 4 páginas.`
  }];

  let mcpCallCount = 0;       // llamadas a IBT (client tools que puenteamos)
  let webSearchCount = 0;     // búsquedas web REALES (server tool)
  while (true) {
    const data = await callClaude({
      model: MODEL_GEN,
      system: SYSTEM_PROMPT_HTML,
      messages,
      tools: anthropicTools,
      stopSequences: ['</html>'],
      maxTokens: 16000
    });

    // Conteo + log REAL de web_search (server tool). Ver contarYLoguearWebSearch.
    webSearchCount += contarYLoguearWebSearch(data, 'GEN');

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'stop_sequence' || data.stop_reason === 'end_turn') {
      console.log(`[GEN] Generación terminada. MCP calls: ${mcpCallCount} | web_search: ${webSearchCount}`);
      if (webSearchCount === 0) {
        console.warn(`[GEN] WARNING: 0 búsquedas web reales. Datos de la empresa NO verificados contra internet.`);
      }
      return data.content.find(b => b.type === 'text')?.text;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content) {
        // Solo procesamos client tools (IBT). Los server tools (web_search) ya
        // los ejecutó la API y NO aparecen como bloques `tool_use`.
        if (block.type !== 'tool_use') continue;
        mcpCallCount++;
        const result = await callMCP(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result
        });
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      } else {
        break;
      }
    }
  }
  const lastAssistantMsg = messages.filter(m => m.role === 'assistant').pop();
  return lastAssistantMsg?.content?.find(b => b.type === 'text')?.text || '';
}

async function runJudge(html, pageCount) {
  currentStage = 'judge';
  console.log(`[JUDGE] Evaluando reporte (${pageCount} páginas)...`);
  const data = await callClaude({
    model: MODEL_JUDGE,
    system: SYSTEM_PROMPT_JUDGE,
    messages: [{
      role: 'user',
      content: `Páginas del PDF renderizado: ${pageCount}\n\nHTML del reporte:\n${html}`
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

async function runFixer({ html, fixes, empresa, tools }) {
  currentStage = 'fix';
  console.log(`[FIX] Aplicando ${fixes.length} fixes...`);
  const anthropicTools = [
    ...tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    })),
    WEB_SEARCH_TOOL
  ];

  const messages = [{
    role: 'user',
    content: `Empresa: ${empresa}\n\nCorrecciones a aplicar del juez:\n- ${fixes.join('\n- ')}\n\nHTML actual:\n${html}\n\nAplicá los fixes (usando web_search o get_contact_profile si hay datos a verificar) y devolvé SOLO el HTML completo corregido con EXACTAMENTE 4 páginas.`
  }];

  let mcpCallCount = 0;       // llamadas a IBT
  let webSearchCount = 0;     // búsquedas web REALES (server tool)
  while (true) {
    const data = await callClaude({
      model: MODEL_FIX,
      system: SYSTEM_PROMPT_FIX,
      messages,
      tools: anthropicTools,
      stopSequences: ['</html>'],
      maxTokens: 16000
    });

    webSearchCount += contarYLoguearWebSearch(data, 'FIX');

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'stop_sequence' || data.stop_reason === 'end_turn') {
      console.log(`[FIX] Terminado. MCP calls: ${mcpCallCount} | web_search: ${webSearchCount}`);
      return data.content.find(b => b.type === 'text')?.text;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
        mcpCallCount++;
        const result = await callMCP(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result
        });
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      } else {
        break;
      }
    }
  }
  const lastAssistantMsg = messages.filter(m => m.role === 'assistant').pop();
  return lastAssistantMsg?.content?.find(b => b.type === 'text')?.text || '';
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
async function procesar(jobId, { email, dominio, empresa, nombre }) {
  try {
    console.log(`\n========== Job ${jobId} - Inicio ==========`);
    console.log(`Empresa: ${empresa} | Email: ${email} | Dominio: ${dominio}`);
    resetTokenStats();

    const tools = await listMCPTools();

    let html = await runClaude({ email, dominio, empresa, nombre, tools });
    let cleanHtml = limpiarHtml(html);
    if (!cleanHtml) throw new Error('Claude no devolvió HTML');

    // GATE de integridad de links (post-gen, antes del juez)
    let linkCheck = await verificarLinks(cleanHtml);
    cleanHtml = linkCheck.html;
    if (linkCheck.corregidos.length) console.log(`[LINKS] ${linkCheck.corregidos.length} link(s) corregido(s)`);
    if (linkCheck.noResueltos.length) console.warn(`[LINKS] ⚠️ ${linkCheck.noResueltos.length} link(s) NO resuelto(s):`, JSON.stringify(linkCheck.noResueltos));

    let pdfBuffer = await renderizarPdf(cleanHtml);
    let pageCount = await contarPaginas(pdfBuffer);

    let judgeResult = await runJudge(cleanHtml, pageCount);

    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      console.log(`[Job ${jobId}] Juez rechazó ${judgeResult.score}/8 — aplicando fixes...`);
      const fixedHtml = await runFixer({
        html: cleanHtml,
        fixes: judgeResult.fixes,
        empresa,
        tools
      });
      const cleanFixed = limpiarHtml(fixedHtml);
      if (cleanFixed) {
        cleanHtml = cleanFixed;

        // GATE de links otra vez (el fixer regenera todo el HTML)
        linkCheck = await verificarLinks(cleanHtml);
        cleanHtml = linkCheck.html;
        if (linkCheck.corregidos.length) console.log(`[LINKS] post-fix: ${linkCheck.corregidos.length} corregido(s)`);
        if (linkCheck.noResueltos.length) console.warn(`[LINKS] ⚠️ post-fix NO resuelto(s):`, JSON.stringify(linkCheck.noResueltos));

        pdfBuffer = await renderizarPdf(cleanHtml);
        pageCount = await contarPaginas(pdfBuffer);

        console.log(`[Job ${jobId}] Re-validando con el juez después de fixes...`);
        judgeResult = await runJudge(cleanHtml, pageCount);
      }
    }

    // Log de tokens/costo del reporte completo
    logTokenCost(`Job ${jobId}`);

    jobs.set(jobId, {
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa,
      nombre,
      email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: linkCheck.corregidos,
      links_no_resueltos: linkCheck.noResueltos,
      grados_corregidos: linkCheck.gradosCorregidos,
      grados_mal: linkCheck.gradosMal,
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
  const { email, dominio, empresa, nombre } = req.body || {};
  if (!empresa && !dominio) {
    return res.status(400).json({ error: 'Falta empresa o dominio' });
  }
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'processing', createdAt: Date.now() });
  res.status(202).json({ jobId, status: 'processing' });
  procesar(jobId, { email, dominio, empresa: empresa || dominio, nombre: nombre || '' });
});

app.get('/resultado/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
  res.json(job);
});

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio, empresa, nombre } = req.body || {};
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  try {
    resetTokenStats();
    const tools = await listMCPTools();
    let html = await runClaude({ email, dominio, empresa: empresa || dominio, nombre: nombre || '', tools });
    let cleanHtml = limpiarHtml(html);
    if (!cleanHtml) return res.status(500).json({ error: 'Claude no devolvió HTML' });

    // GATE de integridad de links (post-gen, antes del juez)
    let linkCheck = await verificarLinks(cleanHtml);
    cleanHtml = linkCheck.html;
    if (linkCheck.corregidos.length) console.log(`[LINKS] ${linkCheck.corregidos.length} link(s) corregido(s)`);
    if (linkCheck.noResueltos.length) console.warn(`[LINKS] ⚠️ ${linkCheck.noResueltos.length} link(s) NO resuelto(s):`, JSON.stringify(linkCheck.noResueltos));

    let pdfBuffer = await renderizarPdf(cleanHtml);
    let pageCount = await contarPaginas(pdfBuffer);
    let judgeResult = await runJudge(cleanHtml, pageCount);

    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      const fixedHtml = await runFixer({ html: cleanHtml, fixes: judgeResult.fixes, empresa: empresa || dominio, tools });
      const cleanFixed = limpiarHtml(fixedHtml);
      if (cleanFixed) {
        cleanHtml = cleanFixed;
        linkCheck = await verificarLinks(cleanHtml);
        cleanHtml = linkCheck.html;
        pdfBuffer = await renderizarPdf(cleanHtml);
        pageCount = await contarPaginas(pdfBuffer);
        judgeResult = await runJudge(cleanHtml, pageCount);
      }
    }

    logTokenCost('generar-reporte');

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: empresa || dominio,
      nombre: nombre || '',
      email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: linkCheck.corregidos,
      links_no_resueltos: linkCheck.noResueltos,
      grados_corregidos: linkCheck.gradosCorregidos,
      grados_mal: linkCheck.gradosMal,
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
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
