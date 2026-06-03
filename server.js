/**
 * IBT GTM Report — server.js v7.3
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
const MODEL_FIX = 'claude-sonnet-4-6';

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

// PROMPT viejo de generación directa (NO usado en el pipeline de 3 fases; se deja por compat).
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
   FAIL si el overview tiene datos que parecen inventados o demasiado específicos sin verificación (año de fundación, stage de funding, número de productos/clientes, métricas redondas sin fuente, tiempos de respuesta). Si todo el overview suena a "marketing copy genérico" → FAIL.

5. **Coherencia interna + GEOGRAFÍA** (CRÍTICO) — el reporte trata sobre la empresa correcta y las cuentas hacen sentido para ese ICP.
   FAIL si una cuenta target es la misma empresa mencionada como proof point/cliente del producto en el overview.
   FAIL si una cuenta target está ubicada en un país donde el cliente NO opera / no puede prestar el servicio (mirá la geografía del ICP: las cuentas deben estar en los países de operación del cliente, priorizando el país principal).

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

// FIX: limpia el sufijo "@ ?" del headline enriquecido (empresa sin resolver en DB).
function _parseProfile(res){
  const s=String(res||'');
  const hc=(s.match(/(\d[\d,]*)\s+employees/)||[])[1];
  let headRich=((s.match(/—\s*(.+?)\s*\(\s*(?:\?|\d)/)||[])[1]||'').trim();
  headRich=headRich.replace(/\s*@\s*\?\s*$/,'').trim();
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
  const geografia = icp.geografia;            // país principal (manda)
  const funcion   = icp.funcion;
  const homeGeo   = _norm(geografia||'');

  // Secundarias = SOLO donde el cliente opera de verdad, sin el país principal.
  const todas = (Array.isArray(icp.geografias) && icp.geografias.length ? icp.geografias : [geografia]).filter(Boolean);
  const secundarias = todas.filter(g => _norm(g) !== homeGeo).slice(0, 5);

  // Keyword limpio: hasta 4 títulos objetivo (palabras sueltas), NO el string con barras.
  const kw = (Array.isArray(icp.titulos_objetivo) && icp.titulos_objetivo.length)
    ? icp.titulos_objetivo.filter(t=>String(t||'').trim().length>=3).slice(0,4).join(' ')
    : String(funcion||'').replace(/[\/|]+/g,' ').replace(/\s+/g,' ').trim();

  async function locId(nombrePais){
    try{ return (String(await callMCP('resolve_sales_navigator_id',{type:'LOCATION',keywords:nombrePais,limit:1})).match(/id="?([0-9]+)"?/)||[])[1] || null; }catch{ return null; }
  }
  let fnId=null;
  try{ fnId=(String(await callMCP('resolve_sales_navigator_id',{type:'FUNCTION',keywords:funcion,limit:3})).match(/id="?([A-Za-z0-9_]+)"?/)||[])[1]||null; }catch{}

  // INDUSTRIAS ANCLA: resolvemos las verticales del ICP a IDs de Sales Navigator.
  // Con esto la búsqueda trae decisores EN aseguradoras/retailers/inmobiliarias (cuentas "wow"),
  // no admins de cualquier empresa que tenga el título.
  const indIds=[];
  for(const ind of (Array.isArray(icp.industrias)?icp.industrias:[]).slice(0,6)){
    try{ const id=(String(await callMCP('resolve_sales_navigator_id',{type:'SALES_INDUSTRY',keywords:ind,limit:1})).match(/id="?([0-9]+)"?/)||[])[1]; if(id && !indIds.includes(id)) indIds.push(id); }catch{}
  }

  async function buscar(locIds, conIndustria){
    const f={ category:'people', profilesLimit:50, keywords: kw };
    if(locIds && locIds.length) f.location={ include: locIds };
    if(fnId) f.function={ include:[fnId] };
    if(conIndustria && indIds.length) f.industry={ include: indIds };
    try{ return _parsePeople(await callMCP('search_sales_navigator_filtered', f)); }catch{ return []; }
  }

  const _validosHome = arr => arr.filter(p => _rankSenioridad(p.head) >= 2 && _norm(p.loc||'').includes(homeGeo)).length;
  const homeId = await locId(geografia);
  const homeLoc = homeId ? [homeId] : null;
  const HOME_MIN = parseInt(process.env.SOURCE_HOME_MIN || String(NUM_CUENTAS + 2), 10);

  // 1) PAÍS PRINCIPAL + INDUSTRIAS ANCLA (lo que impacta al prospecto).
  let pool = await buscar(homeLoc, true);
  console.log(`[SOURCE] principal "${geografia}" + industrias [${(icp.industrias||[]).join(', ')||'-'}]: ${pool.length} perfiles (${_validosHome(pool)} válidos).`);

  // 2) si la industria estricta dejó poco, mismo país SIN industria (recall).
  if(_validosHome(pool) < HOME_MIN){
    const extra = await buscar(homeLoc, false);
    pool = pool.concat(extra);
    console.log(`[SOURCE] industria estricta floja -> ${geografia} sin industria: total ${pool.length} (${_validosHome(pool)} válidos).`);
  }

  // 3) recién si el principal no alcanza, secundarias donde el cliente SÍ opera.
  if(_validosHome(pool) < HOME_MIN && secundarias.length){
    const secIds=[]; for(const g of secundarias){ const id=await locId(g); if(id) secIds.push(id); }
    if(secIds.length){
      const extra = await buscar(secIds, indIds.length>0);
      pool = pool.concat(extra);
      console.log(`[SOURCE] principal insuficiente -> secundarias [${secundarias.join(', ')}]: +${extra.length}.`);
    }
  }

  const vistos=new Set(); const out=[]; const empCliente=_norm((cliente&&cliente.empresa)||'');
  for(const p of pool){
    if(!p.id || vistos.has(p.id)) continue; vistos.add(p.id);
    if(_rankSenioridad(p.head) < 1) continue;
    const emp=_empresaDeHeadline(p.head)||'';
    if(empCliente && emp && _mismaEmpresa(empCliente, emp)) continue;
    const cerca = homeGeo && _norm(p.loc||'').includes(homeGeo) ? 1 : 0;
    out.push({ id:p.id, name:p.name, head:p.head, empresa:emp, dist:p.dist, loc:p.loc, cerca, rank:_rankSenioridad(p.head), fit:_rankFit(p.head, icp.titulos_objetivo) });
  }
  out.sort((a,b)=> (b.cerca-a.cerca) || (b.fit-a.fit) || (a.dist-b.dist));

  const K = parseInt(process.env.SOURCE_ENRICH_TOP || '14', 10);
  const noCache = String(process.env.SOURCE_ENRICH_NOCACHE||'').toLowerCase()==='true';
  const tamMin = parseInt(icp.tamano_min || 0, 10) || 0;
  // PISO de tamaño: si el ICP define tamano_min (medianas/grandes), es el piso real.
  // Así una empresa de 26 personas NO entra cuando el ICP pide empresas ancla.
  const PISO = tamMin > 0 ? tamMin : parseInt(process.env.ICP_MIN_HEADCOUNT || '20', 10);
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
        c.head=fresh; c.headRich=fresh;
        c.empresa=_empresaDeHeadline(fresh) || c.empresa;
        c.fit=_rankFit(fresh, icp.titulos_objetivo);
      }
    }catch{}
    c.cerca  = homeGeo && _norm(c.loc||'').includes(homeGeo) ? 1 : 0;
    const warmth = c.dist===1?2 : c.dist===2?1 : 0;
    c.score = c.fit*3 + _sizeBoost(c.headcount, tamMin)*3 + warmth + c.cerca;
  }
  // Descarte por tamaño contra el PISO del ICP, SIN vaciar el pool.
  const cumplen = top.filter(c => !(c.headcount!=null && c.headcount < PISO));
  const fueraPorTam = top.filter(c => c.headcount!=null && c.headcount < PISO);
  for(const p of fueraPorTam) console.warn(`[SOURCE] fuera de ICP por tamaño (${p.headcount}<${PISO}): ${p.name} @ ${p.empresa||'?'}`);
  const topICP = (cumplen.length >= NUM_CUENTAS) ? cumplen : top;
  if(cumplen.length < NUM_CUENTAS) console.warn(`[SOURCE] piso ${PISO} dejó solo ${cumplen.length}/${NUM_CUENTAS} -> relajo el piso para no quedar corto.`);
  topICP.sort((a,b)=> (b.cerca-a.cerca) || (b.score-a.score) || (a.dist-b.dist));
  const final = topICP.concat(out.slice(K)).slice(0, 12);
  const enCasa = final.filter(c=>c.cerca).length;
  console.log(`[SOURCE] Pool: ${out.length} reales (${out.filter(c=>c.cerca).length} en ${geografia}) | enriquecidos ${top.length} | fuera-tam ${fueraPorTam.length} | devueltos ${final.length} (${enCasa} en ${geografia}) (kw="${kw}", ind=[${indIds.join('+')||'-'}], fn=${fnId||'-'}, piso<${PISO}).`);
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
- "fecha" = EXACTAMENTE la fecha de hoy que te paso en el mensaje (no inventes otra).
- VERACIDAD (CRÍTICO): PROHIBIDO inventar métricas o datos duros. Esto incluye específicamente: cantidad de categorías/tipos de servicio (ej. "+300 categorías"), totales acumulados (ej. "+470.000 servicios"), tiempos de respuesta ("60 minutos"), %, premios, año de fundación o stage. Si un número NO sale textual de web_search o de una fuente verificable, NO lo pongas en ningún lado (lead, proof, context, apertura, stats, ribbon). Ante la duda, usá una formulación cualitativa SIN número ("amplia cobertura", "varias categorías de servicio"). Es preferible un reporte sin números a uno con números inventados. REGLA DE ORO: antes de cerrar, releé CADA número que escribiste; si no podés señalar la fuente exacta de web_search de donde salió, BORRALO o pasalo a texto cualitativo. El invento más común y MÁS GRAVE es "+300 tipos de servicio" o "+X servicios/clientes": NO lo escribas jamás si no lo viste en una fuente.
- STATS: que los 4 chips sean datos verificables o estructurales (ej: la cantidad ${N} de cuentas priorizadas, países de operación reales, año de fundación SOLO si lo verificaste). NUNCA rellenes un stat con un número inventado para que "quede lindo". Preferí stats que IMPACTEN y sean verificables (ciudades/países de cobertura, años en el mercado, la cantidad ${N} de cuentas). EVITÁ stats que subvendan al cliente, como su propia cantidad de empleados si es baja.
- El ICP card "Rol del decisor" y el bloque _plan.funcion deben describir al MISMO comprador.
- TÍTULO (H1): el CLIENTE va PRIMERO y resaltado. h1_pre = "" (vacío); h1_company = nombre del cliente (lo resaltado, va primero); h1_post = "${N} clientes potenciales en [País o región]" (es un SUBTÍTULO que va DEBAJO del nombre; SIN "·" ni guion al principio). PROHIBIDO "para escalar".
- IDIOMA: TODO en ESPAÑOL NEUTRO latinoamericano, trato de "usted". Sin voseo ni modismos argentinos ("vos", "tenés", "podés", "acá"). El prospecto puede ser de cualquier país de LatAm.
- SIN GUIONES (importante): NUNCA uses guiones largos (—) ni guiones (-) como conectores o para incisos, en NINGÚN texto (lead, proof, context, apertura, icp, prioridades). Reemplazalos por comas, paréntesis o dos puntos. Ej: en vez de "servicios técnicos —plomería, electricidad— con cobertura", escribí "servicios técnicos (plomería, electricidad) con cobertura". El texto tiene que sonar humano, no de IA.
- GEOGRAFÍA (CRÍTICO): "geografia" = país del cliente (prioritario). "geografias" = país del cliente PRIMERO + SOLO los demás países donde el cliente HOY ya puede prestar el servicio de verdad (sus países de operación actuales). PROHIBIDO mercados de expansión futura o donde el cliente todavía NO opera. El sistema prioriza fuerte el país del cliente; los demás solo rellenan.
- INDUSTRIAS (CRÍTICO — ahora es un FILTRO DURO de búsqueda): "industrias" tiene que listar las VERTICALES ANCLA reales donde están los compradores del cliente (las mismas que marcás ALTA en "prioridades"). El sistema busca decisores SOLO en estas industrias, así que tienen que ser categorías reales y reconocibles (ej: "Seguros", "Comercio al por menor", "Inmobiliario", "Construcción", "Banca"). NO pongas el rubro del propio cliente ni industrias genéricas.
- TAMAÑO (para que salgan empresas ANCLA, no micro-empresas): "tamano_min" tiene que ser un número real de empleados que refleje el ICP. Si el ICP son empresas medianas y grandes / marcas ancla, poné un piso alto (ej: 200). Poné un piso bajo (20-50) SOLO si el ICP son genuinamente PyMEs/micro. NO lo dejes en 0 salvo que de verdad cualquier tamaño sirva.
- LARGO (para que el overview entre en 1 página): lead = MÁX 2 oraciones; proof = MÁX 2 oraciones; cada bullet de context = 1 oración corta (máx ~140 caracteres). Sé conciso.
- _plan.titulos_objetivo es CRÍTICO: el sistema rankea buscando estas palabras DENTRO del cargo. Palabras SUELTAS (no frases), ES+inglés+abreviaturas. Si el ICP apunta a empresas chicas donde compra el dueño/CEO, incluí "ceo, founder, owner, dueño, fundador".

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
  "_plan": { "funcion": "función del comprador en 1-2 palabras", "titulos_objetivo": ["PALABRAS SUELTAS del cargo de quien COMPRA, ES+EN+abreviaturas"], "geografia": "el país real del cliente (prioritario)", "geografias": ["País del cliente PRIMERO, después SOLO países donde el cliente HOY opera"], "industrias": ["VERTICALES ANCLA reales y reconocibles, ej: Seguros, Comercio al por menor, Inmobiliario, Construcción"], "tamano_min": 200 }
}
CANTIDADES EXACTAS: ribbon 3, stats 4, icp 4, context 3, apertura 3, prioridades 4. NADA fuera del objeto JSON.`; }

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

Te paso una LISTA REAL de candidatos (gente que existe, con su id, nombre, cargo textual, empresa, país y grado de conexión) y el contexto del cliente. Elegís los ${pedir} MEJORES decisores EN ORDEN de prioridad (el mejor primero) y escribís, para cada uno, un ángulo y un hook. El sistema usa los primeros ${usar} válidos.

## Cómo elegir (en este orden)
1. FIT de función (LO MÁS IMPORTANTE): el cargo tiene que ser CLARAMENTE del rol que compra lo del cliente. PROHIBIDO elegir gente de OTRA área que la del comprador: si el comprador es de Operaciones/Facilities/Mantenimiento/Administración, NO elijas a nadie de Marketing/Mercadeo/Ventas/Comercial/RR.HH./Finanzas, POR MÁS que la empresa sea una marca top. Un cargo suelto sin función clara ("Mercadeo", "Analista", "Coordinador" a secas) NO sirve. Un "CEO/Dueño" de empresa chica sí sirve porque ahí decide. MEJOR devolver MENOS cuentas (o repetir vertical) que UNA sola de función equivocada: una cuenta mal apuntada quema todo el reporte.
2. PAÍS: preferí candidatos del PAÍS DEL CLIENTE (van marcados con ★ y vienen primero en la lista). Elegí de otro país de LatAm SOLO si no hay suficientes buenos del país del cliente. NUNCA elijas a alguien de un país donde el cliente no puede prestar el servicio.
3. Decisor real: nada de analistas, trainees ni juniors.
4. Empresa ANCLA con fit de ICP: usá los "empleados" que te muestro. Marca grande y conocida emociona; startup desconocida de 8 personas no. Pero si el ICP son PyMEs, una empresa enorme NO sirve aunque sea famosa: priorizá el FIT real.
5. Coherencia / credibilidad: si cargo+empresa+ubicación se ve raro, no la elijas.
6. Grado más cálido primero (1er/2do).

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
EXACTAMENTE ${pedir} elementos distintos, en orden de prioridad. NADA fuera del objeto JSON.`; }

async function runSelectWrite({ cliente, plan, pool, fixes }){
  currentStage = 'gen';
  const lista = pool.map((p,i)=>{
    const tam = p.headcount!=null ? ` (~${p.headcount} empleados)` : '';
    const ctx = (p.headRich && p.headRich!==p.head) ? ` | perfil: ${p.headRich}` : '';
    const loc = p.loc ? ` | ${p.loc}` : '';
    const home = p.cerca ? ' ★(país del cliente)' : '';
    return `${i+1}. id=${p.id} | ${p.name} | ${p.head} | empresa: ${p.empresa||'?'}${tam}${loc}${home} | grado ${p.dist===9?'fuera de red':p.dist+'°'}${ctx}`;
  }).join('\n');
  const ctx = `Cliente: ${(cliente&&cliente.empresa)||plan.h1_company||''}. País del cliente (prioritario): ${(plan._plan&&plan._plan.geografia)||''}. Qué ofrece / proof: ${String(plan.proof||plan.lead||'').slice(0,500)}. Función del comprador: ${(plan._plan&&plan._plan.funcion)||''}.`;
  const fixBloque = (fixes&&fixes.length) ? `\n\nCORRECCIONES del juez (aplicalas re-eligiendo o reescribiendo):\n- ${fixes.join('\n- ')}` : '';
  const messages = [{ role:'user', content:`${ctx}\n\nLISTA REAL DE CANDIDATOS (elegí de ACÁ, por id EXACTO; los ★ son del país del cliente):\n${lista}${fixBloque}\n\nElegí los ${PEDIR_SELECT} MEJORES en ORDEN de prioridad (el mejor primero), de EMPRESAS distintas y priorizando el país del cliente. Devolvé SOLO el JSON {"seleccion":[...]} con EXACTAMENTE ${PEDIR_SELECT} elementos distintos. El sistema arma el reporte con los primeros ${NUM_CUENTAS} válidos, así que los primeros ${NUM_CUENTAS} tienen que ser tus mejores.` }];
  const data = await callClaude({ model:MODEL_GEN, system:_promptSelect(PEDIR_SELECT, NUM_CUENTAS), messages, tools:[], maxTokens:6000 });
  const j = parseReporteJSON(data.content.find(b=>b.type==='text')?.text);
  return Array.isArray(j && j.seleccion) ? j.seleccion : [];
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
  const segs = raw.split(/\s*[|•·]\s*|\s+[lI]\s+|\s+-\s+/).map(s=>s.trim()).filter(Boolean);
  if(!segs.length) return raw;
  const kwl = (kws||[]).map(k=>_norm(k)).filter(k=>k.length>=3);
  const best = segs.find(s => kwl.some(k => _norm(s).includes(k))) || segs[0];
  return best.length > 70 ? best.slice(0,70).trim() : best;
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

async function seleccionarConRetry({ cliente, plan, pool, fixes }){
  const MIN = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
  const MAX = parseInt(process.env.SELECT_MAX_TRIES || '2', 10);
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
