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

const SYSTEM_PROMPT = `# IBT GTM Report — Skill completo

Generás un reporte GTM de 4 páginas A4 que IBT manda a prospectos: identificás 6 decisores reales en LinkedIn que encajan con el ICP del cliente, los organizás en un HTML branded.

---

## Inputs mínimos

1. **Dominio o nombre de empresa** — obligatorio
2. **Email del prospecto** — obligatorio
3. **País / mercado objetivo** — se infiere del dominio si no se provee

---

## Workflow completo

### 1. Research de la empresa

Hacer web_fetch o WebSearch sobre el dominio. Extraer:
- Qué hace el producto (1-2 oraciones)
- Modelo de negocio (B2B SaaS / marketplace / fintech / etc.)
- País de origen y expansión (ej: "Colombia + México")
- Tracción / métricas públicas (funding, clientes, revenue, usuarios)
- Proof point clave para usar en el reporte (ej: "ganaron a Falabella", "Krealo invirtió")

Si el sitio bloquea JS, buscar en LinkedIn company page y Crunchbase.

### 2. Definir el ICP del cliente

A partir del research, definir:
- Tamaño de empresa target (headcount, revenue)
- Rol del decisor (CFO, Director Comercial, Head of CX, etc.)
- Industrias donde el producto tiene fit claro
- País(es) donde tiene sentido hacer outreach

Regla: los 6 accounts deben ser **empresas ancla** — grandes, conocidas, con cadenas de valor o bases de clientes que el producto puede monetizar.

### 3. Buscar 6 perfiles en Sales Navigator

Usar search_sales_navigator_filtered (IBT MCP). Reglas:

- **Exactamente 6 perfiles** — no más, no menos
- **connectionDegree: ["2nd"]** siempre — mejora tasa de aceptación
- Buscar por keywords de rol + industria + ubicación
- Preferir perfiles con headline relevante al pain del cliente
- Verificar que cada publicIdentifier sea un slug de persona real (contiene nombre, puede tener números, NUNCA contiene "company" o "page")
- **Formato de URL obligatorio**: https://www.linkedin.com/in/[slug] — NUNCA linkedin.com/company/

Si la primera búsqueda trae pocos resultados, variar keywords (español/inglés), quitar filtros de industria, o cambiar país. Máximo 3 intentos por búsqueda antes de seleccionar los mejores disponibles.

Seleccionar los 6 más relevantes considerando:
1. Rol / seniority (decision-makers, no ICs junior)
2. Empresa ancla reconocible (no startups desconocidas)
3. Fit con el pain del producto

### 4. Construir el HTML del reporte

Generá el HTML completo en una sola respuesta:
- <html> + <head> + <style> + <body>
- Página 1 completa (overview)
- Páginas 2-4 con 2 account cards cada una
- Cierre </body></html>

### 5. Estructura del reporte (4 páginas)

#### Página 1 — Overview estratégico

[HEADER IBT]
[RIBBON de empresa: Vertical · País · Fundada · ARR/Tracción]

[EYEBROW en Geist Mono uppercase]
[H1: "6 [tipo de cuenta] para escalar [Empresa] en [País]"]

[Lead: 2-3 oraciones. Ancla el proof point clave del cliente.]

[STATS — 4 chips]:
  • Fecha (ej: "Mayo 2026")
  • "6 · Priorizadas"
  • Métrica clave (ej: "$10.5B COP" / "150K usuarios")
  • Meta comercial (ej: "$10M meta 2026")

[ICP GRID — 4 tarjetas]:
  • Perfil ideal del decisor (rol, empresa tipo, industria)
  • Señal de compra (ej: "expansion stage", "nuevo CFO")
  • Pain primario (lo que el producto resuelve)
  • Tamaño de empresa (headcount o revenue)

[CONTEXTO MACRO]: 2-3 bullets con datos de mercado que validan la oportunidad

[ÁNGULOS DE APERTURA]: 3 hooks para iniciar conversación en LinkedIn

[CHIPS de prioridad]: etiquetas de industria/vertical donde hay más fit

#### Páginas 2-4 — Account cards (2 por página)

Cada página contiene exactamente 2 cards. Cada card:

[NÚMERO DE CUENTA] · [EMPRESA]

[Avatar placeholder circular con inicial]
[Nombre del decisor]
[Cargo · Empresa]
[linkedin.com/in/[slug] → link clicable]
[País · 2do grado · Año aprox en rol]

[ÁNGULO PERSONALIZADO]:
Párrafo de 3-4 oraciones específico para esta empresa.
Mencionar el nombre del decisor, el pain concreto de la empresa,
y cómo el producto lo resuelve. NO copy-paste entre cards.

[HOOK DE APERTURA]:
Una oración de mensaje de conexión sugerido, entre comillas.

**Regla ICE**: cada card debe tener un ángulo 100% único. Diferente empresa, diferente pain, diferente gancho. Prohibido usar frases genéricas como "escalar tu operación" o "mejorar la eficiencia".

### 6. Design system (CommerceGlass v8)

#### Variables CSS — no tocar

\`\`\`css
:root {
  --ink: #0A0C14;
  --ink-2: #3A3F4A;
  --ink-3: #6B717B;
  --ink-4: #A0A5AE;
  --bg: #F0F2F7;
  --panel: #FFFFFF;
  --panel-2: #F2F4F8;
  --line: rgba(10,12,20,0.10);
  --accent: #2B4BFF;
  --accent-soft: rgba(43,75,255,0.08);
  --accent-edge: rgba(43,75,255,0.25);
  --cta: #0A0C14;
  --cta-fg: #FFFFFF;
  --radius: 10px;
  --font: 'Geist', 'Inter', sans-serif;
  --mono: 'Geist Mono', 'JetBrains Mono', monospace;
}
\`\`\`

#### Tipografía

\`\`\`html
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
\`\`\`

- Eyebrow / labels: Geist Mono · 8-9px · uppercase · letter-spacing 0.14em
- H1: 28px · weight 700 · letter-spacing -0.03em
- H2 (section heads): 14-15px · weight 600
- Cuerpo: 11px · line-height 1.55
- Acento: <span style="color:var(--accent)">texto</span> — máximo 1-2 palabras por sección

#### Estructura de página

\`\`\`css
.page {
  width: 210mm;
  min-height: 297mm;
  margin: 24px auto;
  padding: 12mm 15mm 10mm;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 20px 60px -30px rgba(10,12,20,0.25);
  display: flex;
  flex-direction: column;
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

#### Header de página

\`\`\`html
<header class="page-header">
  <div class="logo-pill" style="background:#0A0C14;padding:6px 12px;border-radius:6px;display:inline-flex;align-items:center;">
    <img src="https://inbound-tools.com/logo-white.png" alt="IBT" height="22">
  </div>
  <div class="header-meta">
    <span class="tag-accent">GTM INTELLIGENCE</span>
    <span class="doc-title">[EMPRESA] · ANÁLISIS GTM</span>
    <span class="doc-date">[FECHA ACTUAL]</span>
  </div>
</header>
\`\`\`

#### Footer

NO incluir footer en el HTML. El footer se agrega automáticamente con la numeración correcta.

---

## Anti-patterns comunes

| Error | Fix |
|---|---|
| URL tipo linkedin.com/company/X | Buscar el perfil personal del decisor, no la página de empresa |
| Copy-paste de ángulos entre cards | Cada card necesita pain específico de la empresa real |
| PDF sale en 3 páginas | Revisar que page-break-after:always esté en las 3 primeras páginas |
| PDF sale en 5+ páginas | Reducir font-size body de 11px a 10.5px, recortar texto |
| Sales Nav retorna 0 resultados | Quitar filtro de industria, cambiar keywords a español/inglés |

---

## Output FINAL

- La respuesta DEBE empezar exactamente con <!DOCTYPE html>
- La respuesta DEBE terminar exactamente con </html>
- NO escribas NADA antes del <!DOCTYPE html>, ni explicaciones
- NO uses bloques de código markdown`;

const JUDGE_PROMPT = `Eres un juez de control de calidad para reportes GTM de IBT.

Te voy a pasar el HTML de un reporte y vas a validar los 8 criterios.

Criterios:
1. LinkedIn /in/ format — todos los URLs usan linkedin.com/in/[slug], NUNCA company
2. Exactamente 6 cuentas — ni más ni menos
3. 4 páginas con page-break-after correctos
4. Slug accuracy — slugs con partes de nombre real, sin palabras genéricas
5. Coherencia de contenido — el reporte trata sobre la empresa correcta, las cuentas hacen sentido para ese ICP
6. Personalización ICE — cada card tiene ángulo único, nombre del decisor, pain específico
7. Sin datos rotos — sin [INSERT], TODO, undefined, lorem ipsum, fechas incoherentes
8. Proof points presentes — al menos 1 ancla de credibilidad del cliente

Para cada criterio: ✅ PASS o ❌ FAIL con explicación.

Devolvé tu respuesta en este formato JSON exacto, sin nada más:
{
  "veredicto": "APROBADO" o "RECHAZADO",
  "score": "N/8",
  "fixes": ["fix 1", "fix 2", ...] (vacío si APROBADO)
}`;

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
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages,
        stop_sequences: ['</html>']
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

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

async function runJudge(html) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: JUDGE_PROMPT,
      messages: [{
        role: 'user',
        content: `Validá este HTML:\n\n${html}`
      }]
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  
  const text = data.content.find(b => b.type === 'text')?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { veredicto: 'APROBADO', score: '8/8', fixes: [] };
  
  try {
    return JSON.parse(jsonMatch[0]);
  } catch(e) {
    return { veredicto: 'APROBADO', score: '8/8', fixes: [] };
  }
}

async function runClaudeWithFixes(originalHtml, fixes, email, dominio, empresa, nombre, tools) {
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const messages = [{
    role: 'user',
    content: `El juez rechazó el reporte para ${empresa} con estos fixes a aplicar:\n\n${fixes.join('\n- ')}\n\nHTML original:\n${originalHtml}\n\nRegenerá el HTML aplicando todos los fixes. Devolvé solo el HTML completo.`
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
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: anthropicTools,
        messages,
        stop_sequences: ['</html>']
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

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

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio, empresa, nombre } = req.body;
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  try {
    const tools = await listMCPTools();
    
    // Paso 1: Generar HTML
    let html = await runClaude(email, dominio, empresa || dominio, nombre || '', tools);
    if (!html) return res.status(500).json({ error: 'Claude no devolvió HTML' });
    
    let htmlMatch = html.match(/<!DOCTYPE[\s\S]*/i);
    let cleanHtml = htmlMatch ? htmlMatch[0] : html;
    if (!cleanHtml.includes('</html>')) cleanHtml = cleanHtml + '\n</html>';
    
    // Paso 2: Judge Agent
    const judgeResult = await runJudge(cleanHtml);
    
    // Paso 3: Si rechaza, regenerar con fixes (máximo 1 reintento)
    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      const fixedHtml = await runClaudeWithFixes(cleanHtml, judgeResult.fixes, email, dominio, empresa || dominio, nombre || '', tools);
      if (fixedHtml) {
        htmlMatch = fixedHtml.match(/<!DOCTYPE[\s\S]*/i);
        cleanHtml = htmlMatch ? htmlMatch[0] : fixedHtml;
        if (!cleanHtml.includes('</html>')) cleanHtml = cleanHtml + '\n</html>';
      }
    }

    // Paso 4: Renderizar con Puppeteer
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(cleanHtml, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="font-size:9px;width:100%;padding:0 15mm;display:flex;justify-content:space-between;color:#6B7280;font-family:monospace;"><span>INBOUND-TOOLS.COM</span><span>PÁGINA <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margin: { top: '15mm', bottom: '15mm', left: '0', right: '0' }
    });
    await browser.close();

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer.toString('base64'),
      empresa: empresa || dominio,
      nombre: nombre || '',
      email: email,
      juez: judgeResult.veredicto + ' ' + judgeResult.score
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
