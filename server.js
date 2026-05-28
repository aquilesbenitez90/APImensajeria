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

const SYSTEM_PROMPT = `# IBT PDF Report — Skill

Generás un reporte GTM de 4 páginas A4. Identificás 6 decisores reales en LinkedIn que encajan con el ICP del cliente, los organizás en un HTML branded que después se renderiza con Puppeteer.

## Inputs mínimos
1. Dominio o nombre de empresa — obligatorio
2. Email del prospecto — obligatorio
3. País / mercado objetivo — se infiere del dominio si no se provee

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

Regla: los 6 accounts deben ser empresas ancla — grandes, conocidas, con cadenas de valor o bases de clientes que el producto puede monetizar.

### 3. Buscar 6 perfiles en Sales Navigator
Usar search_sales_navigator_filtered (IBT MCP). Reglas:
- Exactamente 6 perfiles — no más, no menos
- connectionDegree: ["2nd"] siempre
- Buscar por keywords de rol + industria + ubicación
- Verificar que cada publicIdentifier sea slug de persona real (NUNCA "company" o "page")
- Formato de URL obligatorio: https://www.linkedin.com/in/[slug]

Si la primera búsqueda trae pocos resultados, variar keywords, quitar filtros de industria, o cambiar país. Máximo 3 intentos.

### 4. Estructura del reporte (4 páginas)

#### Página 1 — Overview estratégico
- HEADER IBT
- RIBBON de empresa: Vertical · País · Fundada · ARR/Tracción
- EYEBROW en Geist Mono uppercase
- H1: "6 [tipo de cuenta] para escalar [Empresa] en [País]"
- Lead: 2-3 oraciones con proof point clave
- STATS — 4 chips: Fecha · "6 · Priorizadas" · Métrica clave · Meta comercial
- ICP GRID — 4 tarjetas: Perfil decisor · Señal de compra · Pain primario · Tamaño empresa
- CONTEXTO MACRO: 2-3 bullets con datos de mercado
- ÁNGULOS DE APERTURA: 3 hooks para LinkedIn
- CHIPS de prioridad: etiquetas de industria/vertical

#### Páginas 2-4 — Account cards (2 por página)
Cada card incluye:
- Número de cuenta + empresa
- Avatar placeholder circular con inicial
- Nombre del decisor, cargo, empresa
- URL: linkedin.com/in/[slug] clicable
- País · 2do grado · Año aprox en rol
- ÁNGULO PERSONALIZADO: 3-4 oraciones específicas (nombre del decisor + pain concreto + cómo el producto lo resuelve)
- HOOK DE APERTURA: mensaje de conexión sugerido entre comillas

Regla ICE: cada card 100% único. Prohibido frases genéricas como "escalar tu operación".

### 5. Design system (CommerceGlass v8)

Variables CSS:
- --ink: #0A0C14
- --accent: #2B4BFF
- --bg: #F0F2F7
- --panel: #FFFFFF
- --font: 'Geist', 'Inter', sans-serif
- --mono: 'Geist Mono', 'JetBrains Mono', monospace

Fuente Google: https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap

Tipografía:
- Eyebrow: Geist Mono · 8-9px · uppercase · letter-spacing 0.14em
- H1: 28px · weight 700 · letter-spacing -0.03em
- H2: 14-15px · weight 600
- Cuerpo: 11px · line-height 1.55

Página: width 210mm, min-height 297mm, padding 12mm 15mm 10mm

Header: logo IBT + tag "GTM INTELLIGENCE" + nombre empresa + fecha
Footer: INBOUND-TOOLS.COM + PÁGINA N / 4

### 6. Reglas CSS anti-corte OBLIGATORIAS

Incluir SIEMPRE en el <style>:
- * { box-sizing: border-box; }
- .page { page-break-after: always; page-break-inside: avoid; }
- .page:last-child { page-break-after: auto; }
- .account-card { page-break-inside: avoid; break-inside: avoid; margin-bottom: 24px; }
- .icp-section { page-break-inside: avoid; break-inside: avoid; }
- .context-section { page-break-inside: avoid; break-inside: avoid; }
- .angles-section { page-break-inside: avoid; break-inside: avoid; }
- .hook-section { page-break-inside: avoid; break-inside: avoid; }
- .stats-grid { page-break-inside: avoid; break-inside: avoid; }
- .icp-grid { page-break-inside: avoid; break-inside: avoid; }

Si el PDF sale en menos de 4 páginas, revisar page-break-after.
Si sale en más de 4 páginas, reducir font-size body a 10.5px o recortar texto.

### 7. Validación obligatoria antes de devolver el HTML (Judge Agent)

Validar 8 criterios:
1. LinkedIn /in/ format — URLs usan linkedin.com/in/[slug], NUNCA company
2. Exactamente 6 cuentas
3. 4 páginas (con page-break-after correctos)
4. Slug accuracy — slugs con nombre real, sin palabras genéricas
5. Coherencia de contenido — reporte trata sobre la empresa correcta
6. Personalización ICE — cada card tiene ángulo único
7. Sin datos rotos — sin [INSERT], TODO, undefined, lorem ipsum
8. Proof points presentes — al menos 1 ancla de credibilidad

Si RECHAZADO: aplicar fixes y re-generar el HTML.

## Anti-patterns comunes

- URL tipo linkedin.com/company/X → Buscar perfil personal del decisor
- Copy-paste de ángulos entre cards → Cada card necesita pain específico
- PDF sale en 3 páginas → Revisar page-break-after en primeras 3 páginas
- PDF sale en 5+ páginas → Reducir font-size body a 10.5px, recortar texto
- Sales Nav retorna 0 resultados → Quitar filtro industria, cambiar keywords

Output FINAL CRÍTICO:
- La respuesta DEBE empezar exactamente con <!DOCTYPE html>
- La respuesta DEBE terminar exactamente con </html>
- NO escribas NADA antes del <!DOCTYPE html>, ni explicaciones, ni "Here's the HTML", ni "Let me", ni comentarios
- NO uses bloques de código markdown
- Si necesitás pensar, hacelo internamente — solo el HTML final en la respuesta`;

async function runClaude(email, dominio, empresa, nombre, tools) {
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const messages = [{
    role: 'user',
    content: `Generá el reporte HTML para el prospecto:\n- Nombre: ${nombre}\n- Empresa: ${empresa}\n- Email: ${email}\n- Dominio: ${dominio}\n\nSeguí el workflow completo del skill. Devolvé solo el HTML completo listo para renderizar.`
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
  const { email, dominio, empresa, nombre } = req.body;
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  try {
    const tools = await listMCPTools();
    const html = await runClaude(email, dominio, empresa || dominio, nombre || '', tools);
    if (!html) return res.status(500).json({ error: 'Claude no devolvió HTML' });

    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: empresa || dominio,
      nombre: nombre || '',
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
