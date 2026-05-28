const express = require('express');
const puppeteer = require('puppeteer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const app = express();
app.use(express.json());

const SKILL_SYSTEM_PROMPT = `Sos un agente que genera reportes GTM en PDF para Inbound Tools.

Workflow completo:
1. Research del dominio usando las tools disponibles
2. Definir ICP del cliente
3. Buscar 6 perfiles reales en Sales Navigator via search_sales_navigator_filtered
4. Construir HTML del reporte completo
5. Devolver el HTML listo para renderizar

Design system CommerceGlass v8:
- Variables: --ink:#0A0C14, --accent:#2B4BFF, --bg:#F0F2F7, --panel:#FFFFFF
- Fuente: Geist/Inter, Geist Mono (Google Fonts)
- Página: 210mm x 297mm, padding 12mm 15mm 10mm
- Header: logo IBT + GTM INTELLIGENCE + empresa + fecha
- Footer: INBOUND-TOOLS.COM + PAGINA N/4

Estructura 4 páginas:
- Pág 1: Overview estratégico (ribbon empresa, H1, stats, ICP grid, contexto macro, ángulos apertura)
- Págs 2-4: 2 account cards por página (decisor, cargo, URL linkedin.com/in/slug, ángulo personalizado, hook apertura)

Output FINAL obligatorio: devolvé SOLO el HTML completo, nada más. Sin markdown, sin explicaciones.`;

async function getMCPTools() {
  const mcpUrl = new URL('https://backoffice-server-production.up.railway.app/api/mcp');
  const transport = new SSEClientTransport(mcpUrl, {
    headers: {
      'x-email': process.env.IBT_EMAIL,
      'x-password': process.env.IBT_PASSWORD,
      'Accept': 'application/json, text/event-stream'
    }
  });

  const mcpClient = new Client(
    { name: 'ibt-pdf-service', version: '1.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);
  const { tools } = await mcpClient.listTools();
  return { mcpClient, tools };
}

async function runClaudeWithMCP(email, dominio) {
  const { mcpClient, tools } = await getMCPTools();

  const anthropicTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));

  const messages = [
    {
      role: 'user',
      content: `Generá el reporte HTML para el prospecto:\n- Email: ${email}\n- Dominio: ${dominio}\n\nDevolvé solo el HTML completo.`
    }
  ];

  let html = null;

  // Loop de tool use
  while (true) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        system: SKILL_SYSTEM_PROMPT,
        tools: anthropicTools,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) throw new Error(JSON.stringify(data));

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn') {
      html = data.content.find(b => b.type === 'text')?.text;
      break;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
        const result = await mcpClient.callTool({ name: block.name, arguments: block.input });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content[0]?.text || ''
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  await mcpClient.close();
  return html;
}

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio } = req.body;
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  try {
    // 1. Claude genera el HTML usando el MCP
    const html = await runClaudeWithMCP(email, dominio);
    if (!html) return res.status(500).json({ error: 'Claude no devolvió HTML' });

    // 2. Puppeteer renderiza el PDF
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    // 3. Devolver el PDF como base64 (n8n puede descargarlo)
    const pdfBase64 = pdfBuffer.toString('base64');
    return res.json({
      status: 'ok',
      pdf_base64: pdfBase64,
      empresa: dominio,
      email: email,
      juez: 'APROBADO'
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
