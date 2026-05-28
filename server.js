const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const MCP_URL = 'https://backoffice-server-production.up.railway.app/api/mcp';
const IBT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'x-email': process.env.IBT_EMAIL,
  'x-password': process.env.IBT_PASSWORD
};

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

const SYSTEM_PROMPT = `Sos un agente que genera reportes GTM en PDF para Inbound Tools.

Workflow completo:
1. Research del dominio usando las tools disponibles
2. Definir ICP del cliente
3. Buscar 6 perfiles reales en Sales Navigator via search_sales_navigator_filtered
4. Construir HTML del reporte completo

Design system CommerceGlass v8:
- Variables: --ink:#0A0C14, --accent:#2B4BFF, --bg:#F0F2F7, --panel:#FFFFFF
- Fuente: Geist/Inter, Geist Mono (Google Fonts)
- Página: 210mm x 297mm, padding 12mm 15mm 10mm
- Header: logo IBT + GTM INTELLIGENCE + empresa + fecha
- Footer: INBOUND-TOOLS.COM + PAGINA N/4

Estructura 4 páginas:
- Pág 1: Overview estratégico (ribbon empresa, H1, stats, ICP grid, contexto macro, ángulos apertura)
- Págs 2-4: 2 account cards por página (decisor, cargo, URL linkedin.com/in/slug, ángulo personalizado, hook apertura)

Output FINAL: devolvé SOLO el HTML completo listo para renderizar. Sin markdown, sin explicaciones, sin bloques de código.`;

async function runClaude(email, dominio, tools) {
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const messages = [{
    role: 'user',
    content: `Generá el reporte HTML para:\n- Email: ${email}\n- Dominio: ${dominio}\n\nDevolvé solo el HTML.`
  }];

  while (true) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn') {
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

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio } = req.body;
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  try {
    const tools = await listMCPTools();
    const html = await runClaude(email, dominio, tools);
    if (!html) return res.status(500).json({ error: 'Claude no devolvió HTML' });

    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: dominio,
      email: email
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
