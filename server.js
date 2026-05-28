const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const SKILL_SYSTEM_PROMPT = `Sos un agente que genera reportes GTM en PDF para Inbound Tools.

Workflow completo:
1. Research del dominio (web_search + web_fetch)
2. Definir ICP del cliente
3. Buscar 6 perfiles reales en Sales Navigator via IBT MCP (search_sales_navigator_filtered)
4. Construir HTML del reporte en 4 partes usando Bash heredoc
5. Renderizar PDF con WeasyPrint
6. Verificar exactamente 4 páginas con fitz
7. Validar 8 criterios (Judge Agent)
8. Devolver JSON con pdf_url

Design system CommerceGlass v8:
- Variables: --ink:#0A0C14, --accent:#2B4BFF, --bg:#F0F2F7, --panel:#FFFFFF
- Fuente: Geist/Inter, Geist Mono
- Página: 210mm x 297mm, padding 12mm 15mm 10mm
- Header: logo IBT + GTM INTELLIGENCE + empresa + fecha
- Footer: INBOUND-TOOLS.COM + PAGINA N/4

Estructura 4 páginas:
- Pág 1: Overview estratégico (ribbon empresa, H1, stats, ICP grid, contexto macro, ángulos apertura)
- Págs 2-4: 2 account cards por página (decisor, cargo, URL linkedin.com/in/slug, ángulo personalizado, hook apertura)

Output FINAL obligatorio (solo este JSON, nada más):
{
  "status": "ok",
  "pdf_url": "URL_DEL_PDF",
  "empresa": "NOMBRE_EMPRESA",
  "email": "EMAIL_PROSPECTO",
  "juez": "APROBADO 8/8"
}`;

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio } = req.body;

  if (!email || !dominio) {
    return res.status(400).json({ error: 'email y dominio son obligatorios' });
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      mcp_servers: [
        {
          type: 'url',
          url: 'https://backoffice-server-production.up.railway.app/api/mcp',
          name: 'ibt-mcp',
          tool_configuration: {
            enabled: true
          }
        }
      ],
      system: SKILL_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Generá el reporte PDF para el prospecto:\n- Email: ${email}\n- Dominio: ${dominio}\n\nDevolvé solo el JSON final con pdf_url.`
        }
      ]
    });

    // Extraer el JSON de la respuesta
    const text = response.content.find(b => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*"pdf_url"[\s\S]*\}/);
    
    if (!jsonMatch) {
      return res.status(500).json({ error: 'No se pudo extraer pdf_url de la respuesta', raw: text });
    }

    const result = JSON.parse(jsonMatch[0]);
    return res.json(result);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
