/**
 * IBT GTM Report — server.js v7.4
 *
 * Sobre v7.3 suma (3 arreglos de robustez bajo concurrencia + veracidad geográfica):
 *   - IDEMPOTENCIA en /generar: dedup por lead (profileId/dominio/email/empresa). Si ya hay
 *     un job en curso para ese lead, devuelve el MISMO jobId (deduplicado:true) en vez de
 *     arrancar otro. Mata los reportes duplicados y el doble-envío / costo x2-x5.
 *   - ESTADO DE TOKENS POR REQUEST (AsyncLocalStorage): se eliminan las globales mutables
 *     tokenStats/stageStats/currentStage que se corrompían cuando dos jobs corrían en paralelo
 *     en la misma réplica. Ahora cada job tiene su propio acumulador aislado.
 *   - GEO-COHERENCIA determinística: antes del veredicto final se chequea que el país de cada
 *     card coincida con el país del título (h1_post) y del ICP "Geografía". Si una card está en
 *     un país distinto al que dice apuntar el reporte (caso Apodemia "México/Guatemala" con
 *     targets en Barcelona), se fuerza RECHAZADO. Cierra el punto ciego del juez.
 *
 * Sobre v7.2 suma (todo apuntado a la credibilidad del lead, que es el corazón del producto):
 *   - GEOGRAFÍA: el país del cliente MANDA. sourceCandidates prioriza fuerte a los candidatos
 *     del país del cliente (en el enriquecido y en la selección final); los de otros países de
 *     LatAm solo rellenan. El PLAN solo lista países donde el cliente HOY puede prestar servicio.
 *   - ANTI-INVENCIÓN: SELECT no puede inflar/cambiar el cargo ni inventar estudios/seniority;
 *     PLAN no puede inventar métricas (tiempos, %, cantidades) en lead/proof/context/apertura/stats.
 *   - ÁNGULOS cortos (máx 2 oraciones) -> entran 3 cards en 1 hoja y se va el boilerplate.
 *   - HOOKS con fórmula distinta entre sí (pain concreto por persona).
 *   - LARGO acotado de lead/proof/context para que el overview entre en 1 página.
 *   - Juez: el src del logo puede venir como "[LOGO]" (redacción interna), NO es error.
 *
 * v7.2: NUM_CUENTAS=3 configurable, dedup por empresa, título "N clientes potenciales para [Cliente]",
 *       español neutro, geografias LatAm, EXPECTED_PAGES configurable, fix del "?".
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

// Cantidad de cuentas del reporte. Configurable por env.
const NUM_CUENTAS = parseInt(process.env.NUM_CUENTAS || '3', 10);
// Cuántas le pedimos a la IA: sobre-generamos para tener margen tras dedupe (persona + empresa).
const PEDIR_SELECT = NUM_CUENTAS + 3;
// Páginas esperadas del PDF para el juez. 0 = NO validar páginas. Seteá EXPECTED_PAGES=2 cuando confirmes.
const EXPECTED_PAGES = parseInt(process.env.EXPECTED_PAGES || '0', 10);

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

// Acumulador de tokens POR REQUEST (aislado por job con AsyncLocalStorage).
// Antes eran globales mutables (tokenStats/stageStats/currentStage) que se corrompían
// cuando dos jobs corrían en paralelo en la misma réplica. Ahora cada job tiene el suyo.
const { AsyncLocalStorage } = require('async_hooks');
const _statsALS = new AsyncLocalStorage();

function _nuevoStats() {
  return {
    currentStage: 'gen',
    total:  { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    stages: {
      gen:   { input: 0, output: 0, cache_write: 0, cache_read: 0 },
      judge: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
      fix:   { input: 0, output: 0, cache_write: 0, cache_read: 0 }
    }
  };
}
// Store del request actual. Si por algún motivo se llama fuera de un job (no debería),
// devuelve uno efímero para no romper el conteo.
function _stats()     { return _statsALS.getStore() || _nuevoStats(); }
function _setStage(s) { const st = _statsALS.getStore(); if (st) st.currentStage = s; }

function costoDe({ input, output, cache_write, cache_read }) {
  return (input * 3 + output * 15 + cache_write * 3.75 + cache_read * 0.30) / 1e6;
}

function logTokenCost(label) {
  const st = _stats();
  const total = costoDe(st.total);
  console.log(`[TOKENS] ${label} | in:${st.total.input} out:${st.total.output} cache_w:${st.total.cache_write} cache_r:${st.total.cache_read} | ~$${total.toFixed(4)} (Sonnet)`);
  for (const etapa of ['gen', 'judge', 'fix']) {
    const s = st.stages[etapa];
    const c = costoDe(s);
    if (s.input || s.output || s.cache_read || s.cache_write) {
      console.log(`[TOKENS]   └─ ${etapa.padEnd(5)} | in:${s.input} out:${s.output} cache_w:${s.cache_write} cache_r:${s.cache_read} | ~$${c.toFixed(4)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Conteo y log REAL de web_search
// ---------------------------------------------------------------------------
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
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 })
  });
  const text = await res.text();
  const match = text.match(/data: ({.*})\n\n/);
  if (!match) throw new Error('No se pudo listar tools');
  const parsed = JSON.parse(match[1]);
  const toolList = parsed?.result?.tools || [];
  console.log(`[MCP] ${toolList.length} tools disponibles`);
  return toolList;
}

// PROMPT viejo de generación directa: eliminado (el pipeline usa 3 fases).

// ===========================================================================
// JUEZ de calidad
// ===========================================================================
const SYSTEM_PROMPT_JUDGE = `Sos un juez de control de calidad EXTREMADAMENTE ESTRICTO para reportes de análisis de mercado de IBT.

Recibís el HTML del reporte + datos del PDF ya renderizado. Validás los 8 criterios y retornás un JSON.

Tu objetivo: detectar reportes con DATOS INVENTADOS o INCONSISTENCIAS. Sé paranoico. En duda → FAIL.

QUÉ ES REAL Y QUÉ ESCRIBE LA IA (importante para no marcar falsos positivos):
- Los datos DUROS de cada card —nombre, cargo, empresa, ubicación, grado de conexión y el link de LinkedIn (member id opaco ACwAA... o slug)— vienen de una búsqueda REAL en Sales Navigator. NO los inventa la IA. Confiá en ellos: NO los marques como "inventados", "rotos" ni "sospechosos" solo por su forma. En particular: (a) un href con id opaco ACwAA... ES un link válido; (b) que el grado de conexión sea el mismo en varias cards (ej. todas "2do grado") es dato REAL.
- Lo que SÍ escribe la IA y tenés que auditar por invención/genericidad: el ÁNGULO y el HOOK de cada card, y TODO el contenido de la página 1 (overview, stats, contexto, proof). Ahí enfocá la paranoia.

Criterios:

1. **LinkedIn /in/ format** — todos los URLs usan linkedin.com/in/[algo], NUNCA linkedin.com/company/
   PASS si son /in/ (slugs limpios o member IDs opacos ACwAA...). FAIL solo si encontrás linkedin.com/company/

2. **Cantidad de cuentas correcta** — te paso "Cuentas esperadas: N" en el mensaje. FAIL si hay MÁS o MENOS cuentas que ese número.

3. **Páginas del PDF** — te paso "Páginas esperadas" en el mensaje. Si dice "no validar", dá este criterio por PASS y NO lo evalúes. Si es un número, FAIL si el PDF no tiene exactamente esa cantidad de páginas.

4. **VERACIDAD de los datos de la empresa** (CRÍTICO):
   FAIL si el overview tiene datos que parecen inventados o demasiado específicos sin verificación (año de fundación, stage de funding, número de productos/clientes, métricas redondas sin fuente, tiempos de respuesta). Si todo el overview suena a "marketing copy genérico" → FAIL.

5. **Coherencia interna + GEOGRAFÍA + VERTICAL** (CRÍTICO) — el reporte trata sobre la empresa correcta y las cuentas hacen sentido para ese ICP.
   FAIL si una cuenta target es la misma empresa mencionada como proof point/cliente del producto en el overview.
   FAIL si una cuenta target está ubicada en un país donde el cliente NO opera / no puede prestar el servicio (mirá la geografía del ICP: las cuentas deben estar en los países de operación del cliente, priorizando el país principal).
   FAIL si la industria/vertical real de una cuenta target está claramente FUERA de las verticales del ICP definido en la página 1 (overview + perfil objetivo). Ejemplos reales de incoherencia a rechazar: una agencia de marketing, una aseguradora, una empresa de energía o cualquier rubro ajeno coladas cuando el ICP apuntaba a otro vertical. Inferí la industria de la cuenta a partir de su nombre, su cargo y el contexto del ángulo/hook; si NO podés determinarla con razonable certeza, NO marques FAIL por este motivo (en duda sobre el rubro, dejá pasar este sub-criterio).
   (La empresa y la industria de la card son datos REALES de Sales Navigator: NUNCA los marques como "inventados" ni "sospechosos". Acá SOLO evaluás la INCOHERENCIA del rubro contra el ICP, no su veracidad.)

6. **Personalización del ÁNGULO y el HOOK** (CRÍTICO — esto lo escribe la IA):
   - Cada card con ángulo y hook ÚNICOS y específicos de ESA persona/empresa, con un pain concreto.
   - FAIL si hay frases genéricas tipo "escalar tu operación" / "mejorar la eficiencia", o si los ángulos/hooks repiten la MISMA estructura entre cards.
   - FAIL si el ángulo o el hook hablan de OTRA persona o empresa distinta a la de la card. El hook debe nombrar a la persona de ESA card.
   - FAIL si el ángulo inventa o infla el cargo (ej. lo llama "Manager" cuando la card dice "Project Manager") o le atribuye estudios/seniority/área que NO constan en la card.
   (El cargo y la empresa de la card son datos REALES — NO los marques como inventados, pero el ángulo NO puede contradecirlos ni agregarles títulos.)

7. **Sin datos rotos** — sin [INSERT], TODO, undefined, lorem ipsum, placeholders {{...}} crudos, ni cards VACÍAS (sin nombre/empresa/cargo/link). Sin fechas incoherentes.
   (Mismo grado de conexión en varias cards NO es error.)
   (El src del logo puede venir como "[LOGO]" — es una redacción interna nuestra para ahorrar tokens, NO es un error ni un placeholder roto; ignoralo.)

8. **Proof points presentes y plausibles** — al menos 1 ancla de credibilidad del cliente. FAIL si suenan fabricados.

Respondé EXCLUSIVAMENTE con JSON válido, sin markdown, sin texto extra:
{"veredicto":"APROBADO"|"RECHAZADO","score":<0-8>,"fixes":["fix concreto 1","fix concreto 2"]}

APROBADO solo si pasa los 8/8. Si RECHAZADO, "fixes" lista instrucciones concretas.`;

// ---------------------------------------------------------------------------
// Llamadas a Claude — CON PROMPT CACHING + logging de tokens
// ---------------------------------------------------------------------------
async function callClaude({ model, system, messages, tools = [], stopSequences = [], maxTokens = 16000 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages
  };

  if (tools.length > 0) {
    const cachedTools = tools.map((t, i) => (i === tools.length - 1) ? { ...t, cache_control: { type: 'ephemeral' } } : t);
    body.tools = cachedTools;
  }
  if (stopSequences.length > 0) body.stop_sequences = stopSequences;

  const MAX_INTENTOS = Number(process.env.CLAUDE_MAX_RETRIES) || 3;
  const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 240000;
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
      break;
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

  if (data.usage) {
    const i = data.usage.input_tokens || 0;
    const o = data.usage.output_tokens || 0;
    const cw = data.usage.cache_creation_input_tokens || 0;
    const cr = data.usage.cache_read_input_tokens || 0;
    const _s = _stats();
    _s.total.input += i; _s.total.output += o; _s.total.cache_write += cw; _s.total.cache_read += cr;
    const st = _s.stages[_s.currentStage];
    if (st) { st.input += i; st.output += o; st.cache_write += cw; st.cache_read += cr; }
  }
  return data;
}

// Extrae el objeto JSON por balance de llaves, respetando strings/escapes.
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

// De los content blocks de una respuesta de Claude, devuelve el texto que contiene el JSON.
// Con web_search la respuesta trae varios bloques de texto (preámbulo + resultado), y el JSON
// queda en el ÚLTIMO. .find() agarraba el primer bloque (el preámbulo, sin "{") y reventaba.
function _textoJSON(content){
  const texts = (content || []).filter(b => b && b.type === 'text').map(b => String(b.text || ''));
  for (let i = texts.length - 1; i >= 0; i--) { if (texts[i].includes('{')) return texts[i]; }
  return texts.join('\n');
}

async function runJudge(html, pageCount) {
  _setStage('judge');
  console.log(`[JUDGE] Evaluando reporte (${pageCount} páginas, esperadas ${EXPECTED_PAGES>0?EXPECTED_PAGES:'no validar'}, cuentas ${NUM_CUENTAS})...`);
  const htmlLite = String(html || '')
    .replace(/src="data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+"/gi, 'src="[LOGO]"')
    .replace(/<style>[\s\S]*?<\/style>/i, '<style>/* css omitido para el juez */</style>');
  const data = await callClaude({
    model: MODEL_JUDGE,
    system: SYSTEM_PROMPT_JUDGE,
    messages: [{
      role: 'user',
      content: `Cuentas esperadas: ${NUM_CUENTAS}\nPáginas esperadas: ${EXPECTED_PAGES>0?EXPECTED_PAGES:'no validar'}\nPáginas del PDF renderizado: ${pageCount}\n\nHTML del reporte:\n${htmlLite}`
    }],
    maxTokens: 4000
  });

  const raw = data.content.find(b => b.type === 'text')?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : raw);
    const result = {
      veredicto: parsed.veredicto || 'RECHAZADO', // sin veredicto explícito → rechazar (fail-closed)
      score: parsed.score ?? 0,
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes : []
    };
    // Coherencia: el juez solo APRUEBA si pasa los 8/8. Un APROBADO con score<8 es
    // incoherente (o un fallback) → se rechaza por seguridad para no enviar sin revisar.
    if (result.veredicto === 'APROBADO' && result.score < 8) {
      console.warn(`[JUDGE] Veredicto incoherente (APROBADO ${result.score}/8) → RECHAZADO por seguridad.`);
      result.veredicto = 'RECHAZADO';
      if (!result.fixes.length) result.fixes = ['Veredicto incoherente del juez (APROBADO con score < 8); se rechaza por seguridad.'];
    }
    console.log(`[JUDGE] Veredicto: ${result.veredicto} ${result.score}/8`);
    if (result.fixes.length > 0) console.log(`[JUDGE] Fixes: ${result.fixes.join(' | ')}`);
    return result;
  } catch (e) {
    // FAIL-CLOSED: si el juez no devuelve un veredicto parseable, NO aprobar.
    // Un error del juez no puede traducirse en un reporte enviado sin revisión.
    console.error('[JUDGE] No se pudo parsear el veredicto → RECHAZO por seguridad (fail-closed):', e.message);
    return { veredicto: 'RECHAZADO', score: 0, fixes: ['El juez no devolvió un veredicto parseable; se rechaza por seguridad para no enviar un reporte sin revisar.'] };
  }
}

// ---------------------------------------------------------------------------
// Helpers de texto / identidad
// ---------------------------------------------------------------------------
function _stripTags(s){return (s||'').replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();}
function _norm(s){return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
function _profileName(txt){return ((txt||'').match(/Profile:\s*(.+?)\s*(?:\[profileId|\u2014|@|$)/i)||[])[1]?.trim()||'';}
function _esc(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function _degOrdinal(n,sample){if(/[\u00b0\u00ba]/.test(sample))return n+'\u00b0';const w={1:'1er',2:'2do',3:'3er'}[n]||(n+'do');return /[A-Z\u00c1\u00c9\u00cd\u00d3\u00da]{2,}/.test(sample)?w.toUpperCase():w;}

function _headlineLimpio(txt){
  return String(txt||'').replace(/^[^—\n]*—\s*/,'').replace(/\s*\([^)]*\)\s*$/,'').trim();
}

// (Gate de links neutralizado: el urn de cada card ya es ground-truth del pool.)
async function verificarLinksData(data){
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
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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
// Resolución de identidad del cliente
// ---------------------------------------------------------------------------
// FIX: "?" NO es una empresa (la DB de IBT a veces trae "@ ?").
function _empresaDeHeadline(txt){let m=(txt||'').match(/@\s*([^·•|(\n]+)/);if(!m)m=(txt||'').match(/\bat\s+([^·•|(\n]+)/i);const e=m?m[1].trim():'';return e==='?'?'':e;}
function _empresaDeLookup(txt){const m=(txt||'').match(/Company:\s*(.+?)\s*(?:\[|—|\u2014|,|$)/i);return m?m[1].trim():'';}
function _headcountDe(txt){const m=(txt||'').match(/([\d][\d.,]*)\s*employees/i);return m?(parseInt(m[1].replace(/[.,]/g,''),10)||null):null;}
function _tier(h){if(h==null)return null;if(h<10)return'micro';if(h<50)return'chica';if(h<500)return'media';if(h<5000)return'grande';return'enterprise';}
function _esEmailGratuito(d){return /(gmail|yahoo|hotmail|outlook|icloud|live|aol|proton|protonmail|gmx)\./i.test((d||'').trim());}
function _mismaEmpresa(a,b){a=_norm(a);b=_norm(b);if(!a||!b)return false;if(a===b||a.includes(b)||b.includes(a))return true;const ta=new Set(a.split(' ').filter(w=>w.length>2));return b.split(' ').filter(w=>w.length>2).some(w=>ta.has(w));}
// Clave de empresa para dedup: saca sufijos legales/genéricos ("Tuya S.A"=="Tuya SA", pero "Grupo TCC"!="Grupo Bios").
function _empKey(emp){
  const k=_norm(emp).replace(/\b(sas|sa|s a|s a s|srl|s r l|ltda|ltd|inc|corp|llc|cia|compania|co|sapi|group|grupo|holding)\b/g,'').replace(/\s+/g,' ').trim();
  return k || _norm(emp);
}
// ¿La empresa del candidato es un competidor directo del cliente? Matchea contra NOMBRES de empresa
// competidora (no contra palabras del headline, para no descartar a un comprador cuyo cargo dice "asistencia").
function _esCompetidor(empresa, competidores){
  const e = _norm(empresa||''); if(!e) return false;
  return (competidores||[]).some(c => c && c.length>=4 && (e.includes(c) || c.includes(e)));
}

async function resolverCliente({ profileId, dominio, empresa }) {
  const dominioReal = !!(dominio && !_esEmailGratuito(dominio));

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
  if (dominio && !_esEmailGratuito(dominio)) {
    try {
      const txt = await callMCP('lookup_company', { companyUrlOrName: dominio });
      const emp = _empresaDeLookup(txt) || empresa || dominio;
      const hc = _headcountDe(txt);
      console.log(`[CLIENTE] anclado por dominio ${dominio} -> "${emp}" (${hc ?? '?'} empleados, tier ${_tier(hc)})`);
      return { empresa: emp, dominio, headcount: hc, tier: _tier(hc), anclado: true, fuente: 'dominio', confianza: 'media' };
    } catch (e) { console.warn(`[CLIENTE] dominio ${dominio} no resolvió:`, e.message); }
  }
  console.warn(`[CLIENTE] ⚠️ SIN ANCLAR (dominio="${dominio}", empresa="${empresa}") -> anclado:false`);
  return { empresa: empresa || dominio || '', dominio: dominio || '', headcount: null, tier: null, anclado: false, fuente: 'sin_anclar', confianza: 'baja' };
}

// ===========================================================================
// PIPELINE FULL (3 fases).
// ===========================================================================
function _slugCos(n){ return _norm(n).split(' ').filter(Boolean).join('-'); }
function _rankSenioridad(head){
  const h=_norm(head);
  if(/\b(cmo|cto|cfo|ciso|chro|coo|cro|ceo|chief|c level|vp|vice president|vicepresidente)\b/.test(h)) return 5;
  if(/\b(director|directora|head|jefe|jefa)\b/.test(h)) return 4;
  if(/\b(gerente|manager|lead|leader|lider|owner|founder|co-founder)\b/.test(h)) return 3;
  if(/\b(analyst|analista|trainee|intern|becari|pasant|junior|assistant|asistente|associate)\b/.test(h)) return 0;
  return 2;
}
function _rankFit(head, titulos){
  const h=_norm(head);
  const lista = Array.isArray(titulos) ? titulos : [];
  const matchFuncion = lista.some(t=>{ const n=_norm(t); return n && n.length>=2 && h.includes(n); });
  const sen=_rankSenioridad(head);
  return (matchFuncion ? 100 : 10) + sen;
}
// Calidez de la conexión: 1er grado > 2do > 3ro > fuera de red. Se usa SOLO como desempate
// (a igual fit/país gana el más cálido), nunca por encima del fit. El skill GTM pide priorizar 2do grado.
function _warmth(dist){ return dist===1 ? 3 : dist===2 ? 2 : dist===3 ? 1 : 0; }
// Corre fn sobre items con como MÁXIMO `limit` en paralelo (preserva el orden de items).
// Sirve para no pegarle al MCP de a una (lento) ni todas juntas (rate limit / timeout).
async function _mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({length:n}, async () => {
    while(true){
      const idx = i++;
      if(idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// FIX: limpia el sufijo "@ ?" del headline enriquecido (empresa sin resolver en DB).
function _parsePeople(res){
  return [...String(res||'').matchAll(/id=([A-Za-z0-9_\-]+)\s+"([^"]+)"\s+(.*?)\s*\(DISTANCE_(\d|OUT_OF_NETWORK)[^,)]*(?:,\s*([^)]+))?\)/g)]
    .map(x=>({ id:x[1], name:x[2], head:(x[3]||'').trim(), dist: x[4]==='OUT_OF_NETWORK'?9:parseInt(x[4],10), loc:(x[5]||'').trim() }));
}
function _parseProfile(res){
  const s=String(res||'');
  const hc=(s.match(/(\d[\d,]*)\s+employees/)||[])[1];
  let headRich=((s.match(/—\s*(.+?)\s*\(\s*(?:\?|\d)/)||[])[1]||'').trim();
  headRich=headRich.replace(/\s*@\s*\?\s*$/,'').trim();
  return { headcount: hc?parseInt(hc.replace(/,/g,''),10):null, headRich };
}
// Parsea resultados de búsqueda de EMPRESAS: id=NUMERO "Nombre" Industria (NNN employees, ?)
// Headcount puede venir como "442", "1,5 mil+", "10 mil+" (es-MX). Normaliza a entero.
function _parseHC(raw){
  if(!raw) return null;
  const mil = /mil/i.test(raw);
  const s = String(raw).toLowerCase().replace(/mil/,'').replace(/\+/g,'').trim().replace(/\./g,'').replace(',','.');
  const n = parseFloat(s);
  if(isNaN(n)) return null;
  return Math.round(mil ? n*1000 : n);
}
function _parseCompanies(res){
  return [...String(res||'').matchAll(/id=([0-9]+)\s+"([^"]+)"\s+(.*?)\s*\(\s*([^)]*?)\s*employees/g)]
    .map(x=>({ id:x[1], name:x[2], industry:(x[3]||'').trim(), headcount: _parseHC(x[4]) }));
}
// Sales Navigator NO acepta rangos de headcount arbitrarios: solo estos brackets fijos.
// Pasar {min:100,max:100000} hace fallar la query (error 500) → 0 cuentas-ancla.
const _HC_BRACKETS = [
  {min:1,max:10},{min:11,max:50},{min:51,max:200},{min:201,max:500},
  {min:501,max:1000},{min:1001,max:5000},{min:5001,max:10000},{min:10001}
];
// Devuelve los brackets válidos que cubren "hcMin o más".
function _hcDesde(hcMin){
  const m = Number(hcMin) || 0;
  if(m <= 1) return _HC_BRACKETS.slice();
  const sel = _HC_BRACKETS.filter(b => b.max === undefined || b.max >= m);
  return sel.length ? sel : [{min:10001}];
}
function _sizeBoost(hc, tamMin){
  if(hc==null) return 0;
  if(tamMin && tamMin>0) return hc>=tamMin ? 2 : (hc>=tamMin*0.5 ? 1 : 0);
  return hc>=1000?3 : hc>=200?2 : hc>=50?1 : 0;
}

function validarPlan(plan){
  const p = (plan && plan._plan) || {};
  const faltan = [];
  if(!p.funcion   || !String(p.funcion).trim())   faltan.push('funcion');
  if(!p.geografia || !String(p.geografia).trim()) faltan.push('geografia');
  if(!Array.isArray(p.titulos_objetivo) || !p.titulos_objetivo.length) faltan.push('titulos_objetivo');
  if(faltan.length) throw new Error(`PLAN incompleto: falta ${faltan.join(', ')} — no se genera el reporte.`);
  return plan;
}

async function sourceCandidates(plan, cliente){
  validarPlan(plan);
  const icp = plan._plan;
  const geografia = icp.geografia;            // país principal del cliente
  const homeGeo   = _norm(geografia||'');
  const funcion   = icp.funcion;
  const titulos   = Array.isArray(icp.titulos_objetivo) ? icp.titulos_objetivo : [];

  // países donde el cliente opera (secundarios), sin el principal
  const todas = (Array.isArray(icp.geografias) && icp.geografias.length ? icp.geografias : [geografia]).filter(Boolean);
  const secundarias = todas.filter(g => _norm(g) !== homeGeo).slice(0, 5);

  // TÉRMINOS de rol: Sales Navigator NO tolera keywords multi-palabra (las trata como frase casi-exacta
  // y devuelve 0). Buscamos UN término por vez y unimos. Cada título objetivo es un término (1-2 palabras).
  // Hasta 6 para que entren tanto los roles de facilities como los del producto/canal del cliente.
  const terminos = (titulos.length ? titulos : [funcion])
    .map(t=>String(t||'').replace(/[\/|]+/g,' ').replace(/\s+/g,' ').trim())
    .filter(t=>t.length>=3)
    .slice(0,6);

  async function locId(nombrePais){
    try{
      const txt = String(await callMCP('resolve_sales_navigator_id',{type:'LOCATION',keywords:nombrePais,limit:8}));
      const matches = [...txt.matchAll(/id="?([0-9]+)"?\s+"([^"]+)"/g)].map(m=>({id:m[1],name:m[2]}));
      const exacto = matches.find(m=> _norm(m.name)===_norm(nombrePais)); // "Colombia", NO "Antioquia, Colombia"
      if(!exacto && matches[0]) console.warn(`[SOURCE] LOCATION "${nombrePais}": sin match exacto de país, uso "${matches[0].name}".`);
      return (exacto||matches[0])?.id || null;
    }catch{ return null; }
  }
  let fnId=null;
  try{ fnId=(String(await callMCP('resolve_sales_navigator_id',{type:'FUNCTION',keywords:funcion,limit:3})).match(/id="?([A-Za-z0-9_]+)"?/)||[])[1]||null; }catch{}

  // INDUSTRIAS ANCLA: verticales del ICP -> IDs de Sales Navigator (filtro de fit DURO).
  // Con esto traemos decisores EN aseguradoras/retailers/inmobiliarias, no admins de cualquier empresa.
  const indIds=[];
  for(const ind of (Array.isArray(icp.industrias)?icp.industrias:[]).slice(0,6)){
    try{ const id=(String(await callMCP('resolve_sales_navigator_id',{type:'SALES_INDUSTRY',keywords:ind,limit:1})).match(/id="?([0-9]+)"?/)||[])[1]; if(id && !indIds.includes(id)) indIds.push(id); }catch{}
  }

  // SIN filtro de grado en el search (no es confiable: 1st->0, 2nd mezcla 3ro). Traemos por FIT
  // y leemos el grado real (DISTANCE) de cada perfil; el grado se prioriza en el RANKING, no en el filtro.
  async function buscarUno(locIds, conIndustria, kwUnico){
    const f={ category:'people', profilesLimit:50 };
    if(kwUnico) f.keywords = kwUnico;                       // UNA sola palabra/término (multi-palabra da 0)
    if(locIds && locIds.length) f.location={ include: locIds };
    if(fnId) f.function={ include:[fnId] };
    if(conIndustria && indIds.length) f.industry={ include: indIds };
    try{ return _parsePeople(await callMCP('search_sales_navigator_filtered', f)); }catch{ return []; }
  }
  // Une los resultados de buscar cada término de rol por separado (dedupe por id), en PARALELO con tope CONC.
  const CONC = parseInt(process.env.SOURCE_CONCURRENCY || '4', 10);
  async function buscar(locIds, conIndustria){
    if(!terminos.length) return await buscarUno(locIds, conIndustria, null);
    const listas = await _mapLimit(terminos, CONC, t => buscarUno(locIds, conIndustria, t));
    const acc=[]; const vis=new Set();
    for(const lista of listas){ for(const p of (lista||[])){ if(p.id && !vis.has(p.id)){ vis.add(p.id); acc.push(p); } } }
    return acc;
  }
  const _validosHome = arr => arr.filter(p => _rankSenioridad(p.head) >= 2 && _norm(p.loc||'').includes(homeGeo)).length;

  // GEOGRAFÍA: país principal PRIMERO + países donde el cliente HOY opera (cercanos).
  const homeId  = await locId(geografia);
  const homeLoc = homeId ? [homeId] : null;
  const opsIds  = [];
  for(const g of secundarias){ const id = await locId(g); if(id && id!==homeId && !opsIds.includes(id)) opsIds.push(id); }
  const geoLoc  = [...(homeLoc||[]), ...opsIds];
  const geoLocOrNull = geoLoc.length ? geoLoc : null;
  const HOME_MIN = parseInt(process.env.SOURCE_HOME_MIN || String(NUM_CUENTAS + 2), 10);

  // Competidores a EXCLUIR (se calculan ANTES porque también filtran las cuentas-ancla).
  const competidores = (Array.isArray(icp.competidores)?icp.competidores:[]).map(_norm).filter(c=>c.length>=4);
  const _indNorm = (Array.isArray(icp.industrias)?icp.industrias:[]).map(_norm).filter(Boolean);
  const _raiz = w => w.slice(0, Math.max(5, w.length - 2));  // recorta género/plural para comparar raíces
  const compTerminos = (Array.isArray(icp.competidor_terminos)?icp.competidor_terminos:[])
    .map(_norm).filter(t => {
      if(t.length < 4) return false;
      const rt = _raiz(t);
      // SALVAGUARDA: no uses como filtro un término que sea el VERTICAL del comprador (ej. "inmobiliaria" ~ "inmobiliario").
      return !_indNorm.some(ind => { const ri=_raiz(ind); return ind.includes(t)||t.includes(ind)||rt.startsWith(ri)||ri.startsWith(rt); });
    });
  const _esComp = (emp) => { const e=_norm(emp||''); if(!e) return false; return _esCompetidor(e, competidores) || compTerminos.some(t=>e.includes(t)); };

  const tamMin = parseInt(icp.tamano_min || 0, 10) || 0;

  // ===== PASADA A — ACCOUNT-FIRST: cuentas-ancla con señal de compra =====
  // Buscamos EMPRESAS que encajan el ICP (industria + geo + tamaño) y están "en movimiento" (crecimiento de
  // headcount = señal genérica y honesta de que pueden estar comprando). Si la señal recorta de más, recall sin
  // señal. Las cuentas-ancla sesgan el ranking hacia clientes reales, no hacia ICs sueltos de cualquier empresa.
  const hcMin = tamMin > 0 ? Math.max(11, Math.round(tamMin*0.5)) : 11;
  let cuentas = [];
  if(indIds.length && geoLocOrNull){
    const baseCo = { category:'companies', profilesLimit:25, location:{include:geoLocOrNull}, industry:{include:indIds}, headcount:_hcDesde(hcMin) };
    try{ cuentas = _parseCompanies(await callMCP('search_sales_navigator_filtered', {...baseCo, headcountGrowth:{min:8, max:1000}})); }
    catch(e){ console.warn('[SOURCE] companies (con señal) falló:', e.message); }
    if(cuentas.length < NUM_CUENTAS*2){   // la señal recortó demasiado para este vertical: recall sin señal
      try{ const more=_parseCompanies(await callMCP('search_sales_navigator_filtered', baseCo)); for(const c of more) if(!cuentas.some(x=>x.id===c.id)) cuentas.push(c); }
      catch(e){ console.warn('[SOURCE] companies (sin señal) falló:', e.message); }
    }
  } else if(geoLocOrNull){
    // PASADA A' — FALLBACK por KEYWORD: ninguna industria del ICP resolvió a un id de Sales Navigator
    // (la taxonomía es MUY sensible al término exacto; p.ej. "Robotics" da 0, "Robotic Engineering" sí).
    // Sin indIds, el account-first normal no corre y todo caería al people-first. Revivimos las cuentas-ancla
    // buscando EMPRESAS por keyword (que SÍ funciona). Keyword = nombre de industria del ICP / funcion, UNO por
    // búsqueda (multi-palabra da 0, igual que en people). El piso de headcount limpia el ruido (1-persona/medios).
    const kwAncla = [...(Array.isArray(icp.industrias)?icp.industrias:[]), funcion]
      .map(t=>String(t||'').replace(/[\/|]+/g,' ').replace(/\s+/g,' ').trim())
      .filter(t=>t && t.split(' ').length===1 && t.length>=3)   // UNA sola palabra por búsqueda (multi-palabra da 0)
      .filter((t,i,a)=>a.indexOf(t)===i)
      .slice(0,4);
    const baseKw = { category:'companies', profilesLimit:25, location:{include:geoLocOrNull}, headcount:_hcDesde(hcMin) };
    const listas = await _mapLimit(kwAncla, CONC, async kw => {
      try{ return _parseCompanies(await callMCP('search_sales_navigator_filtered', {...baseKw, keywords: kw})); }
      catch(e){ console.warn(`[SOURCE] companies por keyword "${kw}" falló:`, e.message); return []; }
    });
    for(const lista of listas){ for(const c of (lista||[])) if(c.id && !cuentas.some(x=>x.id===c.id)) cuentas.push(c); }
    console.log(`[SOURCE] sin industria resuelta → ancla por keyword [${kwAncla.join(', ')||'-'}]: ${cuentas.length} empresas (piso hc>=${hcMin}).`);
  }
  cuentas = cuentas.filter(c => c.name && !_esComp(c.name));   // no anclar en un competidor/proveedor
  const anclaIds     = cuentas.map(c=>c.id).filter(Boolean).slice(0, 20);
  const anclaNombres = new Set(cuentas.map(c=>_empKey(c.name)).filter(Boolean));
  const anclaHC      = new Map(cuentas.map(c=>[_empKey(c.name), c.headcount]));
  console.log(`[SOURCE] cuentas-ancla: ${cuentas.length}${cuentas.length?` (${cuentas.slice(0,8).map(c=>c.name).join(', ')}${cuentas.length>8?'…':''})`:''}.`);

  // ===== PASADA B — DECISORES dentro de las cuentas-ancla (fit alto, empresa controlada) =====
  let enCuentas = [];
  if(anclaIds.length){
    const f={ category:'people', profilesLimit:50, company:{include: anclaIds} };
    if(geoLocOrNull) f.location={include:geoLocOrNull};
    if(terminos.length) f.jobPosition={ include: terminos };   // acota a los cargos objetivo dentro de la cuenta
    try{ enCuentas = _parsePeople(await callMCP('search_sales_navigator_filtered', f)); }catch{}
  }

  // ===== PASADA C — BARRIDO people-first amplio (captura el 2do grado DISPERSO de la red) =====
  let barrido = await buscar(geoLocOrNull, true);
  if(_validosHome(barrido) < HOME_MIN) barrido = barrido.concat(await buscar(geoLocOrNull, false));

  // Unimos: cuentas-ancla primero (fit), después el barrido (warm disperso). Dedupe en el loop por id.
  const pool = [...enCuentas, ...barrido];
  console.log(`[SOURCE] pool bruto: ${enCuentas.length} en cuentas-ancla + ${barrido.length} barrido = ${pool.length}.`);

  // dedupe + descartes (decisor real, no la propia empresa del cliente, no competidores) + marca ancla
  const vistos=new Set(); const out=[]; const empCliente=_norm((cliente&&cliente.empresa)||'');
  for(const p of pool){
    if(!p.id || vistos.has(p.id)) continue; vistos.add(p.id);
    if(_rankSenioridad(p.head) < 1) continue;                 // descarta asistente/analista/becario/junior
    const emp=_empresaDeHeadline(p.head)||'';
    if(empCliente && emp && _mismaEmpresa(empCliente, emp)) continue;
    if(emp && _esComp(emp)){ console.warn(`[SOURCE] descartado por COMPETIDOR/proveedor: ${p.name} @ ${emp}`); continue; }
    const cerca = homeGeo && _norm(p.loc||'').includes(homeGeo) ? 1 : 0;
    const ancla = (emp && anclaNombres.has(_empKey(emp))) ? 1 : 0;
    const hcPre = ancla ? (anclaHC.get(_empKey(emp)) ?? null) : null;   // headcount ya conocido de la cuenta-ancla
    out.push({ id:p.id, name:p.name, head:p.head, empresa:emp, dist:p.dist, loc:p.loc, cerca, ancla, headcount:hcPre, rank:_rankSenioridad(p.head), fit:_rankFit(p.head, titulos) });
  }
  // orden inicial: país y cuenta-ancla mandan; después fit; el grado ya cuenta (warmth) antes que la seniority
  out.sort((a,b)=> (b.cerca-a.cerca) || (b.ancla-a.ancla) || (b.fit-a.fit) || (_warmth(b.dist)-_warmth(a.dist)) || (b.rank-a.rank));

  // enriquecer el top por cargo y tamaño (solo los que no tienen headcount ya de la cuenta-ancla)
  const K = parseInt(process.env.SOURCE_ENRICH_TOP || '12', 10);
  const noCache = String(process.env.SOURCE_ENRICH_NOCACHE||'').toLowerCase()==='true';
  const PISO   = tamMin > 0 ? tamMin : parseInt(process.env.ICP_MIN_HEADCOUNT || '20', 10);
  const top = out.slice(0, K);
  await _mapLimit(top, CONC, async (c) => {
    if(c.headcount==null){
      try{
        const prof=_parseProfile(await callMCP('get_contact_profile',{ publicIdOrUrl: c.id, noCache }));
        if(prof.headcount!=null) c.headcount=prof.headcount;
        if(prof.headRich && prof.headRich.length>=3){
          c.head=prof.headRich; c.empresa=_empresaDeHeadline(prof.headRich) || c.empresa; c.fit=_rankFit(prof.headRich, titulos);
        }
      }catch{}
    }
    c.cerca = homeGeo && _norm(c.loc||'').includes(homeGeo) ? 1 : 0;
    // SCORING: fit y tamaño mandan; la cuenta-ancla y el grado (×2) ahora pesan de verdad, no solo desempatan.
    c.score = c.fit*3 + _sizeBoost(c.headcount, tamMin)*3 + (c.ancla?4:0) + c.cerca + _warmth(c.dist)*2;
  });
  // piso de tamaño contra el ICP, SIN vaciar el pool
  const cumplen  = top.filter(c => !(c.headcount!=null && c.headcount < PISO));
  const fueraTam = top.filter(c => c.headcount!=null && c.headcount < PISO);
  for(const p of fueraTam) console.warn(`[SOURCE] fuera de ICP por tamaño (${p.headcount}<${PISO}): ${p.name} @ ${p.empresa||'?'}`);
  const topICP = (cumplen.length >= NUM_CUENTAS) ? cumplen : top;
  if(cumplen.length < NUM_CUENTAS) console.warn(`[SOURCE] piso ${PISO} dejó ${cumplen.length}/${NUM_CUENTAS} -> relajo el piso para no quedar corto.`);
  topICP.sort((a,b)=> (b.cerca-a.cerca) || (b.ancla-a.ancla) || (b.score-a.score) || (b.fit-a.fit));

  // Pasamos MÁS candidatos a la IA (18) para que tenga de dónde elegir cuenta-ancla + warm.
  const N_IA = parseInt(process.env.SOURCE_TO_IA || '18', 10);
  let final = topICP.concat(out.slice(K)).slice(0, N_IA);
  // CUOTA DE GRADO: el 2do grado convierte mucho más. Si quedó poco 2do grado pero existe en el pool, metelo
  // (priorizando cuenta-ancla y fit). No es filtro duro: solo garantiza presencia de warm cuando lo hay.
  const DESEADOS2 = parseInt(process.env.SOURCE_MIN_2ND || '4', 10);
  const segundos = out.filter(c => c.dist===2);
  if(segundos.length){
    const ya = new Set(final.map(c=>c.id));
    const faltan = DESEADOS2 - final.filter(c=>c.dist===2).length;
    if(faltan > 0){
      const add = segundos.filter(c=>!ya.has(c.id)).sort((a,b)=>(b.ancla-a.ancla)||(b.fit-a.fit)).slice(0, faltan);
      if(add.length){ final = final.concat(add); console.log(`[SOURCE] cuota de grado: +${add.length} de 2do grado al pool de la IA.`); }
    }
  }

  // ENRIQUECER TAMAÑO ANTES DE LA IA: el barrido (pasada C) y la cuota de grado meten candidatas con
  // headcount null (solo el top K se enriqueció arriba). Si llegan así a la IA, el filtro de tamaño no
  // puede juzgar lo desconocido, la IA elige una micro-empresa y recién el gate final la caza → rechazo total.
  // Leemos el headcount real de los null de `final` (get_contact_profile es lectura, NO gasta créditos).
  const faltaHC = final.filter(c => c.headcount==null);
  if(faltaHC.length){
    await _mapLimit(faltaHC, CONC, async (c) => {
      try{
        const prof=_parseProfile(await callMCP('get_contact_profile',{ publicIdOrUrl: c.id, noCache }));
        if(prof.headcount!=null) c.headcount=prof.headcount;
        if(prof.headRich && prof.headRich.length>=3){
          c.head=prof.headRich; c.empresa=_empresaDeHeadline(prof.headRich) || c.empresa; c.fit=_rankFit(prof.headRich, titulos);
        }
        // recomputar el score ahora que el tamaño se conoce (para que el ranking lo refleje)
        c.score = c.fit*3 + _sizeBoost(c.headcount, tamMin)*3 + (c.ancla?4:0) + c.cerca + _warmth(c.dist)*2;
      }catch{}
    });
  }

  // DESCARTE EGREGIO (opción B): el tamaño es señal de VALOR, no de credibilidad. Solo sacamos del pool de la
  // IA lo EGREGIO: headcount CONOCIDO y < 25% del piso (prácticamente un individuo/micro-agencia). Las de
  // tamaño desconocido o entre 25%-100% del piso SÍ pueden quedar (el tamaño solo les baja el ranking).
  const EGREGIO = Math.round(PISO * 0.25);
  const antes = final.length;
  final = final.filter(c => {
    if(c.headcount!=null && c.headcount < EGREGIO){
      console.warn(`[SOURCE] descartado por tamaño EGREGIO (${c.headcount}<${EGREGIO}, 25% del piso ${PISO}): ${c.name} @ ${c.empresa||'?'}`);
      return false;
    }
    return true;
  });
  // Si el descarte egregio dejó el pool corto, lo rellenamos desde `out` (excluyendo lo ya elegido y lo egregio
  // CONOCIDO), respetando el orden de ranking. No reintroducimos egregios (esa es la regla).
  if(final.length < antes && final.length < N_IA){
    const ya = new Set(final.map(c=>c.id));
    const reponer = out.filter(c => !ya.has(c.id) && !(c.headcount!=null && c.headcount < EGREGIO)).slice(0, N_IA - final.length);
    if(reponer.length){ final = final.concat(reponer); }
  }

  const n2 = final.filter(c=>c.dist===2).length, nAncla = final.filter(c=>c.ancla).length;
  console.log(`[SOURCE] pool ${out.length} (${out.filter(c=>c.cerca).length} en ${geografia}) | enriquecidos ${top.length} | fuera-tam ${fueraTam.length} | a la IA ${final.length} (ancla=${nAncla}, 2do=${n2}, terminos=[${terminos.join(', ')||'-'}], ind=[${indIds.join('+')||'-'}], piso<${PISO}).`);
  return final;
}

// FASE 1 — IA: research + ICP + página 1. Prompt parametrizado por N.
function _promptPlan(N){ return `# IBT GTM — Fase PLAN (research + ICP + página 1)

Generás la PARTE 1 de un reporte de análisis de mercado que IBT manda a un prospecto. NO elegís personas todavía: eso lo hace el sistema. Vos investigás al cliente y definís a QUIÉN hay que buscar.

## Qué hacer
1. Research REAL del cliente con web_search: qué hace/vende, modelo de negocio, país, año de fundación, stage, tracción/proof point. PROHIBIDO inventar — si no lo verificás, no lo afirmes.
2. Definí el ICP del COMPRADOR del cliente: la función/área del decisor depende de lo que el cliente VENDE. Pensá a quién le compra el producto.
3. Escribí TODO el contenido de página 1 (ribbon, stats, icp, contexto, aperturas, prioridades, lead, proof, h1).

## Reglas
- PRINCIPIO RECTOR (gobierna TODO lo de abajo): tu nivel de certeza al escribir tiene que IGUALAR el nivel de tu fuente. No subas el tono (no afirmes como un hecho algo que la fuente sugiere, ni como "operación" algo que recién arranca, ni como "cliente" a un tercero que no está confirmado) ni lo bajes (no llames "apertura/posibilidad" a algo que la fuente da por consolidado). Ante la duda: bajá el tono a una formulación cualitativa, o directamente omití el dato. Las reglas que siguen (números, año de fundación, terceros, países) son CASOS de este mismo principio; cuando dudes en algo no listado, aplicá el principio igual.
- "fecha" = EXACTAMENTE la fecha de hoy que te paso en el mensaje (no inventes otra).
- ATRIBUTOS Y CREDENCIALES DEL CLIENTE (caso del principio rector, tan grave como inventar un número): NO le atribuyas al cliente certificaciones, acreditaciones, pólizas, sellos, cumplimientos normativos ni características operativas específicas salvo que web_search lo confirme en una fuente del propio cliente. Esto incluye cosas que "suenan lógicas" pero que no viste: "técnicos certificados en alturas", "pólizas de responsabilidad civil", "proveedor auditado", "certificación ISO", "atención/operación 24/7", "garantía de X horas". Que sea PLAUSIBLE para el rubro NO alcanza: si no salió de una fuente, no lo afirmes. Si querés transmitir formalidad/calidad sin el dato puntual, usá una formulación cualitativa y verificable ("un proveedor formal del segmento", "una red estructurada de técnicos") en vez de inventar la credencial. Una credencial falsa que el prospecto repregunta quema el reporte igual que un nombre de tercero inventado.
- VERACIDAD (CRÍTICO): PROHIBIDO inventar métricas o datos duros. Esto incluye específicamente: cantidad de categorías/tipos de servicio (ej. "+300 categorías"), totales acumulados (ej. "+470.000 servicios"), tiempos de respuesta ("60 minutos"), %, premios, año de fundación o stage. Si un número NO sale textual de web_search o de una fuente verificable, NO lo pongas en ningún lado (lead, proof, context, apertura, stats, ribbon). Ante la duda, usá una formulación cualitativa SIN número ("amplia cobertura", "varias categorías de servicio"). Es preferible un reporte sin números a uno con números inventados. REGLA DE ORO: antes de cerrar, releé CADA número que escribiste; si no podés señalar la fuente exacta de web_search de donde salió, BORRALO o pasalo a texto cualitativo. El invento más común y MÁS GRAVE es "+300 tipos de servicio" o "+X servicios/clientes": NO lo escribas jamás si no lo viste en una fuente.
- STATS: que los 4 chips sean datos verificables o estructurales (ej: la cantidad ${N} de cuentas priorizadas, países de operación reales, año de fundación SOLO si lo verificaste). NUNCA rellenes un stat con un número inventado para que "quede lindo". Preferí stats que IMPACTEN y sean verificables (ciudades/países de cobertura, años en el mercado, la cantidad ${N} de cuentas). EVITÁ stats que subvendan al cliente, como su propia cantidad de empleados si es baja.
- AÑO DE FUNDACIÓN (cuidado especial): es un dato que suele estar ambiguo o contradictorio entre fuentes. Ponelo SOLO si una fuente autoritativa y específica lo confirma (la página propia del cliente o su perfil de Endeavor/Crunchbase). Si las fuentes que ves en web_search NO coinciden, o si solo lo viste en directorios genéricos, NO lo afirmes: omití el stat de año y usá otro verificable en su lugar (países de operación, ciudades de cobertura, año de un hito real como un premio o reconocimiento, la cantidad ${N} de cuentas). Nunca elijas "el primero que aparezca": si el cliente tiene un reconocimiento (ej. Endeavor) con un año, ese año es más confiable que un directorio.
- NOMBRES DE TERCEROS (CRÍTICO para la credibilidad): PROHIBIDO nombrar a una empresa específica como cliente, aliado o socio del cliente (ej. "trabaja con X", "X es cliente", "(cliente verificado)") salvo que web_search lo confirme EXPLÍCITAMENTE en una fuente. Si querés ilustrar el canal o el mercado, hacelo en GENÉRICO ("retailers de mejoramiento del hogar", "aseguradoras con línea hogar") SIN nombre propio y SIN la palabra "verificado". Un nombre de tercero inventado quema el reporte si el prospecto lo chequea.
- El ICP card "Rol del decisor" y el bloque _plan.funcion deben describir al MISMO comprador.
- TÍTULO (H1): el CLIENTE va PRIMERO y resaltado. h1_pre = "" (vacío); h1_company = nombre del cliente (lo resaltado, va primero); h1_post = "${N} clientes potenciales en [País o región]" (es un SUBTÍTULO que va DEBAJO del nombre; SIN "·" ni guion al principio). PROHIBIDO "para escalar".
- IDIOMA: TODO en ESPAÑOL NEUTRO latinoamericano, trato de "usted". Sin voseo ni modismos argentinos ("vos", "tenés", "podés", "acá"). El prospecto puede ser de cualquier país de LatAm.
- SIN GUIONES (importante): NUNCA uses guiones largos (—) ni guiones (-) como conectores o para incisos, en NINGÚN texto (lead, proof, context, apertura, icp, prioridades). Reemplazalos por comas, paréntesis o dos puntos. Ej: en vez de "servicios técnicos —plomería, electricidad— con cobertura", escribí "servicios técnicos (plomería, electricidad) con cobertura". El texto tiene que sonar humano, no de IA.
- GEOGRAFÍA (CRÍTICO): "geografia" = país del cliente (prioritario). "geografias" = país del cliente PRIMERO + SOLO los demás países donde el cliente HOY ya puede prestar el servicio de verdad (sus países de operación actuales). PROHIBIDO mercados de expansión futura o donde el cliente todavía NO opera. El sistema prioriza fuerte el país del cliente; los demás solo rellenan.
- ALCANCE REGIONAL / NEARSHORE (caso del principio rector, para verticales nicho donde el país principal da pool pobre): además de los países de operación actual, PODÉS sumar a "geografias" países cercanos ADICIONALES donde el cliente PUEDE prestar/vender el servicio hoy (modelo nearshore o regional), PERO con estos guardarraíles INNEGOCIABLES: (a) solo si web_search CONFIRMA en una fuente del propio cliente que sirve/le vende a esos países (cobertura regional declarada, modelo remoto/exportable, casos en la región); que sea PLAUSIBLE para el rubro NO alcanza. (b) NUNCA agregues un país solo para "rellenar" ni porque haya más gente o pool más cálido ahí: la cantidad de leads disponibles NO es una razón válida. (c) El país principal SIGUE MANDANDO y va PRIMERO. No SUB-escopees la geografía real del cliente, pero tampoco inventes mercados. COHERENCIA OBLIGATORIA: cada país que sumes a "geografias" tiene que aparecer también en el título (h1_post) y en el ICP "Geografía"; si no lo vas a nombrar ahí, NO lo agregues.
- NIVEL DE CERTEZA POR PAÍS (caso del principio rector; lo nota el cliente): no todos los países donde aparece un cliente están al mismo nivel. Clasificá CADA uno según cómo lo describen TUS fuentes de web_search y usá un lenguaje que coincida con esa evidencia:
  • CONSOLIDADO (la fuente dice "opera en", "tiene oficina/equipo/Country Manager en", "presencia en", "desde hace X años", "lanzó/llegó en 20XX") → escribilo como "opera en X" / "con operación en X". NUNCA lo llames "apertura a X", "posibilidad de extender a X" ni "mercado futuro" (eso subvalúa y es falso si ya está ahí hace años).
  • RECIENTE / EN ENTRADA (la fuente dice "se está expandiendo a", "está entrando en", "recién llegó a", "lanzó este año en") → escribilo como "expansión reciente a X" / "está entrando en X". No lo presentes con la misma solidez que un mercado consolidado.
  • SOLO PLAN (la fuente dice "planea", "quiere", "próximamente", "evalúa", sin operar todavía) → NO lo cuentes como país de operación, ni en el texto ni en el stat.
  REGLA DE ORO: no subas ni bajes el nivel respecto de lo que dice la fuente. Si DISTINTAS fuentes difieren en el nivel de un mismo país (ej. una dice "opera en" y otra "se está expandiendo a"), usá SIEMPRE el nivel MÁS BAJO/conservador (en ese caso, "expansión reciente"), nunca el más optimista. El stat de países (si lo ponés) cuenta los consolidados + los recientes reales (NO los aspiracionales), y el texto y el stat tienen que COINCIDIR: si decís que opera/se expande en 3 países, el stat dice 3, no 2. Si no estás seguro de un país, no lo cuentes en ningún lado, pero que texto y stat coincidan.
  COHERENCIA NUMÉRICA DE PAÍSES (CRÍTICO, defecto recurrente): fijá UNA SOLA lista de países (los consolidados + recientes reales) y usá EXACTAMENTE esa misma lista, con los MISMOS nombres y la MISMA cantidad, en los TRES lugares: (1) el número del stat de países, (2) los países nombrados en h1_post, y (3) los países nombrados en el ICP "Geografía". REGLA INNEGOCIABLE: cada país que cuentes en el número del stat tiene que estar nombrado en h1_post Y en el ICP "Geografía"; y cada país que nombres en h1_post o en el ICP tiene que estar contado en el stat. PROHIBIDO contar un país en el número que no esté escrito en el texto, o nombrar en el texto uno que no esté en el cuenta (ej. contar 4 pero listar solo España, México y Guatemala sin Andorra es un BUG). CIERRE OBLIGATORIO: antes de cerrar el JSON, contá con el dedo los países que nombraste en el ICP "Geografía", verificá que sean los MISMOS que en h1_post, y que ese número sea EXACTAMENTE el del stat de países; si no coinciden, corregilo antes de devolver.
- INDUSTRIAS (CRÍTICO — ahora es un FILTRO DURO de búsqueda): "industrias" tiene que listar las VERTICALES ANCLA reales donde están los COMPRADORES del cliente (las mismas que marcás ALTA en "prioridades"). El sistema busca decisores SOLO en estas industrias, así que tienen que ser categorías reales y reconocibles (ej: "Seguros", "Comercio al por menor", "Inmobiliario", "Banca", "Administración de propiedades"). NO pongas el rubro del propio cliente ni industrias genéricas. TAXONOMÍA (CRÍTICO para que el filtro NO se caiga): cada nombre de "industrias" tiene que ser una CATEGORÍA RECONOCIBLE de la taxonomía de industrias de LinkedIn/Sales Navigator (las que el sistema resuelve a un id de filtro), NO una etiqueta hiper-específica, de moda o inventada que no exista como industria. Una etiqueta que no resuelve deja la búsqueda SIN filtro de industria. Preferí siempre la categoría canónica más cercana al COMPRADOR: ej. usá "Ingeniería robótica" / "Robotic Engineering" o "Fabricación de maquinaria de automatización" en vez de "Robotics" a secas. Es válido (y recomendado ante la duda) poner el nombre en español Y/O su equivalente reconocible en inglés. EVITÁ verticales industriales/pesadas amplias (ej. "Construcción", "Manufactura", "Minería", "Cemento") salvo que sean LITERALMENTE el comprador: arrastran jefes de mantenimiento de planta que consumen el servicio puertas adentro pero NO son el canal de compra. Ante la duda, preferí las verticales donde el producto del cliente se compra o se revende.
- TAMAÑO (para que salgan empresas ANCLA, no micro-empresas): "tamano_min" tiene que ser un número real de empleados que refleje el ICP. Si el ICP son empresas medianas y grandes / marcas ancla, poné un piso alto (ej: 200). Poné un piso bajo (20-50) SOLO si el ICP son genuinamente PyMEs/micro. NO lo dejes en 0 salvo que de verdad cualquier tamaño sirva.
- COMPETIDORES (importante para no quemar el reporte): en "competidores" listá los NOMBRES de empresas que NO son compradores porque venden/fabrican LO MISMO que el cliente. Buscalos con web_search e incluí TRES tipos: (i) competidores directos de tamaño similar; (ii) FABRICANTES o PROVEEDORES globales del mismo producto (ej. para detonadores/voladura: Enaex, Orica, Dyno Nobel, Sandvik; para staffing de tecnología: Toptal, Turing, Andela, TEKsystems); (iii) distribuidores o integradores que revenden ese producto. Son PARES o RIVALES, no clientes. El sistema EXCLUYE a cualquiera que trabaje en esas empresas. Usá nombres de marca/empresa REALES del research. NO pongas palabras genéricas del servicio (ej. "asistencia", "mantenimiento") porque descartaría compradores legítimos. Si no identificás competidores claros, dejá la lista vacía.
- COMPETIDOR_TERMINOS (filtro de respaldo, usar con cuidado): listá 0-4 términos del PRODUCTO ESPECÍFICO que el cliente fabrica/vende y que, si aparecen en el NOMBRE de otra empresa, casi seguro la delatan como proveedor o competidor (ej. "explosivos", "detonadores", "voladura", "staffing", "proptech"). REGLA CRÍTICA: NO pongas el VERTICAL/industria donde el cliente VENDE: si vende software inmobiliario NO pongas "inmobiliaria"; si le vende a minería NO pongas "minería"; eso descartaría a tus propios compradores. Solo el nombre del producto en sí. Ante la duda, dejá la lista vacía.
- LARGO (para que el overview entre en 1 página): lead = MÁX 2 oraciones; proof = MÁX 2 oraciones; cada bullet de context = 1 oración corta (máx ~140 caracteres). Sé conciso.
- _plan.titulos_objetivo es CRÍTICO: el sistema rankea y BUSCA con estas palabras (una por una) dentro del cargo. Palabras SUELTAS (no frases), ES+inglés+abreviaturas. Pensá DOS tipos de comprador y poné términos de AMBOS: (a) el que CONSUME el servicio puertas adentro (operaciones, facilities, mantenimiento, servicios generales, administrador); y (b) el que dentro de la empresa-canal OWNS la línea de producto/relación que mapea con lo que vende el cliente (el comprador de canal). Para (b), usá el NOMBRE del producto/vertical del cliente tal como aparece en cargos del comprador: ej. para una empresa de asistencia domiciliaria, los que en una aseguradora/retailer manejan "hogar", "asistencia", "vivienda", "copropiedad", "siniestros", "líneas personales", "proveedores". NO te quedes solo con los roles de facilities: el comprador de canal (ej. el jefe de línea hogar de una aseguradora) suele ser la mejor cuenta. Si el ICP apunta a empresas chicas donde compra el dueño/CEO, incluí "ceo, founder, owner, dueño, fundador". ORDEN: poné PRIMERO los términos del comprador de canal/producto (b) y después los de facilities (a); el sistema usa los primeros, así que los más valiosos van al frente.

## Output — SOLO JSON (sin texto ni markdown alrededor)
{
  "fecha": "Mes Año (la de hoy)",
  "eyebrow": "Análisis de mercado · ... (uppercase corto)",
  "h1_pre": "",
  "h1_company": "Nombre del cliente (resaltado, va primero)",
  "h1_post": "${N} clientes potenciales en [País o región]",
  "lead": "Máx 2 oraciones anclando el proof point REAL del cliente.",
  "proof": "El proof point / origen del cliente (máx 2 oraciones).",
  "ribbon": [ {"label":"Vertical","value":"..."}, {"label":"País","value":"..."}, {"label":"Modelo","value":"..."} ],
  "stats": [ {"num":"...","label":"..."}, {"num":"${N}","label":"Cuentas priorizadas"}, {"num":"...","label":"..."}, {"num":"...","label":"..."} ],
  "icp": [ {"title":"Rol del decisor","desc":"..."}, {"title":"Tamaño de empresa","desc":"..."}, {"title":"Geografía","desc":"..."}, {"title":"Vertical / industria","desc":"..."} ],
  "context": [ "bullet 1 (corto)", "bullet 2 (corto)", "bullet 3 (corto)" ],
  "apertura": [ "hook 1", "hook 2", "hook 3" ],
  "prioridades": [ "Alta: ...", "Media: ...", "...", "..." ],
  "_plan": { "funcion": "función del comprador en 1-2 palabras", "titulos_objetivo": ["PALABRAS SUELTAS del cargo de quien COMPRA: roles de facilities (operaciones, mantenimiento, administrador) Y roles del producto/canal del cliente (ej. hogar, asistencia, vivienda, copropiedad), ES+EN+abreviaturas"], "geografia": "el país real del cliente (prioritario)", "geografias": ["País del cliente PRIMERO, después SOLO países donde el cliente HOY opera"], "industrias": ["VERTICALES ANCLA donde se COMPRA/revende el producto, ej: Seguros, Comercio al por menor, Inmobiliario, Administración de propiedades, Banca (evitá industriales amplias tipo Construcción/Manufactura)"], "competidores": ["NOMBRES de empresas competidoras directas a EXCLUIR (que venden lo mismo que el cliente), ej: Iké Asistencia, Asissprex"], "competidor_terminos": ["0-4 términos del PRODUCTO que delatan a un proveedor/competidor en el nombre de su empresa, ej: explosivos, voladura, staffing; NUNCA el vertical donde el cliente vende"], "tamano_min": 200 }
}
CANTIDADES EXACTAS: ribbon 3, stats 4, icp 4, context 3, apertura 3, prioridades 4. NADA fuera del objeto JSON.`; }

async function runPlan({ empresa, dominio, email, nombre, cliente, fechaHoy }){
  _setStage('gen');
  const bloqueCliente = (cliente && cliente.anclado)
    ? `\n\nDATOS VERIFICADOS DEL CLIENTE (NO inventes otra empresa, usá ESTOS): Empresa: ${cliente.empresa}; Tamaño: ${cliente.headcount ?? '?'} empleados${cliente.tier ? ` (tier ${cliente.tier})` : ''}.`
    : '';
  const messages = [{ role:'user', content:`Cliente a analizar:\n- Empresa: ${empresa}\n- Dominio: ${dominio}\n- Email contacto: ${email}\n- Nombre contacto: ${nombre}${bloqueCliente}\n\nFecha de hoy (usala en "fecha"): ${fechaHoy}\n\nInvestigá la empresa con web_search y devolvé SOLO el JSON del schema.` }];
  const MAX = parseInt(process.env.PLAN_MAX_TOOL_ITERS || '8', 10);
  let it=0, cerrar=false;
  while(true){
    const data = await callClaude({ model:MODEL_GEN, system:_promptPlan(NUM_CUENTAS), messages, tools: cerrar?[]:[WEB_SEARCH_TOOL], maxTokens:8000 });
    contarYLoguearWebSearch(data, 'PLAN');
    messages.push({ role:'assistant', content:data.content });
    if(data.stop_reason==='pause_turn') continue; // turno largo de web_search: reanudar el turno
    if(data.stop_reason==='end_turn' || data.stop_reason==='stop_sequence')
      return parseReporteJSON(_textoJSON(data.content));
    if(data.stop_reason==='tool_use'){
      const tr=[]; for(const b of data.content){ if(b.type!=='tool_use') continue; tr.push({type:'tool_result',tool_use_id:b.id,content:await callMCP(b.name,b.input)}); }
      it++; if(it>=MAX) cerrar=true;
      if(tr.length){ if(cerrar) tr.push({type:'text',text:'Suficiente research. Devolvé YA el JSON.'}); messages.push({role:'user',content:tr}); }
      else return parseReporteJSON(_textoJSON(messages.filter(m=>m.role==='assistant').pop()?.content));
    }
  }
}

// FASE 3 — IA: elige + escribe. Prompt parametrizado por (pedir, usar).
function _promptSelect(pedir, usar){ return `# IBT GTM — Fase SELECT (elegir + escribir)

Te paso una LISTA REAL de candidatos (gente que existe, con su id, nombre, cargo textual, empresa, país y grado de conexión) y el contexto del cliente. Elegís los ${pedir} MEJORES decisores EN ORDEN de prioridad (el mejor primero) y escribís, para cada uno, un ángulo y un hook. El sistema usa los primeros ${usar} válidos.

## Cómo elegir (en este orden)
1. FIT de función (LO MÁS IMPORTANTE): el cargo tiene que ser CLARAMENTE del rol que compra lo del cliente. PROHIBIDO elegir gente de OTRA área que la del comprador: si el comprador es de Operaciones/Facilities/Mantenimiento/Administración, NO elijas a nadie de Marketing/Mercadeo/Ventas/Comercial/RR.HH./Finanzas, POR MÁS que la empresa sea una marca top. Un cargo suelto sin función clara ("Mercadeo", "Analista", "Coordinador" a secas) NO sirve. Un "CEO/Dueño" de empresa chica sí sirve porque ahí decide. MEJOR devolver MENOS cuentas (o repetir vertical) que UNA sola de función equivocada: una cuenta mal apuntada quema todo el reporte.
2. PAÍS: preferí candidatos del PAÍS DEL CLIENTE (van marcados con ★ y vienen primero en la lista). Elegí de otro país de LatAm SOLO si no hay suficientes buenos del país del cliente. NUNCA elijas a alguien de un país donde el cliente no puede prestar el servicio.
3. Decisor real: nada de analistas, trainees ni juniors.
4. Empresa ANCLA con fit de ICP: usá los "~N empleados" que te muestro para juzgar el TAMAÑO. Marca grande y conocida emociona; startup desconocida de 8 personas no. Pero si el ICP son PyMEs, una empresa enorme NO sirve aunque sea famosa: priorizá el FIT real. TAMAÑO (con matiz): a igual fit de función, país y vertical, PREFERÍ las empresas que cumplen el piso de tamaño del ICP por encima de las más chicas. EVITÁ las claramente micro (prácticamente un individuo, ej. 1 a 4 empleados cuando el ICP pide empresas/agencias con equipo) SIEMPRE QUE haya alternativas mejores on-vertical en la lista. PERO el tamaño NO es excluyente: un lead fuerte en los demás ejes (país correcto, rol claramente decisor, on-vertical, contacto cálido) en una empresa SOLO un poco por debajo del piso SÍ sirve y se puede elegir. No descartes un buen decisor por quedar apenas corto de tamaño; descartá solo los casos obviamente micro cuando existen mejores opciones.
5. Coherencia / credibilidad: si cargo+empresa+ubicación se ve raro, no la elijas.
6. Grado de conexión: a IGUAL fit y país, preferí SIEMPRE el grado más cálido (1er o 2do grado por encima de 3ro o fuera de red): un 2do grado acepta y responde mucho más porque comparten un contacto. Nunca sacrifiques fit por grado, pero entre candidatos parecidos, el más cálido gana.

## Reglas DURAS
- Elegí SOLO ids que estén en la lista. PROHIBIDO inventar una persona, un id, un cargo o una empresa.
- LOS ${pedir} ids tienen que ser DISTINTOS. Prohibido repetir la misma persona.
- EMPRESAS DISTINTAS: cada cuenta es de una empresa DIFERENTE. Si dos son de la misma empresa, quedate con el de mejor fit y completá con otra empresa.
- PROHIBIDO inventar o inflar el cargo: usá EXACTAMENTE el que figura en la lista. Si dice "Project Manager", es "Project Manager" — no lo asciendas a "Manager de Mantenimiento" ni le inventes MBA, estudios, especialidad ni un rol que no está. No le atribuyas datos (seniority, área, formación) que no estén en lo que te paso.
- CADA uno DEBE tener angulo y hook NO vacíos.
- El ÁNGULO: MÁXIMO 2 oraciones (≤ 320 caracteres), específico de ESA persona/empresa, usando su cargo/empresa/perfil REALES + lo que ofrece el cliente. Corto y al hueso, sin relleno. 100% único por persona.
- PROHIBIDO copiar/pegar o calcar la estructura de un ángulo a otro. Antes de cerrar, revisá que el nombre y la empresa de cada ángulo sean los de ESE id.
- El HOOK: UNA sola oración entre comillas, lista para mandar, empezando por el PRIMER NOMBRE (ej: "Clara, ..."). Los hooks NO pueden compartir la misma fórmula entre sí: cada uno arranca distinto y nombra un pain o contexto CONCRETO y DIFERENTE. Si los releés y suenan iguales, reescribilos.
- NUNCA menciones el grado de conexión (1er/2do/3er grado) ni inventes datos que no estén en lo que te paso.
- IDIOMA: ángulo y hook en ESPAÑOL NEUTRO latinoamericano, trato de "usted". Sin voseo ni modismos argentinos.
- Texto plano: NADA de markdown (sin **negritas**, sin asteriscos). Solo el objeto JSON.
- SIN GUIONES: NUNCA uses guiones largos (—) ni guiones (-) como conectores o incisos en el ángulo ni en el hook. Usá comas, paréntesis o dos puntos. El texto tiene que sonar a persona, no a IA.
- ESTILO HUMANO (sutil): los hooks se mandan como si los escribiera una persona real, no una IA impecable. Está bien (y preferible) que ALGÚN hook corto no termine en punto, o que una pregunta casual vaya sin el signo de cierre "?", como cuando uno escribe rápido por chat. Que sea SUTIL y OCASIONAL: a lo sumo UN detalle así por hook, NUNCA en todos. PROHIBIDO errores de ortografía, palabras mal escritas o mayúsculas raras: lo único "relajado" permitido es esa puntuación final blanda. El mensaje tiene que verse profesional y creíble, solo que humano.
- COMPETIDORES: NO elijas personas de empresas que sean COMPETIDORAS directas del cliente (que vendan/ofrezcan lo mismo). Preferí empresas que serían CLIENTES del cliente, no rivales.

## Output — SOLO JSON (sin texto alrededor)
{ "seleccion": [ {"id":"<id EXACTO de la lista>", "angulo":"...", "hook":"\\"...\\""} ] }
EXACTAMENTE ${pedir} elementos distintos, en orden de prioridad. NADA fuera del objeto JSON.

## JSON VÁLIDO (CRÍTICO — si el JSON no parsea, se pierde todo el trabajo)
- Dentro de "angulo" y "hook" NO uses comillas dobles (") sin escapar. Si necesitás encomillar una palabra o frase dentro del texto, usá comillas simples ('algo') o ninguna. Las ÚNICAS comillas dobles del hook son las dos que lo envuelven (\\"...\\").
- NO uses puntos suspensivos "..." literales, ni saltos de línea, ni tabs dentro de los valores.
- Escribí cada valor en UNA línea. Antes de responder, verificá mentalmente que cada "{", "[", "\\"" tenga su cierre y que no haya comas colgando.`; }

async function runSelectWrite({ cliente, plan, pool, fixes }){
  _setStage('gen');
  if(!pool || !pool.length) return [];   // sin candidatos no hay nada que elegir (evita parsear prosa)
  const lista = pool.map((p,i)=>{
    const tam = p.headcount!=null ? ` (~${p.headcount} empleados)` : '';
    const ctx = (p.headRich && p.headRich!==p.head) ? ` | perfil: ${p.headRich}` : '';
    const loc = p.loc ? ` | ${p.loc}` : '';
    const home = p.cerca ? ' ★(país del cliente)' : '';
    return `${i+1}. id=${p.id} | ${p.name} | ${p.head} | empresa: ${p.empresa||'?'}${tam}${loc}${home} | grado ${p.dist===9?'fuera de red':p.dist+'°'}${ctx}`;
  }).join('\n');
  const _pisoTam = (plan._plan && parseInt(plan._plan.tamano_min||0,10)) || 0;
  const ctx = `Cliente: ${(cliente&&cliente.empresa)||plan.h1_company||''}. País del cliente (prioritario): ${(plan._plan&&plan._plan.geografia)||''}. Qué ofrece / proof: ${String(plan.proof||plan.lead||'').slice(0,500)}. Función del comprador: ${(plan._plan&&plan._plan.funcion)||''}.${_pisoTam>0?` Piso de tamaño del ICP: ${_pisoTam}+ empleados (preferí empresas que lo cumplen; evitá las claramente micro salvo que el lead sea fuerte en los demás ejes).`:''}`;
  const fixBloque = (fixes&&fixes.length) ? `\n\nCORRECCIONES del juez (aplicalas re-eligiendo o reescribiendo):\n- ${fixes.join('\n- ')}` : '';
  const messages = [{ role:'user', content:`${ctx}\n\nLISTA REAL DE CANDIDATOS (elegí de ACÁ, por id EXACTO; los ★ son del país del cliente):\n${lista}${fixBloque}\n\nElegí los ${PEDIR_SELECT} MEJORES en ORDEN de prioridad (el mejor primero), de EMPRESAS distintas y priorizando el país del cliente. Devolvé SOLO el JSON {"seleccion":[...]} con EXACTAMENTE ${PEDIR_SELECT} elementos distintos. El sistema arma el reporte con los primeros ${NUM_CUENTAS} válidos, así que los primeros ${NUM_CUENTAS} tienen que ser tus mejores.` }];
  const data = await callClaude({ model:MODEL_GEN, system:_promptSelect(PEDIR_SELECT, NUM_CUENTAS), messages, tools:[], maxTokens:6000 });
  try{
    const j = parseReporteJSON(_textoJSON(data.content));
    return Array.isArray(j && j.seleccion) ? j.seleccion : [];
  }catch(e){
    console.warn(`[SELECT] JSON inválido del modelo (${e.message}). Devuelvo [] para que seleccionarConRetry reintente.`);
    return [];
  }
}

// Ensamblado: HECHOS del pool (código); la IA solo aportó id + ángulo + hook.
// Quita guiones largos/medios y guiones-conector del texto generado por la IA,
// para que suene humano y no "de IA". Convierte incisos "—x—" en "(x)" y conectores en coma.
function _sinGuiones(s){
  if(s==null) return s;
  let t = String(s);
  t = t.replace(/\s*[—–]\s*([^—–]+?)\s*[—–]\s*/g, ' ($1) ');
  t = t.replace(/^\s*[—–]\s*/, '');
  t = t.replace(/\s*[—–]\s*/g, ', ');
  t = t.replace(/\s+-\s+/g, ', ');
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:?!)])/g, '$1').replace(/\(\s+/g, '(').replace(/,\s*,/g, ',').replace(/\s+,/g, ',').trim();
  return t;
}
// Suaviza números fabricados típicos (conteos de servicios/categorías/clientes y tiempos sin fuente),
// que la IA a veces inventa pese a la instrucción. Solo prosa; NO toca stats ni ICP.
function _sinInventos(s){
  if(s==null) return s;
  let t = String(s);
  t = t.replace(/(?:\+|m[áa]s de|cerca de|alrededor de|unos?)\s*\d[\d.,]*\s*(tipos|categor[ií]as|clases)\s+de\s+servicios?/gi, 'múltiples $1 de servicio');
  t = t.replace(/\b\d{3,}\s*(tipos|categor[ií]as|clases)\s+de\s+servicios?/gi, 'múltiples $1 de servicio');
  t = t.replace(/(?:\+|m[áa]s de|cerca de|alrededor de)\s*\d[\d.,]{3,}\s*(servicios|clientes|usuarios|atenciones|operaciones|hogares|empresas)\b/gi, 'miles de $1');
  t = t.replace(/(en\s+)?(menos de\s+)?(una|[0-9]+)\s*(hora|minuto)s?\b/gi, (m)=> /hora|minuto/i.test(m) ? 'en tiempos de respuesta cortos' : m);
  t = t.replace(/\s{2,}/g,' ').replace(/\s+([,.;:?!])/g,'$1').trim();
  return t;
}
const _limpia = s => _sinInventos(_sinGuiones(s));
// Acorta un headline de LinkedIn relleno de keywords al segmento más relevante
// (el que menciona la función objetivo), sin inventar nada.
function _cargoCorto(head, kws){
  let raw = String(head||'').split('@')[0].replace(/\s{2,}/g,' ').trim();
  raw = raw.replace(/\bc-\s+level\b/gi,'C-level'); // "C- level" -> "C-level"
  const cap = s => (s.length > 70 ? s.slice(0,70).trim() : s);
  // Separar en segmentos por | • · / , y por " - " (guion con espacios). Los títulos
  // bien formados quedan en un solo segmento; los headlines keyword-salad se trocean.
  const segs = raw.split(/\s*[|•·\/,]\s*|\s+-\s+/).map(s=>s.trim()).filter(Boolean);
  if(segs.length <= 1) return cap(raw);
  const kwl = (kws||[]).map(k=>_norm(k)).filter(k=>k.length>=3);
  const matchKw = s => kwl.some(k => _norm(s).includes(k));
  const esRol = s => /(?:c-?\s*level|chief|\bceo\b|\bcoo\b|\bcfo\b|\bcto\b|\bcmo\b|\bcuo\b|director|gerente|subgerente|jefe|jefa|\bhead\b|\bvp\b|vicepresid|vice president|founder|owner|dueno|presidente|lider|leader|coordinador|manager|responsable|encargad|administrador|superintendente)/.test(_norm(s));
  // 1) Si el primer segmento ya es un título con rol, usalo (los títulos arrancan con el rol).
  //    Si ese rol no nombra el área del cliente pero hay un segmento que sí, lo anexa.
  if(esRol(segs[0])){
    let out = segs[0];
    if(!matchKw(out)){
      const area = segs.slice(1).find(matchKw);
      if(area && (out.length + area.length) <= 48) out = `${out}, ${area}`;
    }
    return cap(out);
  }
  // 2) Headline tipo keyword-salad: priorizá el segmento que matchea el producto/canal,
  //    y si hay un segmento de rol distinto, combiná rol + área.
  const kwSeg = segs.find(matchKw);
  const rolSeg = segs.find(esRol);
  let best;
  if(rolSeg && kwSeg && rolSeg !== kwSeg && (rolSeg.length + kwSeg.length) <= 48) best = `${rolSeg}, ${kwSeg}`;
  else best = kwSeg || rolSeg || segs[0];
  return cap(best);
}
// ¿El cargo muestra la función objetivo o es un decisor genérico? Si no (ej. "Mercadeo", "Analista"
// suelto cuando el comprador es Operaciones/Facilities), se descarta la card.
function _rolRelevante(cargo, titulos){
  const c = _norm(cargo);
  const kws = (titulos||[]).map(k=>_norm(k)).filter(k=>k.length>=3);
  if(kws.some(k=>c.includes(k))) return true;
  const jefes = ['gerente','director','jefe','jefa','head','vp','vice','chief','ceo','coo','cfo','cto','founder','owner','dueno','propietario','presidente','lider','leader','coordinador','coordinadora','manager','responsable','encargado','encargada','administrador','administradora','superintendente'];
  return jefes.some(j=>c.includes(j));
}

function armarReporte(plan, seleccion, pool){
  const titulos = (plan._plan && plan._plan.titulos_objetivo) || [];
  const byId = new Map(pool.map(p=>[p.id, p]));
  const cards=[]; const usados=new Set(); const usadasEmp=new Set();
  for(const s of (seleccion||[])){
    if(cards.length >= NUM_CUENTAS) break;
    const p = byId.get(s.id);
    if(!p){ console.warn(`[SELECT] id fuera del pool, ignorado: ${s.id}`); continue; }
    if(usados.has(s.id)){ console.warn(`[SELECT] id DUPLICADO, ignorado: ${p.name}`); continue; }
    const angulo=String(s.angulo||'').trim(), hook=String(s.hook||'').trim();
    if(!angulo || !hook){ console.warn(`[SELECT] card sin ángulo/hook, descartada: ${p.name}`); continue; }
    const empresa = p.empresa || _empresaDeHeadline(p.head) || '';
    if(!empresa){ console.warn(`[SELECT] card sin empresa real, descartada: ${p.name}`); continue; }

    // --- GUARDA DE FUNCIÓN: el cargo tiene que mostrar la función objetivo o ser un decisor ---
    if(!_rolRelevante(String(p.head||'').split('@')[0], titulos)){
      console.warn(`[SELECT] card DESCARTADA por FUNCIÓN equivocada/irrelevante: ${p.name} ("${String(p.head||'').slice(0,50)}")`);
      continue;
    }

    // --- GUARD ANTI-MEZCLA: el ángulo/hook tienen que ser de ESTA persona/empresa ---
    const primerNombre = (_norm(p.name).split(' ')[0]) || '';
    const hookN = _norm(hook), angN = _norm(angulo), empN = _norm(empresa);
    const hookNombra = primerNombre.length >= 3 && hookN.includes(primerNombre);
    const empTokens = empN.split(' ').filter(w => w.length >= 4);
    const angCoherente = (primerNombre.length >= 3 && angN.includes(primerNombre)) || empTokens.some(w => angN.includes(w));
    if(!hookNombra || !angCoherente){
      console.warn(`[SELECT] card DESCARTADA por MEZCLA (no corresponde a ${p.name} @ ${empresa}) | hook="${hook.slice(0,70)}"`);
      continue;
    }
    // --- fin guards ---

    const empKey = _empKey(empresa);
    if(empKey && usadasEmp.has(empKey)){ console.warn(`[SELECT] empresa DUPLICADA, ignorada: ${p.name} @ ${empresa}`); continue; }
    usados.add(s.id);
    if(empKey) usadasEmp.add(empKey);
    cards.push({
      empresa, nombre: p.name, cargo: _cargoCorto(p.head, titulos),
      urn: p.id, slug: _slugCos(p.name),
      ubicacion: p.loc || ((plan._plan && plan._plan.geografia) || ''),
      grado: _degOrdinal(p.dist===9?3:p.dist, '2do') + ' grado',
      headcount: (p.headcount ?? null),
      angulo: _limpia(angulo), hook: _limpia(hook)
    });
  }
  if(cards.length < NUM_CUENTAS) console.warn(`[SELECT] ⚠️ solo ${cards.length}/${NUM_CUENTAS} cards válidas tras dedupe/guards.`);
  const { _plan, ...base } = plan;
  if(!base.empresa) base.empresa = base.h1_company || '';
  // Limpieza de guiones + números inventados en TODO el texto generado de página 1.
  for(const f of ['lead','proof','h1_post']) if(typeof base[f]==='string') base[f]=_limpia(base[f]);
  if(Array.isArray(base.context))     base.context     = base.context.map(_limpia);
  if(Array.isArray(base.apertura))    base.apertura    = base.apertura.map(_limpia);
  if(Array.isArray(base.prioridades)) base.prioridades = base.prioridades.map(_limpia);
  if(Array.isArray(base.icp))         base.icp         = base.icp.map(o => (o && typeof o.desc==='string') ? {...o, desc:_limpia(o.desc)} : o);
  return { ...base, cards };
}

function _cardCompleta(c){
  return !!c && ['nombre','empresa','cargo','angulo','hook'].every(k => String(c[k]||'').trim().length > 0);
}
function _cuentaCompletas(data){
  return (((data && data.cards) || []).filter(_cardCompleta)).length;
}

// --- GEO-COHERENCIA (determinística) ------------------------------------------
// Países que el reporte puede nombrar (LatAm + España/EEUU). Forma normalizada (sin tildes).
const _PAISES = [
  'mexico','guatemala','el salvador','honduras','nicaragua','costa rica','panama',
  'colombia','venezuela','ecuador','peru','bolivia','chile','argentina','uruguay',
  'paraguay','brasil','republica dominicana','puerto rico','cuba',
  'espana','estados unidos','eeuu','usa'
];
// Devuelve la lista de países (normalizados) que aparecen mencionados en un texto.
function _paisesDeTexto(txt){
  const t = _norm(txt);
  if(!t) return [];
  // "espanol/a" NO debe contar como "espana": exigimos límite de palabra al final.
  return _PAISES.filter(p => new RegExp(`\\b${_esc(p)}\\b`).test(t));
}
// Compara el país de cada card contra el país objetivo del reporte (título h1_post + ICP "Geografía").
// Devuelve null si todo coherente; o { objetivo:[...], fuera:[...] } si alguna card está en otro país.
function _geoIncoherente(data){
  if(!data) return null;
  const objetivo = new Set();
  for(const p of _paisesDeTexto(data.h1_post)) objetivo.add(p);
  const icpGeo = (data.icp||[]).find(o => o && /geograf/.test(_norm(o.title||o.titulo||'')));
  if(icpGeo) for(const p of _paisesDeTexto(icpGeo.desc)) objetivo.add(p);
  if(!objetivo.size) return null; // sin país objetivo reconocible no podemos juzgar → no bloquear
  const fuera = [];
  for(const c of (data.cards||[])){
    const paisesCard = _paisesDeTexto(c.ubicacion);
    if(!paisesCard.length) continue; // ubicación sin país reconocible → no bloquear por esta card
    if(!paisesCard.some(p => objetivo.has(p))){
      fuera.push(`${c.nombre||'?'} (${c.empresa||'?'}) figura en "${c.ubicacion}", fuera del/los país(es) objetivo del reporte (${[...objetivo].join(', ')}).`);
    }
  }
  return fuera.length ? { objetivo:[...objetivo], fuera } : null;
}

// --- TAMAÑO-COHERENCIA (determinística, análoga a geo) ------------------------
// Compara el headcount real de cada card final contra el tamano_min del ICP.
// OPCIÓN B (decisión de producto): el tamaño es señal de VALOR, no de credibilidad. Solo bloquea lo EGREGIO:
// empresas a MENOS del 25% del piso (prácticamente un individuo/micro-agencia). Entre 25% y 100% del piso NO
// rechaza (el lead pasa; el tamaño solo baja el ranking en el sourcing). Si el ICP no define tamano_min (>0),
// no juzga (devuelve null). Enriquece el headcount faltante de las cards finales (get_contact_profile no gasta
// créditos); si no se puede determinar, fail-open por card (no bloquea por lo desconocido).
async function _tamanoIncoherente(data, plan){
  if(!data) return null;
  const tamMin = parseInt((plan && plan._plan && plan._plan.tamano_min) || 0, 10) || 0;
  if(tamMin <= 0) return null;                 // sin piso declarado no podemos juzgar → no bloquear
  const piso = Math.round(tamMin * 0.25);      // margen: solo bloquea lo egregio (menos del 25% del piso)
  const fuera = [];
  for(const c of (data.cards||[])){
    let hc = (c.headcount != null) ? c.headcount : null;
    if(hc == null && c.urn){
      try{ hc = _parseProfile(await callMCP('get_contact_profile', { publicIdOrUrl: c.urn })).headcount; }catch{}
    }
    if(hc != null && hc < piso){
      fuera.push(`${c.nombre||'?'} (${c.empresa||'?'}) trabaja en una empresa de ~${hc} empleados, muy por debajo del piso del ICP (menos del 25% de ${tamMin}+).`);
    }
  }
  return fuera.length ? { tamMin, fuera } : null;
}

async function seleccionarConRetry({ cliente, plan, pool, fixes }){
  const MIN = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
  const MAX = parseInt(process.env.SELECT_MAX_TRIES || '3', 10);
  let best=null, bestN=-1;
  for(let i=1;i<=MAX;i++){
    const extra = i>1 ? [`INTENTO ${i}: el intento previo no llegó a ${MIN} cuentas completas. Devolvé ${PEDIR_SELECT} ids EXACTOS de la lista (copiá el id tal cual), todos distintos, de EMPRESAS distintas y priorizando el país del cliente, cada uno con empresa real + ángulo + hook.`] : [];
    const seleccion = await runSelectWrite({ cliente, plan, pool, fixes: (fixes||[]).concat(extra) });
    const data = armarReporte(plan, seleccion, pool);
    const n = _cuentaCompletas(data);
    if(n > bestN){ best=data; bestN=n; }
    if(n >= MIN){ if(i>1) console.log(`[SELECT] OK en intento ${i}: ${n} cards completas.`); return data; }
    console.warn(`[SELECT] intento ${i}: ${n}/${MIN} cards completas — ${i<MAX?'reintento':'sin más reintentos'}.`);
  }
  return best;
}

function _fechaHoy(){
  const meses=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const d=new Date(); return `${meses[d.getMonth()]} ${d.getFullYear()}`;
}
function _nombreArchivoPDF(empresa){
  const limpia = String(empresa||'Empresa').replace(/[\\/:*?"<>|]/g,'').replace(/\s+/g,' ').trim() || 'Empresa';
  return `Análisis de Mercado - ${limpia}.pdf`;
}

async function procesar(jobId, { email, dominio, empresa, nombre, profileId }) {
  return _statsALS.run(_nuevoStats(), async () => {
  try {
    console.log(`\n========== Job ${jobId} - Inicio (${NUM_CUENTAS} cuentas) ==========`);
    console.log(`Empresa: ${empresa} | Email: ${email} | Dominio: ${dominio} | profileId: ${profileId ?? '-'}`);

    const cliente = await resolverCliente({ profileId, dominio, empresa });
    const empresaFinal = cliente.empresa || empresa;

    const fechaHoy = _fechaHoy();
    const plan = await runPlan({ empresa: empresaFinal, dominio, email, nombre, cliente, fechaHoy });
    const pool = await sourceCandidates(plan, cliente);
    if (!pool.length) throw new Error(`Sourcing devolvió 0 candidatos (geo=${(plan._plan&&plan._plan.geografia)||'?'}, industrias=[${((plan._plan&&plan._plan.industrias)||[]).join(', ')||'-'}]). Revisar términos de rol / industria / geografía.`);
    let data = await seleccionarConRetry({ cliente, plan, pool });

    let cleanHtml = limpiarHtml(renderReport(data));
    if (!cleanHtml) throw new Error('No se pudo renderizar el reporte');

    // El juez evalúa el HTML; el PDF se genera una sola vez al final y SOLO si queda apto.
    let judgeResult = await runJudge(cleanHtml, null);

    // Si el juez rechaza, reintenta re-seleccionando con los fixes. NO se renderiza PDF en
    // el medio: solo HTML + juez. Configurable con MAX_FIX_ITERS (default 1).
    const MAX_FIX = parseInt(process.env.MAX_FIX_ITERS || '1', 10);
    for (let intento = 1; intento <= MAX_FIX && judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0; intento++) {
      console.log(`[Job ${jobId}] Juez rechazó ${judgeResult.score}/8 — fix ${intento}/${MAX_FIX}...`);
      try {
        const fixedData = await seleccionarConRetry({ cliente, plan, pool, fixes: judgeResult.fixes });
        if (_cuentaCompletas(fixedData) < _cuentaCompletas(data)) {
          console.warn(`[FIX] el fix dio menos cards completas — conservo el previo y corto.`);
          break;
        }
        data = fixedData;
        cleanHtml = limpiarHtml(renderReport(data));
        console.log(`[Job ${jobId}] Re-validando con el juez...`);
        judgeResult = await runJudge(cleanHtml, null);
      } catch (e) {
        console.warn(`[FIX] Falló, conservo el reporte previo:`, e.message);
        break;
      }
    }

    const MIN_CARDS_OK = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
    const cardsValidas = _cuentaCompletas(data);
    if (cardsValidas < MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO') {
      console.warn(`[INTEGRIDAD] Override: juez dijo APROBADO con ${cardsValidas}/${MIN_CARDS_OK} cards completas → RECHAZADO.`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 5),
        fixes: [`Reporte INCOMPLETO: ${cardsValidas}/${MIN_CARDS_OK} cuentas completas. Faltan decisores reales con empresa, cargo, ángulo y hook — el sourcing/selección debe entregar ${MIN_CARDS_OK}.`].concat(judgeResult.fixes||[]) };
    }
    const geoMal = _geoIncoherente(data);
    if (geoMal) {
      console.warn(`[GEO] Incoherencia país: objetivo=[${geoMal.objetivo.join(', ')}] | ${geoMal.fuera.join(' ')}`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
        fixes: [`GEO INCOHERENTE: el reporte apunta a ${geoMal.objetivo.join(', ')} pero hay cuentas en otro país. ${geoMal.fuera.join(' ')} Las cuentas deben estar en el/los país(es) del título e ICP, o hay que ajustar el título/ICP al país real de las cuentas.`].concat(judgeResult.fixes||[]) };
    }
    const tamMal = await _tamanoIncoherente(data, plan);
    if (tamMal) {
      console.warn(`[TAM] Incoherencia tamaño (egregio, <25% del piso): piso ${tamMal.tamMin}+ | ${tamMal.fuera.join(' ')}`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
        fixes: [`TAMAÑO INCOHERENTE: el ICP pide empresas de ${tamMal.tamMin}+ empleados pero hay cuentas MUY por debajo (menos del 25% del piso, prácticamente un individuo). ${tamMal.fuera.join(' ')} Reemplazá esas cuentas por empresas que cumplan el tamaño del ICP, o ajustá el título/ICP al tamaño real de las cuentas.`].concat(judgeResult.fixes||[]) };
    }
    const aptoEnvio = cardsValidas >= MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO';
    const descartadas = [];
    console.log(aptoEnvio
      ? `[INTEGRIDAD] OK: ${cardsValidas} cards completas + juez APROBADO.`
      : `[INTEGRIDAD] ⚠️ NO apto: ${cardsValidas}/${MIN_CARDS_OK} completas, juez ${judgeResult.veredicto}.`);

    // El PDF se renderiza una sola vez y SOLO si el reporte quedó apto. Si está rechazado
    // no se genera y el job no expone pdf_base64, así n8n no tiene nada que mandar.
    let pdfBuffer = null, pageCount = null;
    if (aptoEnvio) {
      pdfBuffer = await renderizarPdf(cleanHtml);
      pageCount = await contarPaginas(pdfBuffer);
    }

    logTokenCost(`Job ${jobId}`);

    jobs.set(jobId, {
      status: 'ok',
      pdf_base64: pdfBuffer ? pdfBuffer.toString('base64') : null,
      empresa: empresaFinal,
      anclado: cliente.anclado,
      cliente_resuelto: cliente,
      apto_envio: aptoEnvio,
      cards_validas: cardsValidas,
      cards_descartadas: descartadas,
      nombre, email,
      pdf_filename: _nombreArchivoPDF(empresaFinal),
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: [], links_no_resueltos: [], grados_corregidos: [], grados_mal: [],
      tokens: { ..._stats().total },
      tokens_input: _stats().total.input, tokens_output: _stats().total.output,
      tokens_cache_write: _stats().total.cache_write, tokens_cache_read: _stats().total.cache_read,
      finishedAt: Date.now()
    });
    console.log(`========== Job ${jobId} - ${aptoEnvio ? `OK ${pageCount} páginas` : 'NO apto (sin PDF)'}, juez FINAL ${judgeResult.veredicto} ${judgeResult.score}/8 ==========\n`);
  } catch (err) {
    console.error(`[Job ${jobId}] Error:`, err);
    jobs.set(jobId, { status: 'error', error: err.message, finishedAt: Date.now() });
  }
  });
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

const jobs = new Map();
// Dedup anti doble-disparo: leadKey -> jobId EN CURSO. Si el mismo lead se dispara dos veces
// (re-fire de n8n, doble click, retry de red), reutilizamos el job en vez de generar otro reporte.
const enProgreso = new Map();
function _leadKey({ profileId, dominio, email, empresa }) {
  return String(profileId || dominio || email || empresa || '').trim().toLowerCase();
}

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

  // IDEMPOTENCIA: si ya hay un job EN CURSO para este mismo lead, devolvemos ESE jobId
  // (deduplicado:true) en vez de arrancar otro. Evita reportes duplicados y doble envío.
  const key = _leadKey({ profileId, dominio, email, empresa });
  if (key && enProgreso.has(key)) {
    const jobPrevio = enProgreso.get(key);
    const j = jobs.get(jobPrevio);
    if (j && j.status === 'processing') {
      console.log(`[DEDUP] Lead "${key}" ya en proceso (job ${jobPrevio}). No se arranca otro.`);
      return res.status(202).json({ jobId: jobPrevio, status: 'processing', deduplicado: true });
    }
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'processing', createdAt: Date.now() });
  if (key) enProgreso.set(key, jobId);
  res.status(202).json({ jobId, status: 'processing' });
  procesar(jobId, { email, dominio, empresa: empresa || dominio, nombre: nombre || '', profileId })
    .finally(() => { if (key && enProgreso.get(key) === jobId) enProgreso.delete(key); });
});

app.get('/resultado/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
  res.json(job);
});

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio, empresa, nombre, profileId, eval: evalMode, debug } = req.body || {};
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  await _statsALS.run(_nuevoStats(), async () => {
  try {
    const cliente = await resolverCliente({ profileId, dominio, empresa: empresa || dominio });
    const empresaFinal = cliente.empresa || empresa || dominio;
    const fechaHoy = _fechaHoy();
    const plan = await runPlan({ empresa: empresaFinal, dominio, email, nombre: nombre || '', cliente, fechaHoy });
    const pool = await sourceCandidates(plan, cliente);
    if (!pool.length) return res.status(422).json({ error: `Sourcing devolvió 0 candidatos (geo=${(plan._plan&&plan._plan.geografia)||'?'}, industrias=[${((plan._plan&&plan._plan.industrias)||[]).join(', ')||'-'}]). Revisar términos de rol / industria / geografía.` });
    let data = await seleccionarConRetry({ cliente, plan, pool });

    let cleanHtml = limpiarHtml(renderReport(data));
    if (!cleanHtml) return res.status(500).json({ error: 'No se pudo renderizar el reporte' });

    // El juez evalúa el HTML; el PDF se genera abajo y solo si quedó apto.
    let judgeResult = await runJudge(cleanHtml, null);

    // Si el juez rechaza, reintenta re-seleccionando con los fixes (sin renderizar PDF en el medio).
    const MAX_FIX = parseInt(process.env.MAX_FIX_ITERS || '1', 10);
    for (let intento = 1; intento <= MAX_FIX && judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0; intento++) {
      try {
        const fixedData = await seleccionarConRetry({ cliente, plan, pool, fixes: judgeResult.fixes });
        if (_cuentaCompletas(fixedData) < _cuentaCompletas(data)) {
          console.warn(`[FIX] el fix dio menos cards completas — conservo el previo y corto.`);
          break;
        }
        data = fixedData;
        cleanHtml = limpiarHtml(renderReport(data));
        judgeResult = await runJudge(cleanHtml, null);
      } catch (e) {
        console.warn(`[FIX] Falló, conservo el reporte previo:`, e.message);
        break;
      }
    }

    const MIN_CARDS_OK = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
    const cardsValidas = _cuentaCompletas(data);
    if (cardsValidas < MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO') {
      console.warn(`[INTEGRIDAD] Override: juez dijo APROBADO con ${cardsValidas}/${MIN_CARDS_OK} cards completas → RECHAZADO.`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 5),
        fixes: [`Reporte INCOMPLETO: ${cardsValidas}/${MIN_CARDS_OK} cuentas completas.`].concat(judgeResult.fixes||[]) };
    }
    const geoMal = _geoIncoherente(data);
    if (geoMal) {
      console.warn(`[GEO] Incoherencia país: objetivo=[${geoMal.objetivo.join(', ')}] | ${geoMal.fuera.join(' ')}`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
        fixes: [`GEO INCOHERENTE: el reporte apunta a ${geoMal.objetivo.join(', ')} pero hay cuentas en otro país. ${geoMal.fuera.join(' ')} Las cuentas deben estar en el/los país(es) del título e ICP, o hay que ajustar el título/ICP al país real de las cuentas.`].concat(judgeResult.fixes||[]) };
    }
    const tamMal = await _tamanoIncoherente(data, plan);
    if (tamMal) {
      console.warn(`[TAM] Incoherencia tamaño (egregio, <25% del piso): piso ${tamMal.tamMin}+ | ${tamMal.fuera.join(' ')}`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
        fixes: [`TAMAÑO INCOHERENTE: el ICP pide empresas de ${tamMal.tamMin}+ empleados pero hay cuentas MUY por debajo (menos del 25% del piso, prácticamente un individuo). ${tamMal.fuera.join(' ')} Reemplazá esas cuentas por empresas que cumplan el tamaño del ICP, o ajustá el título/ICP al tamaño real de las cuentas.`].concat(judgeResult.fixes||[]) };
    }
    const aptoEnvio = cardsValidas >= MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO';
    const descartadas = [];
    console.log(aptoEnvio
      ? `[INTEGRIDAD] OK: ${cardsValidas} cards completas + juez APROBADO.`
      : `[INTEGRIDAD] ⚠️ NO apto: ${cardsValidas}/${MIN_CARDS_OK} completas, juez ${judgeResult.veredicto}.`);

    // PDF solo si quedó apto; si está rechazado se devuelve pdf_base64 null.
    let pdfBuffer = null, pageCount = null;
    if (aptoEnvio) {
      pdfBuffer = await renderizarPdf(cleanHtml);
      pageCount = await contarPaginas(pdfBuffer);
    }

    logTokenCost('generar-reporte');

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer ? pdfBuffer.toString('base64') : null,
      reporte: (evalMode || debug) ? data : undefined, // solo en modo eval: objeto estructurado para inspección
      empresa: empresaFinal,
      anclado: cliente.anclado,
      cliente_resuelto: cliente,
      apto_envio: aptoEnvio,
      cards_validas: cardsValidas,
      cards_descartadas: descartadas,
      nombre: nombre || '', email,
      pdf_filename: _nombreArchivoPDF(empresaFinal),
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: [], links_no_resueltos: [], grados_corregidos: [], grados_mal: [],
      tokens: { ..._stats().total },
      tokens_input: _stats().total.input, tokens_output: _stats().total.output,
      tokens_cache_write: _stats().total.cache_write, tokens_cache_read: _stats().total.cache_read
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
  });
});

app.get('/health', (req, res) => res.json({ ok: true, jobs_activos: jobs.size, cuentas: NUM_CUENTAS }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT} (NUM_CUENTAS=${NUM_CUENTAS}, EXPECTED_PAGES=${EXPECTED_PAGES||'no validar'})`));
}

module.exports = {
  validarPlan, sourceCandidates, armarReporte, verificarLinksData,
  parseReporteJSON, _rankFit, _rankSenioridad, _parseProfile, _sizeBoost,
  _norm, _empresaDeHeadline, _empKey, _slugCos, _degOrdinal, _headlineLimpio, _fechaHoy
};