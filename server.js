/**
 * IBT GTM Report — server.js (versión híbrida final v4)
 *
 * Cambios v4 respecto a v3:
 *   - Paso 3 actualizado: OBLIGATORIO llamar a get_contact_profile DESPUÉS de search_sales_navigator_filtered
 *     para obtener los slugs públicos verificables (publicIdentifier limpio tipo "juan-perez")
 *   - PROHIBIDO usar IDs opacos del tipo "ACwAA..." en las URLs
 *   - Estructura ESTRICTAMENTE 4 páginas: 1 overview + 3 con account cards (sin agregar playbooks ni páginas extras)
 *   - Coherencia: las 6 cuentas son PROSPECTS, nunca proof points o casos de éxito existentes del cliente
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
const MODEL_FIX = 'claude-opus-4-7';

const MCP_URL = 'https://backoffice-server-production.up.railway.app/api/mcp';
const IBT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'x-email': process.env.IBT_EMAIL,
  'x-password': process.env.IBT_PASSWORD
};

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
  console.log(`[MCP] ${toolList.length} tools disponibles: ${toolList.map(t => t.name).join(', ')}`);
  
  const hasResolve = toolList.some(t => t.name === 'resolve_sales_navigator_id');
  const hasSearch = toolList.some(t => t.name === 'search_sales_navigator_filtered');
  const hasProfile = toolList.some(t => t.name === 'get_contact_profile');
  if (!hasResolve) console.warn(`[MCP] WARNING: resolve_sales_navigator_id NO está disponible`);
  if (!hasSearch) console.warn(`[MCP] WARNING: search_sales_navigator_filtered NO está disponible`);
  if (!hasProfile) console.warn(`[MCP] WARNING: get_contact_profile NO está disponible`);
  
  return toolList;
}

// ---------------------------------------------------------------------------
// PROMPTS
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT_HTML = `# IBT GTM Report — Skill completo

Generás un reporte GTM de EXACTAMENTE 4 páginas A4 que IBT manda a prospectos: identificás 6 decisores reales en LinkedIn que encajan con el ICP del cliente, los organizás en un HTML branded. El PDF se renderiza después con Puppeteer.

---

## Workflow completo

### 1. Research de la empresa
Hacer web_fetch o WebSearch sobre el dominio. Extraer:
- Qué hace el producto (1-2 oraciones)
- Modelo de negocio (B2B SaaS / marketplace / fintech / etc.)
- País de origen y expansión
- Tracción / métricas públicas (funding, clientes, revenue, usuarios)
- Proof point clave para usar en el reporte

Si el sitio bloquea JS, buscar en LinkedIn company page y Crunchbase.

### 2. Definir el ICP del cliente
A partir del research, definir:
- Tamaño de empresa target (headcount, revenue)
- Rol del decisor (CFO, Director Comercial, Head of CX, etc.)
- Industrias donde el producto tiene fit claro
- País(es) donde tiene sentido hacer outreach

Regla: los 6 accounts deben ser EMPRESAS ANCLA — grandes, conocidas, con cadenas de valor o bases de clientes que el producto puede monetizar.

REGLA DE COHERENCIA: las 6 cuentas son PROSPECTS — empresas que aún NO son clientes del producto. NUNCA incluir como cuenta target a una empresa que ya es proof point, caso de éxito o cliente conocido del producto del reporte. Si una empresa aparece como referencia en el research, EXCLUIRLA de las 6 cuentas target.

### 3. Buscar 6 perfiles REALES en Sales Navigator

REGLA CRÍTICA: PROHIBIDO inventar URLs, nombres o slugs de LinkedIn. TODOS los perfiles DEBEN salir de la búsqueda real en Sales Navigator.

El flujo OBLIGATORIO es de 3 pasos:

**Paso 3.1: Resolver IDs con resolve_sales_navigator_id**

search_sales_navigator_filtered NO acepta nombres como strings. Necesita IDs.
Llamar primero a resolve_sales_navigator_id con:
- type: "LOCATION", keywords: nombre del país (ej: "Argentina", "Mexico", "Colombia")
- type: "SALES_INDUSTRY", keywords: nombre de la industria
- type: "SENIORITY", keywords: nivel (ej: "Director", "VP", "C-level")
- type: "FUNCTION", keywords: función (ej: "Sales", "Operations", "Finance")

**Paso 3.2: Buscar perfiles con search_sales_navigator_filtered**

Llamar con esta estructura:
{
  "category": "people",
  "degreeOfConnection": ["2nd"],
  "location": { "include": ["<ID de location>"] },
  "industry": { "include": ["<ID de industria>"] },
  "seniority": { "include": ["<ID de seniority>"] },
  "function": { "include": ["<ID de función>"] },
  "profilesLimit": 20
}

De los resultados, pre-seleccionar EXACTAMENTE 6 perfiles considerando:
1. Rol / seniority (decision-makers, no ICs junior)
2. Empresa ancla reconocible (no startups desconocidas)
3. Fit con el pain del producto

**Paso 3.3: OBLIGATORIO — Obtener slug público con get_contact_profile**

search_sales_navigator_filtered devuelve IDs opacos del tipo "ACwAA..." en publicIdOrUrl. ESTOS NO SON SLUGS PÚBLICOS VÁLIDOS.

Para CADA uno de los 6 perfiles preseleccionados, DEBÉS llamar a get_contact_profile pasando ese ID opaco como publicIdOrUrl. La respuesta va a contener el publicIdentifier REAL (un slug limpio tipo "juan-perez" o "maria-garcia-cfo").

PROHIBIDO usar URLs con IDs opacos tipo "linkedin.com/in/ACwAA...". 
PROHIBIDO usar URLs inventadas.
PROHIBIDO usar linkedin.com/company/X.

URL FINAL OBLIGATORIA: https://www.linkedin.com/in/[publicIdentifier limpio de get_contact_profile]

Ejemplos de URLs VÁLIDAS:
- linkedin.com/in/antonio-feeney
- linkedin.com/in/gustavo-barsola
- linkedin.com/in/edmundo-miralles
- linkedin.com/in/andres-salazar-oracle

Ejemplos de URLs INVÁLIDAS (PROHIBIDAS):
- linkedin.com/in/ACwAABbL89gBQGDmLsHNWaE9wF5AlSzoTA5v8VY ← ID opaco, INVÁLIDO
- linkedin.com/in/ACwAAAPioh8BGa-lrnSM_vLC-0v16pDLlk6mvUM ← ID opaco, INVÁLIDO

Si get_contact_profile no devuelve un publicIdentifier limpio para un perfil, DESCARTAR ese perfil y elegir otro de los resultados de search_sales_navigator_filtered. Repetir hasta tener 6 perfiles con slugs limpios verificables.

### 4. Estructura del reporte — EXACTAMENTE 4 páginas (NI MÁS NI MENOS)

PROHIBIDO agregar páginas extra como "playbook", "secuencia operativa", "plan de 30 días" o cualquier otra cosa fuera del scope. La estructura es ESTRICTAMENTE:

- Página 1: Overview estratégico
- Página 2: Account cards 1 y 2
- Página 3: Account cards 3 y 4  
- Página 4: Account cards 5 y 6

NO agregar página 5. NO agregar página 0 con índice. EXACTAMENTE 4 páginas.

#### Página 1 — Overview estratégico
[HEADER IBT] + [RIBBON: Vertical · País · Fundada · ARR/Tracción]
[EYEBROW Geist Mono uppercase] + [H1: "6 [tipo de cuenta] para escalar [Empresa] en [País]"]
[Lead: 2-3 oraciones, ancla el proof point clave del cliente]
[STATS — 4 chips]: Fecha · "6 · Priorizadas" · Métrica clave · Meta comercial
[ICP GRID — 4 tarjetas]: perfil decisor · señal de compra · pain primario · tamaño empresa
[CONTEXTO MACRO]: 2-3 bullets con datos de mercado
[ÁNGULOS DE APERTURA]: 3 hooks para LinkedIn
[CHIPS de prioridad]: etiquetas de industria/vertical

#### Páginas 2-4 — Account cards (2 por página)
[NÚMERO] · [EMPRESA]
[Avatar circular con inicial] + [Nombre decisor] + [Cargo · Empresa]
[linkedin.com/in/[slug limpio] → link clicable] + [País · 2do grado · Año en rol]
[ÁNGULO PERSONALIZADO]: 3-4 oraciones específicas. Mencionar nombre del decisor, pain concreto, cómo el producto lo resuelve. NO copy-paste entre cards.
[HOOK DE APERTURA]: una oración entre comillas.

REGLA ICE: cada card 100% única. Diferente empresa, pain y gancho. PROHIBIDO frases genéricas como "escalar tu operación" o "mejorar la eficiencia".

### 5. Design system CommerceGlass v8

Variables CSS — NO TOCAR:
\`\`\`css
:root {
  --ink: #0A0C14; --ink-2: #3A3F4A; --ink-3: #6B717B; --ink-4: #A0A5AE;
  --bg: #F0F2F7; --panel: #FFFFFF; --panel-2: #F2F4F8; --line: rgba(10,12,20,0.10);
  --accent: #2B4BFF; --accent-soft: rgba(43,75,255,0.08); --accent-edge: rgba(43,75,255,0.25);
  --cta: #0A0C14; --cta-fg: #FFFFFF; --radius: 10px;
  --font: 'Geist', 'Inter', sans-serif; --mono: 'Geist Mono', 'JetBrains Mono', monospace;
}
\`\`\`

Fuentes (incluir en <head>):
\`\`\`html
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
\`\`\`

Tipografía:
- Eyebrow/labels: Geist Mono · 8-9px · uppercase · letter-spacing 0.14em
- H1: 28px · weight 700 · letter-spacing -0.03em
- H2: 14-15px · weight 600
- Cuerpo: 11px · line-height 1.55
- Acento: <span style="color:var(--accent)">texto</span> — máximo 1-2 palabras por sección

CSS de página (usar tal cual):
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

Footer en cada página (DENTRO del HTML):
\`\`\`html
<footer class="page-footer">
  <span>INBOUND-TOOLS.COM ● ANÁLISIS GTM · [EMPRESA]</span>
  <span>PÁGINA [N] / 4</span>
</footer>
\`\`\`

---

## Anti-patterns
- URL tipo linkedin.com/company/X → usar perfil personal /in/
- URL con ID opaco linkedin.com/in/ACwAA... → INVÁLIDO, llamar a get_contact_profile para obtener slug limpio
- URL inventada sin pasar por search_sales_navigator_filtered + get_contact_profile → PROHIBIDO
- Empresa proof point/cliente del producto como cuenta target → INCONSISTENCIA, excluirla
- PDF en 5+ páginas con playbook extra → ELIMINAR, exactamente 4 páginas
- Copy-paste de ángulos entre cards → cada card con pain específico
- PDF en 3 páginas → revisar page-break-after en las 3 primeras
- Sales Nav 0 resultados → quitar filtro industria, cambiar keywords ES/EN
- Datos rotos: nada de [INSERT], TODO, undefined, lorem ipsum

---

## Output FINAL
- La respuesta DEBE empezar exactamente con <!DOCTYPE html>
- La respuesta DEBE terminar exactamente con </html>
- NO escribas NADA antes del <!DOCTYPE html>, ni explicaciones, ni "Let me"
- NO uses bloques de código markdown
- EXACTAMENTE 4 divs .page, ni uno más ni uno menos`;

const SYSTEM_PROMPT_JUDGE = `Sos un juez de control de calidad EXTREMADAMENTE ESTRICTO para reportes GTM de IBT.

Recibís el HTML del reporte + el número de páginas del PDF ya renderizado. Validás los 8 criterios y retornás un JSON.

Tu objetivo: detectar reportes con datos INVENTADOS o inconsistencias. Sé paranoico. En duda → FAIL.

Criterios:

1. **LinkedIn /in/ format** — todos los URLs usan linkedin.com/in/[slug], NUNCA company
   FAIL si encuentras algún linkedin.com/company/
   FAIL si encuentras URLs con IDs opacos tipo "linkedin.com/in/ACwAA..." (esos son member IDs internos, NO slugs públicos verificables)

2. **Exactamente 6 cuentas** — ni más ni menos

3. **EXACTAMENTE 4 páginas PDF** — usá el conteo provisto en el mensaje
   FAIL si el PDF tiene 5 o más páginas (no debe haber playbooks, secuencias operativas, ni páginas extra fuera de overview + 3 de account cards)
   FAIL si tiene 3 o menos páginas

4. **Slug accuracy — DETECCIÓN DE SLUGS INVENTADOS o INVÁLIDOS** (CRÍTICO):
   FAIL si detectás CUALQUIERA de estas señales:
   - URLs con IDs opacos tipo "linkedin.com/in/ACwAA..." → estos son member IDs internos, NO slugs públicos verificables, INVÁLIDOS
   - Slugs con patrón demasiado limpio sospechoso: todos "nombre-apellido" perfecto
   - Slugs genéricos: "ceo-empresa", "cfo-banco", "director-comercial-fintech"
   - Slugs construidos a partir de nombre + apellido + empresa sin variación natural
   Los slugs VÁLIDOS son los publicIdentifier públicos de LinkedIn (ej: "antonio-feeney", "gustavo-barsola", "edmundo-miralles", "andres-salazar-oracle")

5. **Coherencia de contenido** — el reporte trata sobre la empresa correcta, las cuentas hacen sentido para ese ICP
   FAIL si una de las 6 cuentas target es la misma empresa mencionada como proof point/cliente del producto en el overview (inconsistencia: una empresa no puede ser cliente Y prospect a la vez)

6. **Personalización ICE** — cada card tiene ángulo único, nombre del decisor, pain específico. PROHIBIDO frases genéricas como "escalar tu operación", "mejorar la eficiencia"

7. **Sin datos rotos** — sin [INSERT], TODO, undefined, lorem ipsum, fechas incoherentes

8. **Proof points presentes** — al menos 1 ancla de credibilidad del cliente (ej: clientes conocidos, funding, métricas)

Respondé EXCLUSIVAMENTE con un JSON válido, sin markdown, sin texto extra, con esta forma:
{"veredicto":"APROBADO"|"RECHAZADO","score":<0-8>,"fixes":["fix concreto 1","fix concreto 2"]}

APROBADO solo si pasa los 8/8. Si RECHAZADO, "fixes" lista instrucciones concretas de corrección.`;

const SYSTEM_PROMPT_FIX = `Sos el generador del reporte GTM de IBT. Recibís un HTML existente y una lista de correcciones del juez. Aplicá las correcciones y devolvé SOLO el HTML completo corregido (<!DOCTYPE html> ... </html>), EXACTAMENTE 4 páginas A4 (ni más ni menos), footer incluido, mismo design system CommerceGlass v8. Sin explicaciones, sin markdown.

IMPORTANTE:
- Si el juez detectó slugs con IDs opacos (ACwAA...), DEBES llamar a get_contact_profile pasando ese ID para obtener el publicIdentifier público real y reemplazar la URL.
- Si el juez detectó páginas extra (5+), eliminá las páginas que no sean: 1 overview + 3 account cards = 4 páginas exactas.
- Si el juez detectó una cuenta que es proof point del cliente, reemplazala por otro perfil real de Sales Navigator usando el flujo resolve → search → get_contact_profile.
- NUNCA inventes slugs nuevos. Si no podés resolver con get_contact_profile, descartá el perfil y elegí otro.`;

// ---------------------------------------------------------------------------
// Llamadas a Claude
// ---------------------------------------------------------------------------
async function callClaude({ model, system, messages, tools = [], stopSequences = [], maxTokens = 16000 }) {
  const body = { model, max_tokens: maxTokens, system, messages };
  if (tools.length > 0) body.tools = tools;
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
  return data;
}

async function runClaude({ email, dominio, empresa, nombre, tools }) {
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const messages = [{
    role: 'user',
    content: `Generá el reporte GTM para este prospecto:\n- Nombre: ${nombre}\n- Empresa: ${empresa}\n- Email: ${email}\n- Dominio: ${dominio}\n\nSeguí el workflow completo del skill. Hacé el research, encontrá 6 cuentas con Sales Navigator (incluyendo get_contact_profile para obtener slugs públicos limpios) y devolvé SOLO el HTML con EXACTAMENTE 4 páginas.`
  }];

  let toolCallCount = 0;
  while (true) {
    const data = await callClaude({
      model: MODEL_GEN,
      system: SYSTEM_PROMPT_HTML,
      messages,
      tools: anthropicTools,
      stopSequences: ['</html>'],
      maxTokens: 16000
    });

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'stop_sequence' || data.stop_reason === 'end_turn') {
      console.log(`[GEN] Generación terminada. Total tool calls: ${toolCallCount}`);
      if (toolCallCount === 0) {
        console.warn(`[GEN] WARNING: Claude NO llamó a ninguna tool. Los datos pueden estar inventados.`);
      }
      return data.content.find(b => b.type === 'text')?.text;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
        toolCallCount++;
        const result = await callMCP(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }
}

async function runJudge(html, pageCount) {
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
  console.log(`[FIX] Aplicando ${fixes.length} fixes...`);
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const messages = [{
    role: 'user',
    content: `Empresa: ${empresa}\n\nCorrecciones a aplicar del juez:\n- ${fixes.join('\n- ')}\n\nHTML actual:\n${html}\n\nAplicá los fixes y devolvé SOLO el HTML completo corregido con EXACTAMENTE 4 páginas.`
  }];

  let toolCallCount = 0;
  while (true) {
    const data = await callClaude({
      model: MODEL_FIX,
      system: SYSTEM_PROMPT_FIX,
      messages,
      tools: anthropicTools,
      stopSequences: ['</html>'],
      maxTokens: 16000
    });

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'stop_sequence' || data.stop_reason === 'end_turn') {
      console.log(`[FIX] Terminado. Tool calls en fix: ${toolCallCount}`);
      return data.content.find(b => b.type === 'text')?.text;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
        toolCallCount++;
        const result = await callMCP(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }
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
// Pipeline en background con re-validación del juez
// ---------------------------------------------------------------------------
async function procesar(jobId, { email, dominio, empresa, nombre }) {
  try {
    console.log(`\n========== Job ${jobId} - Inicio ==========`);
    console.log(`Empresa: ${empresa} | Email: ${email} | Dominio: ${dominio}`);

    const tools = await listMCPTools();

    let html = await runClaude({ email, dominio, empresa, nombre, tools });
    let cleanHtml = limpiarHtml(html);
    if (!cleanHtml) throw new Error('Claude no devolvió HTML');

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
        pdfBuffer = await renderizarPdf(cleanHtml);
        pageCount = await contarPaginas(pdfBuffer);

        console.log(`[Job ${jobId}] Re-validando con el juez después de fixes...`);
        judgeResult = await runJudge(cleanHtml, pageCount);
      }
    }

    jobs.set(jobId, {
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa,
      nombre,
      email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
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
    const tools = await listMCPTools();
    let html = await runClaude({ email, dominio, empresa: empresa || dominio, nombre: nombre || '', tools });
    let cleanHtml = limpiarHtml(html);
    if (!cleanHtml) return res.status(500).json({ error: 'Claude no devolvió HTML' });

    let pdfBuffer = await renderizarPdf(cleanHtml);
    let pageCount = await contarPaginas(pdfBuffer);
    let judgeResult = await runJudge(cleanHtml, pageCount);

    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      const fixedHtml = await runFixer({ html: cleanHtml, fixes: judgeResult.fixes, empresa: empresa || dominio, tools });
      const cleanFixed = limpiarHtml(fixedHtml);
      if (cleanFixed) {
        cleanHtml = cleanFixed;
        pdfBuffer = await renderizarPdf(cleanHtml);
        pageCount = await contarPaginas(pdfBuffer);
        judgeResult = await runJudge(cleanHtml, pageCount);
      }
    }

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: empresa || dominio,
      nombre: nombre || '',
      email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, jobs_activos: jobs.size }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
