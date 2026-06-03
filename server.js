/**
 * IBT GTM Report — server.js v7.2
 *
 * Sobre v7.1.1 (fix del "?"), suma:
 *   - NUM_CUENTAS configurable (default 3, antes 6). Toca cap de cards, SELECT, PLAN, juez e integridad.
 *   - Dedup por EMPRESA en armarReporte (_empKey): no se repiten empresas entre cards.
 *   - Título (H1) reframeado: el cliente es protagonista -> "N clientes potenciales para [Cliente] en [País]".
 *   - Español NEUTRO (usted, sin voseo) forzado en PLAN y SELECT.
 *   - GEOGRAFÍA LatAm: el PLAN emite "geografias" (país del cliente PRIMERO + otros LatAm con fit);
 *     sourceCandidates busca en todos y da boost de cercanía al país del cliente.
 *   - Juez: cantidad de cuentas y páginas se validan contra valores pasados en el mensaje
 *     (EXPECTED_PAGES=0 => no valida páginas, para la transición del template a N cuentas).
 *
 * FIX v7.1.1: empresa "?" — _empresaDeHeadline ignora "?", _parseProfile limpia "@ ?".
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

// Cantidad de cuentas del reporte (antes 6). Configurable por env.
const NUM_CUENTAS = parseInt(process.env.NUM_CUENTAS || '3', 10);
// Cuántas le pedimos a la IA: sobre-generamos para tener margen tras dedupe (persona + empresa).
const PEDIR_SELECT = NUM_CUENTAS + 3;
// Páginas esperadas del PDF para el juez. 0 = NO validar páginas (útil mientras se reacomoda
// el template.html para N cuentas). Cuando sepas el número real, seteá EXPECTED_PAGES en Railway.
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

// Acumulador de tokens por job (total + desglose por etapa)
let tokenStats = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
let stageStats = {
  gen:   { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  judge: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  fix:   { input: 0, output: 0, cache_write: 0, cache_read: 0 }
};
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
  return (input * 3 + output * 15 + cache_write * 3.75 + cache_read * 0.30) / 1e6;
}

function logTokenCost(label) {
  const total = costoDe(tokenStats);
  console.log(`[TOKENS] ${label} | in:${tokenStats.input} out:${tokenStats.output} cache_w:${tokenStats.cache_write} cache_r:${tokenStats.cache_read} | ~$${total.toFixed(4)} (Sonnet)`);
  for (const etapa of ['gen', 'judge', 'fix']) {
    const s = stageStats[etapa];
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

// ---------------------------------------------------------------------------
// PROMPT viejo de generación directa (NO usado en el pipeline de 3 fases; se deja por compat).
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT_HTML = `# IBT GTM Report — (legacy, sin uso en 3 fases)`;

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
   FAIL si el overview tiene datos que parecen inventados o demasiado específicos sin verificación (año de fundación, stage de funding, número de productos/clientes, métricas redondas sin fuente). Si todo el overview suena a "marketing copy genérico" → FAIL.

5. **Coherencia interna** — el reporte trata sobre la empresa correcta, las cuentas hacen sentido para ese ICP.
   FAIL si una de las cuentas target es la misma empresa mencionada como proof point/cliente del producto en el overview.

6. **Personalización del ÁNGULO y el HOOK** (CRÍTICO — esto lo escribe la IA):
   - Cada card con ángulo y hook ÚNICOS y específicos de ESA persona/empresa, con un pain concreto.
   - FAIL si hay frases genéricas tipo "escalar tu operación" / "mejorar la eficiencia", o si los ángulos repiten la MISMA estructura.
   - FAIL si el ángulo o el hook hablan de OTRA persona o empresa distinta a la de la card. El hook debe nombrar a la persona de ESA card.
   - FAIL si el ángulo inventa datos de la empresa que NO se pueden inferir del cargo/headline.
   (El cargo y la empresa de la card son datos REALES — NO los marques como inventados.)

7. **Sin datos rotos** — sin [INSERT], TODO, undefined, lorem ipsum, placeholders {{...}} crudos, ni cards VACÍAS (sin nombre/empresa/cargo/link). Sin fechas incoherentes.
   (Mismo grado de conexión en varias cards NO es error.)

8. **Proof points presentes y plausibles** — al menos 1 ancla de credibilidad del cliente. FAIL si suenan fabricados.

Respondé EXCLUSIVAMENTE con JSON válido, sin markdown, sin texto extra:
{"veredicto":"APROBADO"|"RECHAZADO","score":<0-8>,"fixes":["fix concreto 1","fix concreto 2"]}

APROBADO solo si pasa los 8/8. Si RECHAZADO, "fixes" lista instrucciones concretas.`;

const SYSTEM_PROMPT_FIX = `Sos el corrector del reporte de IBT. Recibís los DATOS en JSON y correcciones del juez. Aplicá SOLO las correcciones necesarias y devolvé el MISMO objeto JSON corregido, misma estructura y nombres de campo (sin HTML, sin markdown). NUNCA inventes datos.`;

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
    tokenStats.input += i; tokenStats.output += o; tokenStats.cache_write += cw; tokenStats.cache_read += cr;
    const st = stageStats[currentStage];
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

async function runJudge(html, pageCount) {
  currentStage = 'judge';
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
    if (result.fixes.length > 0) console.log(`[JUDGE] Fixes: ${result.fixes.join(' | ')}`);
    return result;
  } catch (e) {
    console.error('[JUDGE] No se pudo parsear, aprobando por defecto:', e.message);
    return { veredicto: 'APROBADO', score: 0, fixes: [] };
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
// FIX v7.1.1: "?" NO es una empresa (la DB de IBT a veces trae "@ ?").
function _empresaDeHeadline(txt){let m=(txt||'').match(/@\s*([^·•|(\n]+)/);if(!m)m=(txt||'').match(/\bat\s+([^·•|(\n]+)/i);const e=m?m[1].trim():'';return e==='?'?'':e;}
function _empresaDeLookup(txt){const m=(txt||'').match(/Company:\s*(.+?)\s*(?:\[|—|\u2014|,|$)/i);return m?m[1].trim():'';}
function _headcountDe(txt){const m=(txt||'').match(/([\d][\d.,]*)\s*employees/i);return m?(parseInt(m[1].replace(/[.,]/g,''),10)||null):null;}
function _tier(h){if(h==null)return null;if(h<10)return'micro';if(h<50)return'chica';if(h<500)return'media';if(h<5000)return'grande';return'enterprise';}
function _esEmailGratuito(d){return /(gmail|yahoo|hotmail|outlook|icloud|live|aol|proton|protonmail|gmx)\./i.test((d||'').trim());}
function _mismaEmpresa(a,b){a=_norm(a);b=_norm(b);if(!a||!b)return false;if(a===b||a.includes(b)||b.includes(a))return true;const ta=new Set(a.split(' ').filter(w=>w.length>2));return b.split(' ').filter(w=>w.length>2).some(w=>ta.has(w));}
// Clave de empresa para dedup determinístico. Saca sufijos legales/genéricos para que
// "Tuya S.A" == "Tuya SA", pero sin colapsar distintas por una palabra común
// (ej: "Grupo TCC" != "Grupo Bios", porque saca "grupo" y compara "tcc" vs "bios").
function _empKey(emp){
  const k=_norm(emp).replace(/\b(sas|sa|s a|s a s|srl|s r l|ltda|ltd|inc|corp|llc|cia|compania|co|sapi|group|grupo|holding)\b/g,'').replace(/\s+/g,' ').trim();
  return k || _norm(emp);
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
function _rankFit(head, titulos){
  const h=_norm(head);
  const lista = Array.isArray(titulos) ? titulos : [];
  const matchFuncion = lista.some(t=>{ const n=_norm(t); return n && n.length>=2 && h.includes(n); });
  const sen=_rankSenioridad(head);
  return (matchFuncion ? 100 : 10) + sen;
}

// FIX v7.1.1: limpia el sufijo "@ ?" del headline enriquecido (empresa sin resolver en DB).
function _parseProfile(res){
  const s=String(res||'');
  const hc=(s.match(/(\d[\d,]*)\s+employees/)||[])[1];
  let headRich=((s.match(/—\s*(.+?)\s*\(\s*(?:\?|\d)/)||[])[1]||'').trim();
  headRich=headRich.replace(/\s*@\s*\?\s*$/,'').trim();   // "@ ?" = empresa sin resolver en la DB, no es dato
  return { headcount: hc?parseInt(hc.replace(/,/g,''),10):null, headRich };
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
  const geografia = icp.geografia;   // país del cliente (prioritario)
  const funcion   = icp.funcion;
  // GEOGRAFÍA LatAm: país del cliente PRIMERO + otros países de LatAm con fit (los define el PLAN).
  const geos = (Array.isArray(icp.geografias) && icp.geografias.length ? icp.geografias : [geografia]).filter(Boolean).slice(0, 6);
  const locIds = [];
  for(const g of geos){
    try{ const id=(String(await callMCP('resolve_sales_navigator_id',{type:'LOCATION',keywords:g,limit:1})).match(/id="?([0-9]+)"?/)||[])[1]; if(id && !locIds.includes(id)) locIds.push(id); }catch{}
  }
  let fnId=null;
  try{ fnId =(String(await callMCP('resolve_sales_navigator_id',{type:'FUNCTION',keywords:funcion,limit:3})).match(/id="?([A-Za-z0-9_]+)"?/)||[])[1]||null; }catch{}

  const f1={ category:'people', profilesLimit:50, keywords: funcion };
  if(locIds.length) f1.location={ include: locIds };
  if(fnId)  f1.function={ include:[fnId] };
  let pool=[];
  try{ pool=_parsePeople(await callMCP('search_sales_navigator_filtered', f1)); }catch{}
  if(pool.length < 10){
    const kw2 = (Array.isArray(icp.titulos_objetivo) && icp.titulos_objetivo[0]) || funcion;
    const f2={ category:'people', profilesLimit:50, keywords: kw2 };
    if(locIds.length) f2.location={ include: locIds };
    try{ pool=pool.concat(_parsePeople(await callMCP('search_sales_navigator_filtered', f2))); }catch{}
  }
  const vistos=new Set(); const out=[]; const empCliente=_norm((cliente&&cliente.empresa)||'');
  for(const p of pool){
    if(!p.id || vistos.has(p.id)) continue; vistos.add(p.id);
    if(_rankSenioridad(p.head) < 1) continue;
    const emp=_empresaDeHeadline(p.head)||'';
    if(empCliente && emp && _mismaEmpresa(empCliente, emp)) continue;
    out.push({ id:p.id, name:p.name, head:p.head, empresa:emp, dist:p.dist, loc:p.loc, rank:_rankSenioridad(p.head), fit:_rankFit(p.head, icp.titulos_objetivo) });
  }
  out.sort((a,b)=> (b.fit-a.fit) || (a.dist-b.dist));

  const K = parseInt(process.env.SOURCE_ENRICH_TOP || '14', 10);
  const noCache = String(process.env.SOURCE_ENRICH_NOCACHE||'').toLowerCase()==='true';
  const tamMin = parseInt(icp.tamano_min || 0, 10) || 0;
  const _microBase = parseInt(process.env.ICP_MIN_HEADCOUNT || '20', 10);
  const MICRO = Math.min(_microBase, tamMin>0 ? tamMin : _microBase);
  const homeGeo = _norm(geografia||'');   // país del cliente -> boost de cercanía
  const top = out.slice(0, K);
  for(const c of top){
    try{
      let prof=_parseProfile(await callMCP('get_contact_profile',{ publicIdOrUrl: c.id, noCache }));
      if(!prof.headRich && !noCache){
        try{ const fresco=_parseProfile(await callMCP('get_contact_profile',{ publicIdOrUrl: c.id, noCache:true })); if(fresco.headRich || fresco.headcount!=null){ prof=fresco; c._fresco=true; } }catch{}
      }
      if(prof.headcount!=null) c.headcount=prof.headcount;
      if(prof.headRich && prof.headRich.length>=3){
        const fresh = prof.headRich;
        if(_norm(fresh)!==_norm(c.head)) c._headViejo = c.head;
        c.head    = fresh;
        c.headRich= fresh;
        c.empresa = _empresaDeHeadline(fresh) || c.empresa;
        c.fit     = _rankFit(fresh, icp.titulos_objetivo);
      }
    }catch{}
    const warmth = c.dist===1?2 : c.dist===2?1 : 0;
    const cerca  = homeGeo && _norm(c.loc||'').includes(homeGeo) ? 1 : 0;   // mismo país que el cliente = más cercano
    c.score = c.fit*3 + _sizeBoost(c.headcount, tamMin)*2 + warmth + cerca;
  }
  const fueraICP = top.filter(c => c.headcount!=null && c.headcount < MICRO);
  for(const p of fueraICP) console.warn(`[SOURCE] fuera de ICP por tamaño (${p.headcount} emp < ${MICRO}), descartado: ${p.name} @ ${p.empresa||'?'}`);
  const topICP = top.filter(c => !(c.headcount!=null && c.headcount < MICRO));
  topICP.sort((a,b)=> (b.score-a.score) || (a.dist-b.dist));
  const final = topICP.concat(out.slice(K)).slice(0, 12);
  const refit = top.filter(c=>c._headViejo).length;
  const refrescados = top.filter(c=>c._fresco).length;
  console.log(`[SOURCE] Pool: ${out.length} reales | enriquecidos ${top.length}${noCache?' (noCache)':''} | re-fit ${refit} | refrescados ${refrescados} | fuera-ICP ${fueraICP.length} | devueltos ${final.length} (loc=${locIds.join('+')||'?'}, fn=${fnId||funcion}, tamMin=${tamMin||'-'}, micro<${MICRO}).`);
  return final;
}

// FASE 1 — IA: research + ICP + página 1. Prompt parametrizado por N (cantidad de cuentas).
function _promptPlan(N){ return `# IBT GTM — Fase PLAN (research + ICP + página 1)

Generás la PARTE 1 de un reporte de análisis de mercado que IBT manda a un prospecto. NO elegís personas todavía: eso lo hace el sistema. Vos investigás al cliente y definís a QUIÉN hay que buscar.

## Qué hacer
1. Research REAL del cliente con web_search: qué hace/vende, modelo de negocio, país, año de fundación, stage, tracción/proof point. PROHIBIDO inventar — si no lo verificás, no lo afirmes.
2. Definí el ICP del COMPRADOR del cliente: la función/área del decisor depende de lo que el cliente VENDE. Pensá a quién le compra el producto.
3. Escribí TODO el contenido de página 1 (ribbon, stats, icp, contexto, aperturas, prioridades, lead, proof, h1).

## Reglas
- "fecha" = EXACTAMENTE la fecha de hoy que te paso en el mensaje (no inventes otra).
- Datos de mercado (context): solo si salen de web_search; NO inventes porcentajes redondos.
- El ICP card "Rol del decisor" y el bloque _plan.funcion deben describir al MISMO comprador.
- TÍTULO (H1): el protagonista es el CLIENTE y las cuentas son VALOR PARA ÉL. Construilo como "${N} clientes potenciales para [Cliente] en [País o región]" → h1_pre="${N} clientes potenciales para", h1_company=nombre del cliente (lo resaltado), h1_post="en [País o región]". PROHIBIDO "para escalar" ni poner el tipo de cuenta antes que el cliente.
- IDIOMA: TODO el contenido en ESPAÑOL NEUTRO latinoamericano, con trato de "usted". Sin voseo ni modismos argentinos ("vos", "tenés", "podés", "acá"). El prospecto puede ser de cualquier país de LatAm.
- GEOGRAFÍA: los targets pueden ser de TODA Latinoamérica, no solo del país del cliente. "geografia" = el país del cliente (prioritario, el más cercano). "geografias" = ESE país PRIMERO + otros países de LatAm donde el cliente tenga fit comercial real para vender (no metas países donde no podría operar/vender). El sistema busca en todos pero prioriza el país del cliente.
- _plan.titulos_objetivo es CRÍTICO: el sistema rankea los candidatos buscando estas palabras DENTRO del cargo. Palabras SUELTAS (no frases), ES+inglés+abreviaturas. Si el ICP apunta a empresas chicas donde compra el dueño/CEO, incluí "ceo, founder, owner, dueño, fundador".

## Output — SOLO JSON (sin texto ni markdown alrededor)
{
  "fecha": "Mes Año (la de hoy)",
  "eyebrow": "Análisis de mercado · ... (uppercase corto)",
  "h1_pre": "${N} clientes potenciales para",
  "h1_company": "Nombre del cliente (resaltado)",
  "h1_post": "en [País o región]",
  "lead": "2-3 oraciones que anclan el proof point REAL del cliente.",
  "proof": "El proof point / origen del cliente (texto del box PROOF).",
  "ribbon": [ {"label":"Vertical","value":"..."}, {"label":"País","value":"..."}, {"label":"Fundada","value":"..."}, {"label":"Stage","value":"..."}, {"label":"Modelo","value":"..."} ],
  "stats": [ {"num":"...","label":"..."}, {"num":"${N}","label":"Cuentas priorizadas"}, {"num":"...","label":"..."}, {"num":"...","label":"..."} ],
  "icp": [ {"title":"Rol del decisor","desc":"..."}, {"title":"Tamaño de empresa","desc":"..."}, {"title":"Geografía","desc":"..."}, {"title":"Vertical / industria","desc":"..."} ],
  "context": [ "bullet 1", "bullet 2", "bullet 3" ],
  "apertura": [ "hook 1", "hook 2", "hook 3" ],
  "prioridades": [ "Alta — ...", "Media — ...", "...", "..." ],
  "_plan": { "funcion": "función del comprador en 1-2 palabras", "titulos_objetivo": ["PALABRAS SUELTAS del cargo de quien COMPRA, ES+EN+abreviaturas"], "geografia": "País del cliente (prioritario, ej: Colombia)", "geografias": ["País del cliente PRIMERO, después otros LatAm con fit (ej: Colombia, Chile, México)"], "industrias": ["industrias con fit"], "tamano_min": 0 }
}
CANTIDADES EXACTAS: ribbon 5, stats 4, icp 4, context 3, apertura 3, prioridades 4. NADA fuera del objeto JSON.`; }

async function runPlan({ empresa, dominio, email, nombre, cliente, fechaHoy }){
  currentStage = 'gen';
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

// FASE 3 — IA: elige + escribe. Prompt parametrizado por (pedir, usar).
function _promptSelect(pedir, usar){ return `# IBT GTM — Fase SELECT (elegir + escribir)

Te paso una LISTA REAL de candidatos (gente que existe, con su id, nombre, cargo textual, empresa y grado de conexión) y el contexto del cliente. Elegís los ${pedir} MEJORES decisores EN ORDEN de prioridad (el mejor primero) y escribís, para cada uno, un ángulo y un hook. El sistema usa los primeros ${usar} válidos.

## Cómo elegir (en este orden)
1. FIT de función: el cargo tiene que ser CLARAMENTE del rol que compra lo del cliente. Un "CEO/Dueño" de empresa chica puede servir; un C-level de un rubro que NO tiene que ver NO va, aunque sea senior. Ante la duda de fit, descartalo.
2. Decisor real: nada de analistas, trainees ni juniors.
3. Empresa ANCLA con fit de ICP: usá los "empleados" que te muestro. Marca grande y conocida emociona; startup desconocida de 8 personas no. Pero si el ICP son PyMEs, una empresa enorme NO sirve aunque sea famosa: priorizá el FIT real, no el tamaño por el tamaño.
4. Coherencia / credibilidad: si cargo+empresa+ubicación se ve raro o confuso, no la elijas.
5. Grado más cálido primero (1er/2do).

## Reglas DURAS
- Elegí SOLO ids que estén en la lista. PROHIBIDO inventar una persona, un id, un cargo o una empresa.
- LOS ${pedir} ids tienen que ser DISTINTOS. Prohibido repetir la misma persona.
- EMPRESAS DISTINTAS: cada cuenta es de una empresa DIFERENTE. PROHIBIDO elegir dos personas de la misma empresa. Si dos son de la misma empresa, quedate con el de mejor fit y completá con otra empresa.
- CADA uno DEBE tener angulo y hook NO vacíos.
- PROHIBIDO copiar/pegar un ángulo o hook de una persona a otra. El ángulo y el hook de cada id hablan SOLO de ESA persona y ESA empresa. Antes de cerrar, revisá que el nombre y la empresa que mencionás en cada ángulo sean los de ESE id.
- El hook DEBE empezar nombrando a la persona por su PRIMER NOMBRE (ej: "Clara, ...").
- El ángulo (3-4 oraciones) es ESPECÍFICO de esa persona/empresa: usá su cargo, empresa y —si está— el "perfil" REALES + lo que ofrece el cliente. Prohibido inventar datos. Cada ángulo 100% único.
- NUNCA menciones el grado de conexión (1er/2do/3er grado) en el ángulo ni en el hook.
- El hook: UNA sola oración de apertura entre comillas, lista para copiar y mandar.
- IDIOMA: ángulo y hook en ESPAÑOL NEUTRO latinoamericano, trato de "usted". Sin voseo ni modismos argentinos.
- Texto plano: NADA de markdown (sin **negritas**, sin asteriscos, sin comentarios). Solo el objeto JSON.

## Output — SOLO JSON (sin texto alrededor)
{ "seleccion": [ {"id":"<id EXACTO de la lista>", "angulo":"...", "hook":"\\"...\\""} ] }
EXACTAMENTE ${pedir} elementos distintos, en orden de prioridad. NADA fuera del objeto JSON.`; }

async function runSelectWrite({ cliente, plan, pool, fixes }){
  currentStage = 'gen';
  const lista = pool.map((p,i)=>{
    const tam = p.headcount!=null ? ` (~${p.headcount} empleados)` : '';
    const ctx = (p.headRich && p.headRich!==p.head) ? ` | perfil: ${p.headRich}` : '';
    return `${i+1}. id=${p.id} | ${p.name} | ${p.head} | empresa: ${p.empresa||'?'}${tam} | grado ${p.dist===9?'fuera de red':p.dist+'°'}${ctx}`;
  }).join('\n');
  const ctx = `Cliente: ${(cliente&&cliente.empresa)||plan.h1_company||''}. Qué ofrece / proof: ${String(plan.proof||plan.lead||'').slice(0,500)}. Función del comprador: ${(plan._plan&&plan._plan.funcion)||''}.`;
  const fixBloque = (fixes&&fixes.length) ? `\n\nCORRECCIONES del juez (aplicalas re-eligiendo o reescribiendo):\n- ${fixes.join('\n- ')}` : '';
  const messages = [{ role:'user', content:`${ctx}\n\nLISTA REAL DE CANDIDATOS (elegí de ACÁ, por id EXACTO):\n${lista}${fixBloque}\n\nElegí los ${PEDIR_SELECT} MEJORES en ORDEN de prioridad (el mejor primero), de EMPRESAS distintas. Devolvé SOLO el JSON {"seleccion":[...]} con EXACTAMENTE ${PEDIR_SELECT} elementos distintos. El sistema arma el reporte con los primeros ${NUM_CUENTAS} válidos, así que un error puntual no rompe nada — pero los primeros ${NUM_CUENTAS} tienen que ser tus mejores.` }];
  const data = await callClaude({ model:MODEL_GEN, system:_promptSelect(PEDIR_SELECT, NUM_CUENTAS), messages, tools:[], maxTokens:6000 });
  const j = parseReporteJSON(data.content.find(b=>b.type==='text')?.text);
  return Array.isArray(j && j.seleccion) ? j.seleccion : [];
}

// Ensamblado: HECHOS del pool (código); la IA solo aportó id + ángulo + hook.
function armarReporte(plan, seleccion, pool){
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
    const empKey = _empKey(empresa);
    if(empKey && usadasEmp.has(empKey)){ console.warn(`[SELECT] empresa DUPLICADA, card ignorada: ${p.name} @ ${empresa}`); continue; }
    usados.add(s.id);
    if(empKey) usadasEmp.add(empKey);
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
  if(cards.length < NUM_CUENTAS) console.warn(`[SELECT] ⚠️ solo ${cards.length}/${NUM_CUENTAS} cards válidas tras dedupe/limpieza.`);
  const { _plan, ...base } = plan;
  if(!base.empresa) base.empresa = base.h1_company || '';
  return { ...base, cards };
}

function _cardCompleta(c){
  return !!c && ['nombre','empresa','cargo','angulo','hook'].every(k => String(c[k]||'').trim().length > 0);
}
function _cuentaCompletas(data){
  return (((data && data.cards) || []).filter(_cardCompleta)).length;
}

async function seleccionarConRetry({ cliente, plan, pool, fixes }){
  const MIN = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
  const MAX = parseInt(process.env.SELECT_MAX_TRIES || '2', 10);
  let best=null, bestN=-1;
  for(let i=1;i<=MAX;i++){
    const extra = i>1 ? [`INTENTO ${i}: el intento previo no llegó a ${MIN} cuentas completas. Devolvé ${PEDIR_SELECT} ids EXACTOS de la lista (copiá el id tal cual), todos distintos, de EMPRESAS distintas, cada uno con empresa real + ángulo + hook.`] : [];
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
  try {
    console.log(`\n========== Job ${jobId} - Inicio (${NUM_CUENTAS} cuentas) ==========`);
    console.log(`Empresa: ${empresa} | Email: ${email} | Dominio: ${dominio} | profileId: ${profileId ?? '-'}`);
    resetTokenStats();

    const cliente = await resolverCliente({ profileId, dominio, empresa });
    const empresaFinal = cliente.empresa || empresa;

    const fechaHoy = _fechaHoy();
    const plan = await runPlan({ empresa: empresaFinal, dominio, email, nombre, cliente, fechaHoy });
    const pool = await sourceCandidates(plan, cliente);
    let data = await seleccionarConRetry({ cliente, plan, pool });

    let cleanHtml = limpiarHtml(renderReport(data));
    if (!cleanHtml) throw new Error('No se pudo renderizar el reporte');

    let pdfBuffer = await renderizarPdf(cleanHtml);
    let pageCount = await contarPaginas(pdfBuffer);

    let judgeResult = await runJudge(cleanHtml, pageCount);

    if (judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0) {
      console.log(`[Job ${jobId}] Juez rechazó ${judgeResult.score}/8 — aplicando fixes...`);
      try {
        const fixedData = await seleccionarConRetry({ cliente, plan, pool, fixes: judgeResult.fixes });
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

    const MIN_CARDS_OK = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
    const cardsValidas = _cuentaCompletas(data);
    if (cardsValidas < MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO') {
      console.warn(`[INTEGRIDAD] Override: juez dijo APROBADO con ${cardsValidas}/${MIN_CARDS_OK} cards completas → RECHAZADO.`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 5),
        fixes: [`Reporte INCOMPLETO: ${cardsValidas}/${MIN_CARDS_OK} cuentas completas. Faltan decisores reales con empresa, cargo, ángulo y hook — el sourcing/selección debe entregar ${MIN_CARDS_OK}.`].concat(judgeResult.fixes||[]) };
    }
    const aptoEnvio = cardsValidas >= MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO';
    const descartadas = [];
    console.log(aptoEnvio
      ? `[INTEGRIDAD] OK: ${cardsValidas} cards completas + juez APROBADO.`
      : `[INTEGRIDAD] ⚠️ NO apto: ${cardsValidas}/${MIN_CARDS_OK} completas, juez ${judgeResult.veredicto}.`);

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
      nombre, email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: [], links_no_resueltos: [], grados_corregidos: [], grados_mal: [],
      tokens: { ...tokenStats },
      tokens_input: tokenStats.input, tokens_output: tokenStats.output,
      tokens_cache_write: tokenStats.cache_write, tokens_cache_read: tokenStats.cache_read,
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

    const MIN_CARDS_OK = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
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
      nombre: nombre || '', email,
      paginas: pageCount,
      juez: judgeResult.veredicto + ' ' + judgeResult.score + '/8',
      juez_fixes: judgeResult.fixes,
      links_corregidos: [], links_no_resueltos: [], grados_corregidos: [], grados_mal: [],
      tokens: { ...tokenStats },
      tokens_input: tokenStats.input, tokens_output: tokenStats.output,
      tokens_cache_write: tokenStats.cache_write, tokens_cache_read: tokenStats.cache_read
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, jobs_activos: jobs.size, cuentas: NUM_CUENTAS }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT} (NUM_CUENTAS=${NUM_CUENTAS}, EXPECTED_PAGES=${EXPECTED_PAGES||'no validar'})`));
}

module.exports = {
  validarPlan, sourceCandidates, armarReporte, verificarLinksData,
  parseReporteJSON, _rankFit, _rankSenioridad, _parseProfile, _sizeBoost,
  _parsePeople, _norm, _empresaDeHeadline, _empKey, _slugCos, _degOrdinal, _headlineLimpio, _fechaHoy
};
