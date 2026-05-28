/**
 * IBT GTM Report — server.js (versión híbrida final)
 *
 * Mantiene el skill de Mario tal cual (prompts, design system, 2 agentes: juez + fixer).
 * Diferencias INTENCIONALES respecto del skill:
 *   - Render con Puppeteer (no WeasyPrint, no aplica en Node)
 *   - NO crea el draft de Gmail (lo hace n8n)
 *   - Arquitectura asíncrona (job + polling) para no chocar el timeout de Railway
 *   - MCP de IBT con fetch directo + x-email/x-password (la API de Anthropic NO acepta esos headers en mcp_servers)
 *
 * Dependencias: npm i express puppeteer pdf-lib
 *
 * Env vars (configurar en Railway):
 *   ANTHROPIC_API_KEY
 *   IBT_EMAIL
 *   IBT_PASSWORD
 *   PORT (lo inyecta Railway)
 */

const express = require('express');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const MODEL_GEN = 'claude-sonnet-4-6';     // generación: fiel al skill original claude-opus-4-7
const MODEL_JUDGE = 'claude-sonnet-4-6'; // juez: más rápido y barato
const MODEL_FIX = 'claude-opus-4-7';     // fixer: misma calidad que el generador

const MCP_URL = 'https://backoffice-server-production.up.railway.app/api/mcp';
const IBT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'x-email': process.env.IBT_EMAIL,
  'x-password': process.env.IBT_PASSWORD
};

// ---------------------------------------------------------------------------
// MCP IBT (fetch directo con headers x-email + x-password)
// ---------------------------------------------------------------------------
async function callMCP(toolName, args) {
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
  if (!match) throw new Error('No se pudo parsear respuesta MCP');
  const parsed = JSON.parse(match[1]);
  return parsed?.result?.content?.[0]?.text || JSON.stringify(parsed?.result);
}

async function listMCPTools() {
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
  return parsed?.result?.tools || [];
}

// ---------------------------------------------------------------------------
// PROMPTS — fieles al skill ibt-gtm-report
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT_HTML = `# IBT GTM Report — Skill completo

Generás un reporte GTM de 4 páginas A4 que IBT manda a prospectos: identificás 6 decisores reales en LinkedIn que encajan con el ICP del cliente, los organizás en un HTML branded. El PDF se renderiza después con Puppeteer.

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

### 3. Buscar 6 perfiles en Sales Navigator
Usar search_sales_navigator_filtered. Reglas:
- EXACTAMENTE 6 perfiles — no más, no menos
- connectionDegree: ["2nd"] siempre
- Buscar por keywords de rol + industria + ubicación
- Verificar que cada publicIdentifier sea slug de persona real (NUNCA "company" o "page")
- Formato de URL OBLIGATORIO: https://www.linkedin.com/in/[slug] — NUNCA linkedin.com/company/

Si la primera búsqueda trae pocos resultados, variar keywords (español/inglés), quitar filtros de industria, o cambiar país. Máximo 3 intentos.

Seleccionar los 6 más relevantes considerando:
1. Rol / seniority (decision-makers, no ICs junior)
2. Empresa ancla reconocible (no startups desconocidas)
3. Fit con el pain del producto

### 4. Estructura del reporte (4 páginas)

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
[linkedin.com/in/[slug] → link clicable] + [País · 2do grado · Año en rol]
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
- Copy-paste de ángulos entre cards → cada card con pain específico
- PDF en 3 páginas → revisar page-break-after en las 3 primeras
- PDF en 5+ páginas → reducir font-size del cuerpo a 10.5px, recortar texto
- Sales Nav 0 resultados → quitar filtro industria, cambiar keywords ES/EN
- Datos rotos: nada de [INSERT], TODO, undefined, lorem ipsum

---

## Output FINAL
- La respuesta DEBE empezar exactamente con <!DOCTYPE html>
- La respuesta DEBE terminar exactamente con </html>
- NO escribas NADA antes del <!DOCTYPE html>, ni explicaciones, ni "Let me"
- NO uses bloques de código markdown`;

const SYSTEM_PROMPT_JUDGE = `Sos un juez de control de calidad para reportes GTM de IBT.

Recibís el HTML del reporte + el número de páginas del PDF ya renderizado. Validás los 8 criterios y retornás un JSON.

Criterios:
1. LinkedIn /in/ format — todos los URLs usan linkedin.com/in/[slug], NUNCA company
2. Exactamente 6 cuentas — ni más ni menos
3. 4 páginas PDF — usá el conteo provisto en el mensaje
4. Slug accuracy — slugs con partes de nombre real, sin palabras genéricas
5. Coherencia de contenido — el reporte trata sobre la empresa correcta, las cuentas hacen sentido para ese ICP
6. Personalización ICE — cada card tiene ángulo único, nombre del decisor, pain específico
7. Sin datos rotos — sin [INSERT], TODO, undefined, lorem ipsum, fechas incoherentes
8. Proof points presentes — al menos 1 ancla de credibilidad del cliente

Respondé EXCLUSIVAMENTE con un JSON válido, sin markdown, sin texto extra, con esta forma:
{"veredicto":"APROBADO"|"RECHAZADO","score":<0-8>,"fixes":["fix concreto 1","fix concreto 2"]}

APROBADO solo si pasa los 8/8. Si RECHAZADO, "fixes" lista instrucciones concretas de corrección.`;

const SYSTEM_PROMPT_FIX = `Sos el generador del reporte GTM de IBT. Recibís un HTML existente y una lista de correcciones del juez. Aplicá las correcciones y devolvé SOLO el HTML completo corregido (<!DOCTYPE html> ... </html>), 4 páginas A4, footer incluido, mismo design system CommerceGlass v8. Sin explicaciones, sin markdown.`;

// ---------------------------------------------------------------------------
// Llamadas a Claude (con MCP IBT via fetch directo)
// ---------------------------------------------------------------------------
async function callClaude({ model, system, messages, tools = [], stopSequences = [], maxTokens = 16000 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages
  };
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
    content: `Generá el reporte GTM para este prospecto:\n- Nombre: ${nombre}\n- Empresa: ${empresa}\n- Email: ${email}\n- Dominio: ${dominio}\n\nSeguí el workflow completo del skill. Hacé el research, encontrá 6 cuentas con Sales Navigator y devolvé SOLO el HTML.`
  }];

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
      return data.content.find(b => b.type === 'text')?.text;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
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

// AGENTE 1: Judge — segunda llamada a la API con prompt distinto
async function runJudge(html, pageCount) {
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
    return {
      veredicto: parsed.veredicto || 'APROBADO',
      score: parsed.score ?? 0,
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes : []
    };
  } catch (e) {
    console.error('No se pudo parsear el juez, aprobando por defecto:', e.message);
    return { veredicto: 'APROBADO', score: 0, fixes: [] };
  }
}

// AGENTE 2: Fixer — tercera llamada con los fixes del juez
async function runFixer({ html, fixes, empresa, tools }) {
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const messages = [{
    role: 'user',
    content: `Empresa: ${empresa}\n\nCorrecciones a aplicar del juez:\n- ${fixes.join('\n- ')}\n\nHTML actual:\n${html}\n\nAplicá los fixes y devolvé SOLO el HTML completo corregido.`
  }];

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
      return data.content.find(b => b.type === 'text')?.text;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
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
// HTML -> PDF (Puppeteer, fiel al @page del skill)
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
    // Footer va dentro del HTML (como el skill) — sin displayHeaderFooter
    // preferCSSPageSize + márgenes 0 respetan @page { size: A4; margin: 0 }
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
// Pipeline en background (skill completo + 2 agentes)
// ---------------------------------------------------------------------------
async function procesar(jobId, { email, dominio, empresa, nombre }) {
  try {
    const tools = await listMCPTools();

    // Paso 1-4 del skill: research + ICP + Sales Navigator + HTML
    let html = await runClaude({ email, dominio, empresa, nombre, tools });
    let cleanHtml = limpiarHtml(html);
    if (!cleanHtml) throw new Error('Claude no devolvió HTML');

    // Render + conteo de páginas
    let pdfBuffer = await renderizarPdf(cleanHtml);
    let pageCount = await contarPaginas(pdfBuffer);

    // AGENTE 1: Juez (8 criterios, incluye conteo de páginas)
    const judgeResult = await runJudge(cleanHtml, pageCount);

    // AGENTE 2: Si rechaza, regenerar con fixes (máximo 1 reintento) y re-renderizar
    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      console.log(`Job ${jobId}: juez RECHAZADO ${judgeResult.score}/8, aplicando fixes...`);
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
      finishedAt: Date.now()
    });
    console.log(`Job ${jobId}: OK, ${pageCount} páginas, juez ${judgeResult.veredicto} ${judgeResult.score}/8`);
  } catch (err) {
    console.error('Error en job', jobId, err);
    jobs.set(jobId, { status: 'error', error: err.message, finishedAt: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Servidor HTTP (async: job + polling, para n8n)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

const jobs = new Map(); // ⚠️ en memoria: si reiniciás el container se pierden

// Cleanup de jobs viejos (cada 30 min, borra los de más de 1h)
setInterval(() => {
  const limite = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if ((job.finishedAt || job.createdAt || 0) < limite) jobs.delete(id);
  }
}, 30 * 60 * 1000);

// Endpoint async: crea el job y devuelve jobId
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

// Endpoint polling: consulta el estado del job
app.get('/resultado/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
  res.json(job);
});

// Endpoint legacy compatible con el flujo viejo (sincrónico - puede timeout)
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
    const judgeResult = await runJudge(cleanHtml, pageCount);

    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      const fixedHtml = await runFixer({ html: cleanHtml, fixes: judgeResult.fixes, empresa: empresa || dominio, tools });
      const cleanFixed = limpiarHtml(fixedHtml);
      if (cleanFixed) {
        cleanHtml = cleanFixed;
        pdfBuffer = await renderizarPdf(cleanHtml);
        pageCount = await contarPaginas(pdfBuffer);
      }
    }

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: empresa || dominio,
      nombre: nombre || '',
      email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, jobs_activos: jobs.size }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
