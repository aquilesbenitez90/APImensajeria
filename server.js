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
 *     card coincida con el país del título (h1_post) y la prosa del lead. Si una card está en
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
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// GUARDAS A NIVEL PROCESO: que un job NUNCA tumbe el server entero.
// Una excepción suelta en un path async sin catch (o una promesa rechazada sin
// .catch) mata el proceso por default -> Railway "Stopping Container". Acá las
// logueamos y seguimos vivos. NO atrapa OOM (el kernel mata el proceso), pero sí
// cualquier excepción/rechazo JS, que es el caso mucho más común.
// ---------------------------------------------------------------------------
process.on('uncaughtException', (e) => {
  console.error('[CRASH] uncaughtException (no tumbo el server):', e?.stack || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[CRASH] unhandledRejection (no tumbo el server):', e?.stack || e);
});

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const MODEL_GEN = 'claude-sonnet-4-6';
const MODEL_JUDGE = 'claude-sonnet-4-6';
// SEÑALES DE COMPRA por cuenta (opcional, reversible). SIGNALS_MODE=on las activa; la EXTRACCIÓN usa un
// modelo BARATO (Haiku) porque es leer y extraer, no juzgar. Off por default: cero costo/latencia/riesgo.
const SIGNALS_MODE = (process.env.SIGNALS_MODE || 'off').toLowerCase();
const MODEL_SIGNALS = process.env.MODEL_SIGNALS || 'claude-haiku-4-5-20251001';
const SIGNALS_PER_CARD = parseInt(process.env.SIGNALS_PER_CARD || '3', 10);
// Tamaño de cada búsqueda en Sales Navigator (filas por llamada). Más grande = pool más grande para el
// fallback de piso, mismas llamadas (una por término de rol). Tuneable por env. People 100, companies 50.
const SOURCE_PROFILES_LIMIT = parseInt(process.env.SOURCE_PROFILES_LIMIT || '100', 10);
const SOURCE_CO_LIMIT = parseInt(process.env.SOURCE_CO_LIMIT || '50', 10);

// Temperatura del JUEZ: baja = veredicto consistente (mismo reporte → mismo veredicto).
// El juez corría a la temperatura por defecto (1.0), lo que disparaba la varianza
// APROBADO↔RECHAZADO entre corridas idénticas. 0 = lo más determinístico. Configurable por env.
const _tempEnv = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const TEMP_JUDGE = _tempEnv(process.env.TEMP_JUDGE, 0);

// SELF-CONSISTENCY del juez ("Rating Roulette"): correr N votos independientes y agregar
// conservadoramente. Un solo voto a T=0 flipea APROBADO↔RECHAZADO en criterios subjetivos
// (4 veracidad, 6 personalización). JUDGE_VOTES=1 reproduce el comportamiento histórico
// (1 voto a TEMP_JUDGE). Con N>1, los votos corren a TEMP_JUDGE_VOTE>0 para ser MUESTRAS
// independientes (a T=0 los N votos serían idénticos y la agregación no aportaría nada).
const JUDGE_VOTES = Math.max(1, parseInt(process.env.JUDGE_VOTES || '3', 10));
const TEMP_JUDGE_VOTE = _tempEnv(process.env.TEMP_JUDGE_VOTE, 0.4);

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

// ---------------------------------------------------------------------------
// LOG DE RESULTADOS (JSONL) — una línea estructurada por job para análisis con IA.
// OJO Railway: el filesystem es EFÍMERO; para que NO se borre en cada deploy, montá un
// volumen y seteá RESULT_LOG_PATH al path del volumen (ej. /data/resultados.jsonl).
// Si no, escribe junto al server y se pierde al redeploy.
// ---------------------------------------------------------------------------
const RESULT_LOG = process.env.RESULT_LOG_PATH || path.join(__dirname, 'resultados.jsonl');
function _registrarResultado(rec){
  try{
    fs.appendFile(RESULT_LOG, JSON.stringify(rec) + '\n', e => { if(e) console.warn('[LOG] no pude escribir resultado:', e.message); });
  }catch(e){ console.warn('[LOG] error registrando resultado:', e.message); }
}
// Motivo de rechazo canónico y AGREGABLE (para contar patrones de falla en resultados.jsonl).
// Devuelve el PRIMER motivo determinístico que disparó, en orden de prioridad:
//   sourcing_vacio > integridad > geo > paises > tamano > calidez > rol_bajo > juez > ok
// Recibe los flags ya calculados en el endpoint (las guardas ya corrieron); 'rol_bajo' no
// tiene guarda determinística en este punto (se descarta antes, en armarReporte) → cae a 'juez'.
function _motivoRechazo({ aptoEnvio, sourcingVacio, integridadMal, geoMal, paisesMal, tamMal, calidezMal, juezRechazo } = {}){
  if (sourcingVacio) return 'sourcing_vacio';
  if (integridadMal) return 'integridad';
  if (geoMal) return 'geo';
  if (paisesMal) return 'paises';
  if (tamMal) return 'tamano';
  if (calidezMal) return 'calidez';
  if (aptoEnvio) return 'ok';
  if (juezRechazo) return 'juez';
  return 'juez';
}

// Construye el registro de un job. NO incluye el PDF (pesa). Incluye el ICP y las cards
// (empresa/cargo/grado/tamaño) + calidez, que es lo que la IA usa para detectar patrones.
function _recResultado({ jobId, input, cliente, plan, data, judgeResult, aptoEnvio, pageCount, error, motivo_rechazo }){
  const t = _stats().total;
  const icp = (plan && plan._plan) || {};
  const cards = (((data && data.cards) || [])).map(c => ({
    empresa: c.empresa, nombre: c.nombre, cargo: c.cargo, grado: c.grado,
    ubicacion: c.ubicacion, urn: c.urn, headcount: (c.headcount ?? null)
  }));
  const warm = cards.filter(c => /1er|2do/.test(c.grado || '')).length;
  // motivo canónico AGREGABLE. En el branch de error derivamos sourcing_vacio del mensaje
  // (el pool vacío lanza "Sourcing devolvió 0 candidatos"); el resto lo pasa el endpoint.
  const motivo = motivo_rechazo
    || (error ? (/0 candidatos/i.test(error) ? 'sourcing_vacio' : 'error') : undefined);
  return {
    ts: new Date().toISOString(),
    jobId: jobId || null,
    status: error ? 'error' : 'ok',
    error: error || undefined,
    motivo_rechazo: motivo,
    empresa: (cliente && cliente.empresa) || (input && input.empresa) || '',
    dominio: (input && input.dominio) || '',
    email: (input && input.email) || '',
    profileId: (input && input.profileId) || null,
    anclado: !!(cliente && cliente.anclado),
    veredicto: judgeResult && judgeResult.veredicto,
    score: judgeResult ? judgeResult.score : null,
    apto_envio: !!aptoEnvio,
    cards_validas: _cuentaCompletas(data),
    total_cards: cards.length,
    warm,                       // cards en 1er/2do grado (calidez): mejor predictor de conversión
    paginas: pageCount ?? null,
    icp: { funcion: icp.funcion || '', geografia: icp.geografia || '', geografias: icp.geografias || [], industrias: icp.industrias || [], tamano_min: icp.tamano_min || 0 },
    juez_fixes: (judgeResult && judgeResult.fixes) || [],
    cards,
    costo: +costoDe(t).toFixed(4),
    tokens: { ...t }
  };
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
// TIMEOUT por llamada MCP: una llamada patológica (vimos get_contact_profile tardando 250s) colgaba el
// job ENTERO porque fetch no aborta solo. Cada llamada se corta con AbortController. El timeout cubre
// fetch + lectura del body (ver callMCP): el MCP responde SSE con UN solo evento `data: {...}\n\n` al
// final (no streamea chunks útiles; nuestro parser consume el body entero y matchea un único evento), así
// que un idle-timeout no aplica: para un perfil lento-pero-progresando no llega ningún byte hasta el final
// igual que en un cuelgue real, y no podríamos distinguirlos. Por eso usamos un TOPE TOTAL generoso.
// get_contact_profile hace un fetch VIVO de LinkedIn que LEGÍTIMAMENTE tarda 40-90s; un tope de 30s lo
// abortaba en pleno enriquecimiento. Subido a 90s: tolera el perfil lento real y sigue cortando el cuelgue
// infinito (los 250s patológicos) muy por debajo del cinturón global de 8 min. Tuneable por env.
const MCP_TIMEOUT_MS         = parseInt(process.env.MCP_TIMEOUT_MS || '45000', 10);
const MCP_PROFILE_TIMEOUT_MS = parseInt(process.env.MCP_PROFILE_TIMEOUT_MS || '90000', 10);
const _mcpTimeoutDe = (toolName) => toolName === 'get_contact_profile' ? MCP_PROFILE_TIMEOUT_MS : MCP_TIMEOUT_MS;

// CACHE POR JOB de get_contact_profile (positivo Y negativo), aislado con AsyncLocalStorage (NUNCA global
// mutable). El multi-pass (sourceConRetry/SOURCE_MAX_PASSES) re-llama get_contact_profile sobre los MISMOS
// URNs en cada pasada; sin cache, un perfil que ya resolvió se vuelve a pedir y uno que ya falló por timeout
// se REINTENTA y quema otra vez el presupuesto de los 90s. Cacheamos por identidad del perfil dentro del job:
//   - HIT positivo  -> devolvemos el resultado (re-envolviendo structuredContent para no romper el contrato).
//   - HIT negativo  -> re-lanzamos un AbortError sin tocar la red (el caller ya lo trata como vacío).
// Honra noCache:true del caller (bypass total). Solo aplica a get_contact_profile; las demás tools intactas.
function _profileCacheKey(args) {
  if (!args) return null;
  const k = args.publicIdOrUrl ?? args.urn ?? (args.profileId != null ? `pid:${args.profileId}` : null);
  return k != null ? String(k) : null;
}

async function callMCP(toolName, args) {
  console.log(`[MCP] Llamando ${toolName} con args:`, JSON.stringify(args).substring(0, 200));
  // --- cache por job (solo get_contact_profile) ---
  const _cacheable = toolName === 'get_contact_profile' && !(args && args.noCache === true);
  const _ckey = _cacheable ? _profileCacheKey(args) : null;
  if (_ckey != null) {
    const st0 = _statsALS.getStore();
    const cache = st0 && (st0.profileCache || (st0.profileCache = new Map()));
    if (cache && cache.has(_ckey)) {
      const hit = cache.get(_ckey);
      if (hit.ok) {
        console.log(`[MCP] ${toolName} CACHE HIT (positivo) para ${_ckey.substring(0, 40)}.`);
        if (hit.structured != null) {
          const wrapped = new String(hit.value);
          Object.defineProperty(wrapped, 'structuredContent', { value: hit.structured, enumerable: false });
          return wrapped;
        }
        return hit.value;
      }
      console.log(`[MCP] ${toolName} CACHE HIT (negativo: ya abortó por timeout en este job) para ${_ckey.substring(0, 40)} -> sin reintento.`);
      const err = new Error(`get_contact_profile cacheado como fallido (timeout previo en este job)`);
      err.name = 'AbortError';
      throw err;
    }
  }
  const ms = _mcpTimeoutDe(toolName);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  let text;
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: IBT_HEADERS,
      signal: ac.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: Date.now()
      })
    });
    // La lectura del body DEBE ir dentro del try: el MCP responde SSE en stream y si manda los
    // headers pero deja el stream colgado sin emitir el `data:`, res.text() espera al cierre para
    // siempre. Al estar bajo el mismo AbortController, el timeout aborta también la lectura del body.
    text = await res.text();
  } catch (e) {
    // AbortError = se cortó por timeout (en el fetch o en la lectura del stream). Lo logueamos (los
    // catch de los callers son silenciosos) y re-lanzamos: el caller envuelto en try/catch devuelve
    // vacío y el pool sigue.
    if (e && e.name === 'AbortError') {
      console.error(`[MCP] ${toolName} ABORTADA por timeout (${ms}ms).`);
      // cache NEGATIVO por job: no reintentar este URN en pasadas siguientes (ya quemó su presupuesto).
      if (_ckey != null) {
        const st = _statsALS.getStore();
        const cache = st && (st.profileCache || (st.profileCache = new Map()));
        if (cache) cache.set(_ckey, { ok: false });
      }
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const match = text.match(/data: ({.*})\n\n/);
  if (!match) {
    console.error(`[MCP] ERROR: no se pudo parsear respuesta de ${toolName}`);
    throw new Error('No se pudo parsear respuesta MCP');
  }
  const parsed = JSON.parse(match[1]);
  const result = parsed?.result?.content?.[0]?.text || JSON.stringify(parsed?.result);
  // structuredContent: si el MCP lo expone, lo adjuntamos SIN romper el contrato (los callers que
  // esperan el texto lo siguen recibiendo: devolvemos un String, con el structured como propiedad
  // NO enumerable para no contaminar JSON.stringify ni los regex de los parsers). Log UNA vez por job.
  const structured = parsed?.result?.structuredContent ?? null;
  const st = _statsALS.getStore();
  if (st && !st.mcpStructuredLogged) {
    st.mcpStructuredLogged = true;
    console.log(`[MCP] structuredContent: ${structured ? 'presente' : 'ausente'}`);
  }
  console.log(`[MCP] ${toolName} OK (${result.length} chars)`);
  // cache POSITIVO por job: guardamos el texto + structured crudos para re-envolver en HITs siguientes.
  if (_ckey != null) {
    const st = _statsALS.getStore();
    const cache = st && (st.profileCache || (st.profileCache = new Map()));
    if (cache) cache.set(_ckey, { ok: true, value: result, structured });
  }
  // El primitivo string no acepta props; lo envolvemos en String() (objeto) y le colgamos el structured.
  // `String(x)` en cualquier caller lo re-coacciona al primitivo, así que NO cambia comportamiento.
  if (structured != null) {
    const wrapped = new String(result);
    Object.defineProperty(wrapped, 'structuredContent', { value: structured, enumerable: false });
    return wrapped;
  }
  return result;
}

async function listMCPTools() {
  console.log(`[MCP] Listando tools disponibles...`);
  // Mismo patrón de timeout que callMCP: sin AbortController, un MCP colgado dejaba este fetch (y el job) pendiente para siempre.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MCP_TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: IBT_HEADERS,
      signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 })
    });
    // La lectura del body va dentro del try (igual que callMCP): un stream SSE colgado tras los
    // headers haría que res.text() espere para siempre fuera del alcance del AbortController.
    text = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') console.error(`[MCP] listMCPTools ABORTADA por timeout (${MCP_TIMEOUT_MS}ms).`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
   SEÑALES DE COMPRA (la lista "Señales" bajo cada cuenta, si aparece): vienen CON su fuente y fecha citadas, así que NO las marques como inventadas por ser específicas (la fuente citada ES el respaldo). SOLO marcá FAIL acá si una señal NO muestra ninguna fuente, o si la cifra es absurda o imposible para esa empresa.

5. **Coherencia interna + GEOGRAFÍA + VERTICAL** (CRÍTICO) — el reporte trata sobre la empresa correcta y las cuentas hacen sentido para ese ICP.
   FAIL si una cuenta target es la misma empresa mencionada como proof point/cliente del producto en el overview.
   FAIL si una cuenta target está ubicada en un país donde el cliente NO opera / no puede prestar el servicio (mirá la geografía que declara la página 1, el título h1_post y la prosa del lead: las cuentas deben estar en los países de operación del cliente, priorizando el país principal).
   FAIL si la industria/vertical real de una cuenta target está claramente FUERA de las verticales del ICP definido en la página 1 (overview + perfil objetivo). Ejemplos reales de incoherencia a rechazar: una agencia de marketing, una aseguradora, una empresa de energía o cualquier rubro ajeno coladas cuando el ICP apuntaba a otro vertical. Inferí la industria de la cuenta a partir de su nombre, su cargo y el contexto del ángulo/hook; si NO podés determinarla con razonable certeza, NO marques FAIL por este motivo (en duda sobre el rubro, dejá pasar este sub-criterio).
   FIT DE NEGOCIO (no solo vertical): además del rubro, FAIL si una cuenta comparte el vertical pero CLARAMENTE NO es un comprador del producto del cliente, y el ángulo/hook MAQUILLA ese mismatch afirmando un fit que no existe. Patrones de FAIL a reconocer: (a) MARCA PROPIA / casa de marca que solo vende lo suyo y NO aloja ni revende terceros, cuando el cliente le vende a canales MULTIMARCA, y el hook afirma que "incorpora/aloja marcas externas" (ej. una marca DTC tipo Inditex/Zara que justamente NO revende joyería de terceros); (b) GIGANTE Fortune-50 elegido como cuenta de un proveedor chico/startup donde el ciclo de venta es irreal; (c) CONTRATISTA / ASESOR / micro-empresa cuando el ICP pide OPERADORES medianos-grandes; (d) MISMO SUSTANTIVO, DISTINTO NEGOCIO (flota de camiones presentada como fit de flota de robots; perforación de agua/anclajes presentada como voladura minera). SALVAGUARDA ANTI FALSO POSITIVO (mantené la del rubro): esto es razonamiento de negocio APROXIMADO. Marcá FAIL SOLO cuando el mismatch es EVIDENTE por el nombre/cargo/hook (sobre todo si el hook afirma una adopción que esa empresa notoriamente NO hace). Si NO podés determinar con razonable certeza que la empresa NO es comprador, NO marques FAIL por este motivo: en duda, dejá pasar.
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

REGLA DE FORMATO DE "fixes" (CRÍTICA — si el JSON se trunca, se pierde tu voto y se rechaza por seguridad): "fixes" tiene MÁXIMO 2 ítems, cada uno CONCISO (1-2 oraciones, instrucción directa). NO enumeres todos los problemas: priorizá los 2 más graves. NO escribas párrafos largos ni listes card por card; un fix puntual y accionable por ítem.

APROBADO solo si pasa los 8/8. Si RECHAZADO, "fixes" lista instrucciones concretas (máximo 2).`;

// ---------------------------------------------------------------------------
// Llamadas a Claude — CON PROMPT CACHING + logging de tokens
// ---------------------------------------------------------------------------
async function callClaude({ model, system, messages, tools = [], stopSequences = [], maxTokens = 16000, temperature }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages
  };
  // Solo se setea si se pasa explícitamente; las llamadas que no la pasan quedan en el default del modelo.
  if (typeof temperature === 'number') body.temperature = temperature;

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

// Un único voto del juez. Devuelve siempre un veredicto normalizado (APROBADO solo 8/8);
// fail-closed individual: si no parsea o es incoherente → RECHAZADO (nunca lo descartamos).
async function _judgeVote(htmlLite, pageCount, temperature, voteIdx) {
  try {
    const data = await callClaude({
      model: MODEL_JUDGE,
      system: SYSTEM_PROMPT_JUDGE,
      messages: [{
        role: 'user',
        content: `Cuentas esperadas: ${NUM_CUENTAS}\nPáginas esperadas: ${EXPECTED_PAGES>0?EXPECTED_PAGES:'no validar'}\nPáginas del PDF renderizado: ${pageCount}\n\nHTML del reporte:\n${htmlLite}`
      }],
      maxTokens: 6000,
      temperature
    });
    const raw = data.content.find(b => b.type === 'text')?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const result = {
      veredicto: parsed.veredicto || 'RECHAZADO', // sin veredicto explícito → rechazar (fail-closed)
      score: parsed.score ?? 0,
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes : []
    };
    // Coherencia: el juez solo APRUEBA si pasa los 8/8. Un APROBADO con score<8 es
    // incoherente (o un fallback) → se rechaza por seguridad para no enviar sin revisar.
    if (result.veredicto === 'APROBADO' && result.score < 8) {
      console.warn(`[JUDGE] voto#${voteIdx}: veredicto incoherente (APROBADO ${result.score}/8) → RECHAZADO por seguridad.`);
      result.veredicto = 'RECHAZADO';
      if (!result.fixes.length) result.fixes = ['Veredicto incoherente del juez (APROBADO con score < 8); se rechaza por seguridad.'];
    }
    console.log(`[JUDGE] voto#${voteIdx}: ${result.veredicto} ${result.score}/8`);
    return result;
  } catch (e) {
    // FAIL-CLOSED individual: un voto que no parsea cuenta como RECHAZADO (no se descarta).
    console.error(`[JUDGE] voto#${voteIdx}: no se pudo parsear → RECHAZADO por seguridad (fail-closed):`, e.message);
    return { veredicto: 'RECHAZADO', score: 0, fixes: ['El juez no devolvió un veredicto parseable; se rechaza por seguridad para no enviar un reporte sin revisar.'] };
  }
}

async function runJudge(html, pageCount) {
  _setStage('judge');
  console.log(`[JUDGE] Evaluando reporte (${pageCount} páginas, esperadas ${EXPECTED_PAGES>0?EXPECTED_PAGES:'no validar'}, cuentas ${NUM_CUENTAS}, votos ${JUDGE_VOTES})...`);
  const htmlLite = String(html || '')
    .replace(/src="data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+"/gi, 'src="[LOGO]"')
    .replace(/<style>[\s\S]*?<\/style>/i, '<style>/* css omitido para el juez */</style>');

  // JUDGE_VOTES===1 → comportamiento histórico: 1 voto a TEMP_JUDGE (0).
  // N>1 → N votos INDEPENDIENTES a TEMP_JUDGE_VOTE (>0), en PARALELO para no sumar latencia.
  const tempVoto = JUDGE_VOTES === 1 ? TEMP_JUDGE : TEMP_JUDGE_VOTE;
  const votos = await Promise.all(
    Array.from({ length: JUDGE_VOTES }, (_, i) => _judgeVote(htmlLite, pageCount, tempVoto, i + 1))
  );

  // Agregación CONSERVADORA / fail-closed: APROBADO final SOLO si la MAYORÍA de los votos
  // dieron APROBADO 8/8 (cada voto ya garantiza 8/8 por la coherencia interna). Empate o
  // minoría → RECHAZADO. El producto es credibilidad: preferimos reducir falsos APROBADO.
  const aprueban = votos.filter(v => v.veredicto === 'APROBADO');
  const rechazan = votos.filter(v => v.veredicto !== 'APROBADO');
  const mayoriaAprueba = aprueban.length > JUDGE_VOTES / 2;

  let result;
  if (mayoriaAprueba) {
    result = { veredicto: 'APROBADO', score: 8, fixes: [] };
  } else {
    // Juntamos y deduplicamos los fixes de los votos que RECHAZARON, para que
    // seleccionarConRetry tenga material concreto con qué corregir.
    const fixes = [...new Set(rechazan.flatMap(v => v.fixes).map(f => String(f).trim()).filter(Boolean))];
    const score = rechazan.length ? Math.min(...rechazan.map(v => v.score ?? 0)) : 0;
    result = {
      veredicto: 'RECHAZADO',
      score,
      fixes: fixes.length ? fixes : ['El juez rechazó el reporte sin fixes explícitos; se rechaza por seguridad.']
    };
  }

  console.log(`[JUDGE] votos: APROBADO×${aprueban.length} RECHAZADO×${rechazan.length} → ${result.veredicto}`);
  console.log(`[JUDGE] Veredicto: ${result.veredicto} ${result.score}/8`);
  if (result.fixes.length > 0) console.log(`[JUDGE] Fixes: ${result.fixes.join(' | ')}`);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers de texto / identidad
// ---------------------------------------------------------------------------
function _stripTags(s){return (s||'').replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();}
function _norm(s){return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
// VOCABULARIO DE LA VERTICAL DEL COMPRADOR: tokeniza industrias + funcion + titulos_objetivo en palabras sueltas (>=4 chars).
// Lo usa la salvaguarda de competidor_terminos: comparar el t\u00e9rmino competidor contra PALABRAS (no contra el string
// multi-palabra entero, que hac\u00eda que "inmobiliaria" no matcheara "servicios financieros inmobiliarios" \u2192 se filtraba
// err\u00f3neamente a las inmobiliarias, que son los COMPRADORES de un CRM como NOCNOK).
function _vocabVertical(icp){
  const campos = []
    .concat(Array.isArray(icp.industrias) ? icp.industrias : [])
    .concat(icp.funcion ? [icp.funcion] : [])
    .concat(Array.isArray(icp.titulos_objetivo) ? icp.titulos_objetivo : []);
  const tokens = new Set();
  for(const c of campos){ for(const w of _norm(c).split(' ')){ if(w.length >= 4) tokens.add(w); } }
  return [...tokens];
}

// GEO: el loc de LinkedIn casi nunca trae el nombre del pa\u00eds para US/UK/etc. ("Atlanta y alrededores",
// "Dallas-Fort Worth", "Greater London") \u2192 un includes("united states") da SIEMPRE 0 y rompe `cerca`
// (que es el primer criterio de todos los sorts). Para esos pa\u00edses damos un set de alias/variantes con las
// que S\u00cd aparecen textualmente. En LatAm el pa\u00eds s\u00ed aparece en el loc ("M\u00e9xico", "Argentina") y el includes
// ya andaba; igual sumamos sus variantes para no perder nada. _norm() ya saca puntos/acentos ("u.s."\u2192"u s").
// OJO: solo tokens NO ambiguos. Las siglas de 2 letras como "us"/"uk" se descartaron a propósito porque
// _norm hace includes de SUBSTRING y "us" matchea dentro de "houston"/"australia" (falso positivo de cerca).
const _GEO_ALIASES = {
  'united states':        ['united states','estados unidos','ee uu','eeuu','usa','u s a'],
  'estados unidos':       ['united states','estados unidos','ee uu','eeuu','usa','u s a'],
  'united kingdom':       ['united kingdom','reino unido','england','great britain','scotland','wales'],
  'reino unido':          ['united kingdom','reino unido','england','great britain','scotland','wales'],
  'united arab emirates': ['united arab emirates','emiratos arabes unidos','uae','u a e'],
  'south korea':          ['south korea','corea del sur'],
  'czech republic':       ['czech republic','czechia','republica checa'],
};
// Alias normalizados para un pa\u00eds dado. Si no est\u00e1 en la tabla, el set es solo su propio _norm.
function _geoAliasSet(nombrePais){
  const n = _norm(nombrePais);
  const lista = _GEO_ALIASES[n] || [n];
  return new Set(lista.map(_norm).filter(Boolean));
}
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

// Puppeteer (launch/setContent/pdf) es el hang más probable del pipeline: si Chromium se cuelga,
// estos await no vuelven nunca. Todo el bloque corre contra un timeout (PDF_TIMEOUT_MS, default 60s);
// si se dispara, el finally cierra el browser igual para no dejar Chromium colgado y se relanza el error
// (el caller ya lo maneja).
const PDF_TIMEOUT_MS = parseInt(process.env.PDF_TIMEOUT_MS || '60000', 10);

async function renderizarPdf(cleanHtml) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  let timer;
  try {
    const trabajo = (async () => {
      const page = await browser.newPage();
      await page.setContent(cleanHtml, { waitUntil: 'networkidle0' });
      return await page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '0', bottom: '0', left: '0', right: '0' }
      });
    })();
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`renderizarPdf timeout (>${PDF_TIMEOUT_MS}ms)`)), PDF_TIMEOUT_MS);
    });
    return await Promise.race([trabajo, timeout]);
  } finally {
    clearTimeout(timer);
    await browser.close().catch(e => console.error('[PDF] error cerrando browser:', e.message));
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
// ¿El input es un link/slug de EMPRESA de LinkedIn (no un dominio real)? Cubre /company/ y /school/
// (también showcase). Devuelve el slug si lo es, o '' si no. Un dominio común tipo "robotic-crew.com"
// NO matchea (no contiene linkedin.com/company|school|showcase) → camino normal intacto.
function _slugLinkedInCompany(input){
  const s = String(input||'').trim();
  if(!s) return '';
  const m = s.match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]).trim() : '';
}
// Nombre tentativo de empresa desde un dominio: primer label antes del punto, guiones/underscores -> espacios
// (ej. "robotic-crew.com" -> "robotic crew"). Para el fallback por nombre en Sales Nav. '' si es LinkedIn.
function _nombreDeDominio(dom){
  const s = String(dom||'').trim().replace(/^https?:\/\//i,'').replace(/^www\./i,'');
  if(!s || /linkedin\.com/i.test(s)) return '';
  return s.split('/')[0].split('.')[0].replace(/[-_]+/g,' ').trim();
}
// Dominio/website REAL de la empresa desde el texto crudo de lookup_company. BEST-EFFORT: el endpoint
// /api/mcp devuelve TEXTO (no JSON), así que cubrimos formatos plausibles ("Website: X", "Domain: X",
// "URL: X") y, como último recurso, el primer dominio suelto que NO sea linkedin. NUNCA fabrica: devuelve
// '' si no encuentra nada confiable. Limpia esquema/www/path para quedarnos con el host (ej. "robotic-crew.com").
function _dominioDeLookup(txt){
  const s = String(txt||'');
  let m = s.match(/\b(?:website|web site|web|domain|dominio|url|site)\s*[:=]\s*(\S+)/i);
  let raw = m ? m[1] : '';
  if(!raw){
    // Fallback: primer dominio suelto en el texto que no sea de linkedin.
    const cand = [...s.matchAll(/\bhttps?:\/\/[^\s)"']+|\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\b/gi)]
      .map(x=>x[0]).find(d => !/linkedin\.com/i.test(d));
    raw = cand || '';
  }
  const host = String(raw).replace(/^https?:\/\//i,'').replace(/^www\./i,'').split(/[/?#]/)[0].trim().toLowerCase();
  if(!host || !host.includes('.') || /linkedin\.com/i.test(host)) return '';
  return host;
}
// SEÑALES: intenta leer un TOTAL agregado del texto crudo de search_sales_navigator_filtered.
// El gateway de claude.ai expone paging.total_count en JSON, pero el endpoint /api/mcp del server
// devuelve TEXTO (otra serialización). NO está garantizado que el texto traiga el total; por eso esto
// es BEST-EFFORT: cubre formatos plausibles ("total: N", "total_count: N", "N results/resultados/matches")
// y devuelve null si no encuentra un total fiable. NUNCA fabrica el número. OJO: el grado en el filtro de
// people trae un total_count basura (ver nota de memoria), por eso solo se usa el total en búsquedas SIN
// filtro de grado (las que hace el server). Si null → el caller cae a un label honesto sobre lo que SÍ tiene.
function _totalDe(txt){
  const s = String(txt||'');
  let m = s.match(/\btotal[_\s]?count\b\s*[:=]\s*([\d][\d.,]*)/i)
       || s.match(/\btotal\b\s*[:=]\s*([\d][\d.,]*)/i)
       || s.match(/([\d][\d.,]*)\s*(?:results?|resultados?|matches|coincidencias|empresas|companies|personas|people)\s*(?:total|en total|encontrad)/i);
  if(!m) return null;
  const n = parseInt(String(m[1]).replace(/[.,]/g,''),10);
  return (Number.isFinite(n) && n>0) ? n : null;
}
// Formatea un total grande a algo legible en es-LA (13024 -> "≈13.000"). Conserva exactitud para chicos.
function _fmtAprox(n){
  if(n==null) return '';
  if(n < 1000) return String(n);
  const r = n>=10000 ? Math.round(n/1000)*1000 : Math.round(n/100)*100;
  return '≈' + r.toLocaleString('es-MX');
}
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

// VERTICALES A EXCLUIR (ruido adyacente): el PLAN puede agregar icp.verticales_excluir (rubros
// adyacentes que ensucian el pool, ej. geotecnia/militar/consultoría para un cliente de detección).
// Defensivo: si el campo no existe todavía, _verticalesExcluir(plan) devuelve [] y nada se filtra.
// Match contra el NOMBRE de empresa Y la industria (texto crudo) del candidato. Términos de >=4 chars
// para evitar falsos positivos (substring includes). NO debe pisar el vertical legítimo del comprador:
// eso lo controla el PLAN (no debe listar el propio vertical en verticales_excluir).
function _verticalesExcluir(plan){
  const p = (plan && plan._plan) || {};
  const arr = Array.isArray(p.verticales_excluir) ? p.verticales_excluir : [];
  return arr.map(_norm).filter(t => t && t.length >= 4);
}
// ¿El texto (nombre de empresa / industria / headline) matchea alguna vertical a excluir?
function _matchVerticalExcluir(txt, excluir){
  const t = _norm(txt||''); if(!t) return false;
  return (excluir||[]).some(v => t.includes(v));
}

// UN reintento ACOTADO para la resolución INICIAL del cliente: es la PRIMERA llamada MCP del job y si
// el MCP está frío (post-redeploy) y la primera se cae por timeout, mata el job entero antes de empezar.
// Solo reintenta ante timeout/red (AbortError o falla de fetch), NO ante respuesta inservible. Costo de
// latencia: 1 reintento = hasta 2x MCP_TIMEOUT_MS (~90s) en el peor caso, aceptable dentro del cinturón
// global de 8 min. NO se usa en `corroborar` (enriquecimiento, no crítico) para no sumar latencia ahí.
async function _callMCPClienteConRetry(toolName, args) {
  try {
    return await callMCP(toolName, args);
  } catch (e) {
    const reintentable = (e && (e.name === 'AbortError' || e.name === 'TypeError' || /fetch|network|ECONN/i.test(e.message || '')));
    if (!reintentable) throw e;
    console.warn(`[CLIENTE] ${toolName} falló (${e.name || e.message}); 1 reintento (MCP posiblemente frío)...`);
    return await callMCP(toolName, args);
  }
}

async function resolverCliente({ profileId, dominio, empresa }) {
  // LINK DE LINKEDIN DE EMPRESA: si en `dominio` (o `empresa`) llega un link/slug de company/school de
  // LinkedIn, NO es un dominio usable (quedaría "linkedin.com"). Lo resolvemos vía lookup_company para
  // obtener el NOMBRE real (siempre) y el dominio/website real (si el MCP lo expone). Con eso seguimos
  // el flujo normal: dominio real -> camino de dominio; sin dominio -> al menos nombre real para PLAN/sourcing.
  const slugLI = _slugLinkedInCompany(dominio) || _slugLinkedInCompany(empresa);
  if(slugLI){
    try{
      const txt = await _callMCPClienteConRetry('lookup_company', { companyUrlOrName: slugLI });
      const empLI = _empresaDeLookup(txt) || empresa || slugLI.replace(/[-_]+/g,' ').trim();
      const domLI = _dominioDeLookup(txt);
      const hcLI  = _headcountDe(txt);
      console.log(`[CLIENTE] link LinkedIn "${slugLI}" -> empresa "${empLI}" (dominio ${domLI || 'no disponible'}, ${hcLI ?? '?'} empleados)`);
      // Anclamos DIRECTO con los datos de la página de la empresa en LinkedIn (nombre + headcount = confiables).
      // NO re-consultamos el dominio: el lookup POR-DOMINIO puede estar roto aunque la empresa exista (visto:
      // robotic-crew.com -> 500 "company no longer exists", pero el slug /company/robotic-crew sí resuelve).
      return { empresa: empLI, dominio: domLI || '', headcount: hcLI, tier: _tier(hcLI), anclado: true, fuente: 'linkedin_company', confianza: hcLI ? 'alta' : 'media' };
    }catch(e){
      console.warn(`[CLIENTE] lookup_company para link LinkedIn "${slugLI}" falló:`, e.message);
      // Aun fallando: el slug es mejor cliente que "linkedin.com". Lo usamos como nombre (lo agarra el fallback
      // por nombre de abajo) y limpiamos el dominio LinkedIn para que NO contamine downstream.
      if(!empresa) empresa = slugLI.replace(/[-_]+/g,' ').trim();
      dominio = '';
    }
  }
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
      const txt = await _callMCPClienteConRetry('get_contact_profile', { profileId: Number(profileId) });
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
      const txt = await _callMCPClienteConRetry('lookup_company', { companyUrlOrName: dominio });
      const emp = _empresaDeLookup(txt) || empresa || dominio;
      const hc = _headcountDe(txt);
      console.log(`[CLIENTE] anclado por dominio ${dominio} -> "${emp}" (${hc ?? '?'} empleados, tier ${_tier(hc)})`);
      return { empresa: emp, dominio, headcount: hc, tier: _tier(hc), anclado: true, fuente: 'dominio', confianza: 'media' };
    } catch (e) { console.warn(`[CLIENTE] dominio ${dominio} no resolvió:`, e.message); }
  }
  // FALLBACK por NOMBRE (Sales Navigator): no anclamos por perfil ni por dominio. Antes de rendirnos,
  // confirmamos la empresa por NOMBRE vía resolve — más robusto que el lookup por dominio (resolve encontró
  // "Robotic Crew" cuando robotic-crew.com daba 500). Si existe en Sales Nav, anclamos por nombre canónico.
  const nombreCand = String(empresa || '').trim() || (dominio && !_esEmailGratuito(dominio) ? _nombreDeDominio(dominio) : '');
  if(nombreCand){
    try{
      const txt = String(await _callMCPClienteConRetry('resolve_sales_navigator_id', { type:'COMPANY', keywords:nombreCand, limit:5 }));
      const ms = [...txt.matchAll(/id="?([0-9]+)"?\s+"([^"]+)"/g)].map(m=>({ id:m[1], name:m[2] }));
      const hit = ms.find(x => _empKey(x.name) === _empKey(nombreCand)) || ms[0];   // match exacto > primer match
      if(hit){
        console.log(`[CLIENTE] anclado por NOMBRE vía Sales Nav: "${hit.name}" (id ${hit.id}) [perfil/dominio no resolvió]`);
        return { empresa: hit.name, dominio: dominio || '', headcount: null, tier: null, anclado: true, fuente: 'sales_nav_nombre', confianza: 'media' };
      }
    }catch(e){ console.warn(`[CLIENTE] fallback por nombre "${nombreCand}" falló:`, e.message); }
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
// Marcadores de DECISIÓN: si el cargo trae alguno, la persona decide (gerencia/dueño/jefatura), aunque el
// texto también diga "agente". Se usa como salvavidas en _esICsuelto y como detector en _icpPideDecisores.
const _MARCADOR_DECISION = /\b(dueno|owner|founder|co founder|cofounder|director|directora|gerente|jefe|jefa|head|vp|vice|vicepresidente|chief|c level|ceo|coo|cfo|cto|cmo|broker|socio|presidenta?|propietari[oa]|lider|leader|manager)\b/;
// ¿El cargo es un CONTRIBUIDOR INDIVIDUAL / usuario final SIN marcador de decisión? (caso NOCNOK: "agente",
// "asociado", "especialista en propiedades"). Si tiene un marcador de decisión NO es IC suelto, aunque diga
// "agente". "asesor" cuenta como IC pero NO "asesoria" (firma/área). Reusa _norm (sin tildes, minúsculas).
function _esICsuelto(cargo){
  const c = _norm(cargo);
  if(!c) return false;
  if(_MARCADOR_DECISION.test(c)) return false;                 // tiene mando -> NO es IC suelto
  // "asesor/a" sí, pero "asesoria" (sustantivo de área/firma) no debe contar
  const esAsesorPersona = /\basesor(a|es|as)?\b/.test(c) && !/\basesoria/.test(c);
  const ic = /\b(agente|agent|asociad[oa]|associate|especialista|specialist|profesional inmobiliario|analista|analyst|representante|representative|realtor|vendedor|vendedora|salesperson|consultor|consultora|consultant)\b/.test(c)
    || esAsesorPersona
    || /\b(ejecutiv[oa]\s+de\s+(ventas|cuentas)|account\s+executive|sales\s+(rep|representative))\b/.test(c);  // IC en ES/EN ("agent"≠"agente": el MCP trae headlines en inglés)
  return ic;
}
// ¿El ICP claramente apunta a GERENCIA/DUEÑO (no a ICs)? Heurística: la función del comprador y/o los
// títulos objetivo traen marcador de decisión y NO son roles de IC. Si el ICP legítimamente busca ICs
// (ej. todos los títulos son "agente/analista"), devuelve false y NO penalizamos.
function _icpPideDecisores(plan){
  const p = (plan && plan._plan) || {};
  const funcion = _norm(p.funcion || '');
  const titulos = Array.isArray(p.titulos_objetivo) ? p.titulos_objetivo : [];
  const textoTitulos = titulos.map(t=>_norm(t)).filter(Boolean);
  const funcionDecide = _MARCADOR_DECISION.test(funcion);
  const tituloDecide  = textoTitulos.some(t => _MARCADOR_DECISION.test(t));
  // Si CUALQUIER señal del ICP apunta a decisión, tratamos el ICP como "pide decisores".
  return funcionDecide || tituloDecide;
}
// ¿El headline contiene alguno de los títulos objetivo del ICP? (match de FUNCIÓN, separado de la seniority).
function _matchFuncion(head, titulos){
  const h=_norm(head);
  const lista = Array.isArray(titulos) ? titulos : [];
  return lista.some(t=>{ const n=_norm(t); return n && n.length>=2 && h.includes(n); });
}
function _rankFit(head, titulos){
  return (_matchFuncion(head, titulos) ? 100 : 10) + _rankSenioridad(head);
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
// SEÑALES DE COMPRA (datos REALES del MCP, jamás inventados): además de id/name/head/dist/loc,
// extraemos por persona `recienAsumio` (de recentlyHired = cambió de trabajo/asumió el rol hace poco,
// LA señal más fuerte) y `posts` (de recentPostsCount = actividad reciente en LinkedIn). El parseo es
// TOLERANTE: capturamos la "cola" de cada persona (hasta el próximo id= o el fin) y buscamos ahí los
// campos; si el gateway no los trae en esta respuesta, default false/0 y avisamos UNA vez con [SIGNALS].
function _parsePeople(res){
  const s = String(res||'');
  // El regex base no cambia (id, name, head, DISTANCE, loc); sumamos un grupo "tail" no-codicioso que
  // arranca tras el ')' del bloque DISTANCE y se corta antes del próximo `id=` (o el fin del texto). En
  // esa cola viene el resto de campos del candidato (recentlyHired/recentPostsCount), en cualquier orden.
  const re = /id=([A-Za-z0-9_\-]+)\s+"([^"]+)"\s+(.*?)\s*\(DISTANCE_(\d|OUT_OF_NETWORK)[^,)]*(?:,\s*([^)]+))?\)(.*?)(?=\s+id=[A-Za-z0-9_\-]+\s+"|$)/gs;
  const out = [];
  for(const x of s.matchAll(re)){
    const tail = x[6] || '';
    // recentlyHired / recently_hired -> booleano. Toleramos "true"/"false", 1/0, o la clave presente sin valor explícito.
    // CONFIRMADO en producción (brandtrack): este campo per-persona NO viaja en el texto del /api/mcp, así que el
    // parseo casi siempre da false. Lo dejamos TOLERANTE por si algún día el gateway lo serializa, pero SIN loguear
    // por lote (era spam): el aviso resumido vive en sourceCandidates. La señal real viene de la Pasada D.
    const mHired = tail.match(/recently[_\s]?[Hh]ired"?\s*[:=]?\s*(true|false|1|0)?/i);
    const recienAsumio = !!(mHired && /^(true|1)$/i.test(mHired[1]||''));
    // recentPostsCount / recentPosts -> número (puede venir null). Default 0.
    const mPosts = tail.match(/recent[_\s]?[Pp]osts(?:[_\s]?[Cc]ount)?"?\s*[:=]?\s*(\d+)/i);
    const posts = mPosts ? parseInt(mPosts[1],10) : 0;
    out.push({ id:x[1], name:x[2], head:(x[3]||'').trim(), dist: x[4]==='OUT_OF_NETWORK'?9:parseInt(x[4],10), loc:(x[5]||'').trim(), recienAsumio, posts });
  }
  return out;
}
function _parseProfile(res){
  const s=String(res||'');
  const hc=(s.match(/(\d[\d,]*)\s+employees/)||[])[1];
  let headRich=((s.match(/—\s*(.+?)\s*\(\s*(?:\?|\d)/)||[])[1]||'').trim();
  headRich=headRich.replace(/\s*@\s*\?\s*$/,'').trim();
  // SEÑAL DE COMPRA sobre el FINALISTA (datos REALES del MCP, jamás inventados): get_contact_profile PODRÍA
  // exponer en el texto una señal de recién-cambió-de-trabajo / antigüedad-en-el-rol. NO está confirmado que
  // el endpoint /api/mcp la serialice (el gateway JSON sí, el texto puede que no). Por eso el parseo es
  // TOLERANTE: si encontramos la señal, devolvemos recienAsumio=true sobre un candidato que YA pasó el embudo
  // (buen fit); si no aparece, recienAsumio=null (desconocido, NO false: no pisamos una señal previa de la Pasada D).
  // Toleramos varias formas: recentlyHired/recently_hired true|1, "started ... 2025/2026" reciente,
  // "X month(s) in role/position", "menos de un año en el cargo", "changedJobs(Last90Days) true".
  let recienAsumio = null;
  if(/recently[_\s]?hired"?\s*[:=]?\s*(true|1)\b/i.test(s)) recienAsumio = true;
  else if(/changed[_\s]?jobs(?:[_\s]?last90days)?"?\s*[:=]?\s*(true|1)\b/i.test(s)) recienAsumio = true;
  else if(/\b(\d{1,2})\s*(?:months?|meses)\s+(?:in|en)\s+(?:role|position|el\s+(?:rol|cargo|puesto))/i.test(s)){
    const m = s.match(/\b(\d{1,2})\s*(?:months?|meses)\s+(?:in|en)/i);
    if(m && parseInt(m[1],10) <= 12) recienAsumio = true;     // hasta 12 meses en el rol = recién asumió
  }
  else if(/(?:menos de un a[nñ]o|less than a year)\s+(?:en|in)\s+(?:el\s+)?(?:rol|cargo|puesto|role|position)/i.test(s)) recienAsumio = true;
  return { headcount: hc?parseInt(hc.replace(/,/g,''),10):null, headRich, recienAsumio };
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

async function sourceCandidates(plan, cliente, conSenal = true){
  validarPlan(plan);
  const icp = plan._plan;
  // GEO-COHERENCIA (determinística, defensa en profundidad): el sourcing confía en `geografia` (país PRINCIPAL).
  // Bug visto (Robotic Crew US): el PLAN devolvió geografia="Argentina" pero geografias=["Estados Unidos"] → se
  // buscó en el país equivocado (cards argentinas). Si `geografia` NO está en `geografias` (normalizado) hay
  // contradicción interna: `geografias` es lo que el PLAN identificó como operación real → auto-corregimos el
  // principal a geografias[0]. NO tocamos el caso normal (geografia ya está en geografias) ni el multi-país legítimo.
  {
    const geos = (Array.isArray(icp.geografias) ? icp.geografias : []).filter(g => g && String(g).trim());
    if (geos.length) {
      const principal = _norm(icp.geografia || '');
      const estaEnLista = geos.some(g => _norm(g) === principal);
      if (!principal || !estaEnLista) {
        console.warn(`[GEO] geografia incoherente ("${icp.geografia||''}" no está en geografias [${geos.join(', ')}]) → uso "${geos[0]}".`);
        icp.geografia = geos[0];
      }
    }
  }
  const geografia = icp.geografia;            // país principal del cliente (ya geo-coherente)
  const homeGeo   = _norm(geografia||'');
  const funcion   = icp.funcion;
  const titulos   = Array.isArray(icp.titulos_objetivo) ? icp.titulos_objetivo : [];
  const industriasICP = Array.isArray(icp.industrias) ? icp.industrias : [];   // pista de vertical para _rolRelevante
  // ¿El ICP pide gerencia/dueño? Solo entonces penalizamos a los contribuidores individuales (caso NOCNOK).
  // Si el ICP legítimamente apunta a ICs, pideDecisores=false y NO se penaliza nada (CONDICIONAL).
  const pideDecisores = _icpPideDecisores(plan);

  // países donde el cliente opera (secundarios), sin el principal
  const todas = (Array.isArray(icp.geografias) && icp.geografias.length ? icp.geografias : [geografia]).filter(Boolean);
  const secundarias = todas.filter(g => _norm(g) !== homeGeo).slice(0, 5);

  // CERCANÍA al país del cliente. El includes(homeGeo) frágil daba `cerca=0` para TODO el pool US/UK porque
  // el loc de LinkedIn es la ciudad ("Atlanta y alrededores"), nunca "united states". Estrategia:
  //  - UN solo país (sin secundarias): TODO el pool vino del filtro de homeLoc → cerca=1 para todos (seguro).
  //  - multi-país: includes con set de ALIAS del país principal (homeAliases) como fallback textual.
  const unSoloPais = secundarias.length === 0;
  const homeAliases = _geoAliasSet(geografia);
  const _esCerca = (loc) => {
    if (unSoloPais) return 1;                 // todo el pool ya está filtrado al país del cliente
    const l = _norm(loc || ''); if (!l) return 0;
    for (const a of homeAliases) if (a && l.includes(a)) return 1;
    return 0;
  };

  // TÉRMINOS de rol: Sales Navigator NO tolera keywords multi-palabra (las trata como frase casi-exacta
  // y devuelve 0). Buscamos UN término por vez y unimos. Cada título objetivo es un término (1-2 palabras).
  // Hasta 6 para que entren tanto los roles de facilities como los del producto/canal del cliente.
  const terminos = (titulos.length ? titulos : [funcion])
    .map(t=>String(t||'').replace(/[\/|]+/g,' ').replace(/\s+/g,' ').trim())
    .filter(t=>t.length>=3)
    .slice(0,6);

  // Devuelve TODOS los ids que son EL PAÍS (country-level), no uno solo. Sales Navigator a veces tiene
  // varios nodos para el mismo país por variantes de escritura (ej. "Mexico" VACÍO y "México, Mexico"
  // POBLADO); quedarse con uno solo por match exacto perdía el nodo con datos. País-level = la parte
  // antes de la primera coma, normalizada, === _norm(nombrePais). Así excluimos estados ("New Mexico,
  // United States" -> "new mexico"), ciudades ("Mexico City, Mexico") y provincias ("Jalisco, Mexico").
  async function locIds(nombrePais){
    try{
      const objetivo = _norm(nombrePais);
      const txt = String(await callMCP('resolve_sales_navigator_id',{type:'LOCATION',keywords:nombrePais,limit:8}));
      const matches = [...txt.matchAll(/id="?([0-9]+)"?\s+"([^"]+)"/g)].map(m=>({id:m[1],name:m[2]}));
      const paisLevel = matches.filter(m => _norm(String(m.name).split(',')[0]) === objetivo);
      const ids = [...new Set(paisLevel.map(m=>m.id))];
      if(ids.length){
        console.log(`[SOURCE] LOCATION "${nombrePais}" -> ${ids.length} ids país-level: ${ids.join(', ')}`);
        return ids;
      }
      // Ningún match país-level: fallback al primer match (comportamiento previo) con aviso.
      if(matches[0]) console.warn(`[SOURCE] LOCATION "${nombrePais}": sin match país-level, uso "${matches[0].name}" (${matches[0].id}).`);
      return matches[0] ? [matches[0].id] : [];
    }catch{ return []; }
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
  // SEÑALES: guardamos el último texto crudo de una búsqueda de people (para leer un total si lo trae el MCP).
  let txtPeopleSenal = '';
  async function buscarUno(locIds, conIndustria, kwUnico, soloRecienCambio){
    const f={ category:'people', profilesLimit:SOURCE_PROFILES_LIMIT };
    if(kwUnico) f.keywords = kwUnico;                       // UNA sola palabra/término (multi-palabra da 0)
    if(locIds && locIds.length) f.location={ include: locIds };
    if(fnId) f.function={ include:[fnId] };
    if(conIndustria && indIds.length) f.industry={ include: indIds };
    // SEÑAL DE COMPRA: pasada ADITIVA opcional que filtra a los que cambiaron de trabajo en los últimos 90
    // días (decisor nuevo = ventana de compra). NO reemplaza la búsqueda normal: alimenta el pool para que
    // los recién-cambiados COMPITAN en el ranking (filtrar solo por esto sesgaría a puro recién-cambiado).
    if(soloRecienCambio) f.changedJobsLast90Days = true;
    try{ const txt = String(await callMCP('search_sales_navigator_filtered', f)); if(!txtPeopleSenal) txtPeopleSenal = txt; return _parsePeople(txt); }catch{ return []; }
  }
  // Une los resultados de buscar cada término de rol por separado (dedupe por id), en PARALELO con tope CONC.
  const CONC = parseInt(process.env.SOURCE_CONCURRENCY || '4', 10);
  async function buscar(locIds, conIndustria, soloRecienCambio){
    if(!terminos.length) return await buscarUno(locIds, conIndustria, null, soloRecienCambio);
    const listas = await _mapLimit(terminos, CONC, t => buscarUno(locIds, conIndustria, t, soloRecienCambio));
    const acc=[]; const vis=new Set();
    for(const lista of listas){ for(const p of (lista||[])){ if(p.id && !vis.has(p.id)){ vis.add(p.id); acc.push(p); } } }
    return acc;
  }
  const _validosHome = arr => arr.filter(p => _rankSenioridad(p.head) >= 2 && _esCerca(p.loc)).length;

  // GEOGRAFÍA: país principal PRIMERO + países donde el cliente HOY opera (cercanos).
  const homeLoc = await locIds(geografia);    // todos los ids país-level del país principal
  const opsIds  = [];
  for(const g of secundarias){
    for(const id of await locIds(g)){ if(!homeLoc.includes(id) && !opsIds.includes(id)) opsIds.push(id); }
  }
  const geoLoc  = [...new Set([...homeLoc, ...opsIds])];
  const geoLocOrNull = geoLoc.length ? geoLoc : null;
  const HOME_MIN = parseInt(process.env.SOURCE_HOME_MIN || String(NUM_CUENTAS + 2), 10);

  // Competidores a EXCLUIR (se calculan ANTES porque también filtran las cuentas-ancla).
  const competidores = (Array.isArray(icp.competidores)?icp.competidores:[]).map(_norm).filter(c=>c.length>=4);
  const _raiz = w => w.slice(0, Math.max(5, w.length - 2));  // recorta género/plural para comparar raíces
  // Vertical del comprador como TOKENS (palabras sueltas) de industrias + funcion + titulos_objetivo.
  // Comparar el término competidor contra el string multi-palabra entero fallaba (ej. "inmobiliaria" NO está
  // dentro de "servicios financieros inmobiliarios"); tokenizando, "inmobiliaria" comparte raíz con el token
  // "inmobiliarios". Filtramos tokens cortos (< 4) para no strippear por palabras genéricas tipo "de"/"la".
  const _vertTokens = _vocabVertical(icp);
  const compTerminos = (Array.isArray(icp.competidor_terminos)?icp.competidor_terminos:[])
    .map(_norm).filter(t => {
      if(t.length < 4) return false;
      const rt = _raiz(t);
      // SALVAGUARDA: no uses como filtro un término que sea el VERTICAL del comprador (ej. "inmobiliaria" ~ "inmobiliarios").
      return !_vertTokens.some(w => { const rw=_raiz(w); return w.includes(t)||t.includes(w)||rt.startsWith(rw)||rw.startsWith(rt); });
    });
  const _esComp = (emp) => { const e=_norm(emp||''); if(!e) return false; return _esCompetidor(e, competidores) || compTerminos.some(t=>e.includes(t)); };

  // VERTICALES A EXCLUIR (ruido adyacente del PLAN). Defensivo: [] si el campo no existe todavía.
  const excluir = _verticalesExcluir(plan);
  // ¿La empresa/industria/headline del candidato cae en una vertical a excluir?
  const _offVert = (c) => _matchVerticalExcluir(c.empresa, excluir) || _matchVerticalExcluir(c.head, excluir);

  const tamMin = parseInt(icp.tamano_min || 0, 10) || 0;

  // SCORING del candidato (UNA sola definición → las 3 llamadas quedan idénticas, sin drift posible).
  // Principio (auditoría GTM, casos reales Brandtrack/NOCNOK): DECISIÓN y FIT-DE-VERTICAL son los DRIVERS;
  // el TAMAÑO es piso/tiebreak, NO driver lineal (un gigante off-vertical no debe ganarle a una empresa del
  // rubro: caso Arcor>Prüne); la calidez (2do grado) pesa. Reemplaza al viejo `fit*3` keyword-céntrico que
  // aplastaba todo (~315 pts) dejando el fit-de-vertical en apenas +4.
  //   ancla(+30) = la empresa salió como comprador objetivo del cliente (fit-de-negocio fuerte)
  //   funcion(+25) = el cargo es del rol buscado | seniority*6 = PREMIA al decisor (no solo castiga al IC)
  //   tamaño*2 = saturado en el piso | calidez*4 | país*3 | IC suelto −60 = castigo que sí domina
  //   SEÑAL DE COMPRA (datos reales del MCP): recienAsumio +8 (decisor nuevo = ventana de compra abierta;
  //     pesa como tiebreak fuerte SIN superar al fit-de-función, que sigue mandando vía funcion+25/seniority/−rolOk),
  //     posts>0 +2 (activo en LinkedIn = más contactable). NO inventado: vienen de recentlyHired/recentPostsCount.
  //
  // REGLA DE ARMADO POR NIVELES (decisión del cliente): se aplica DENTRO del score para que el orden que
  // ve la IA respete la prioridad EXACTA, en vez de hacerlo solo post-hoc en armarReporte:
  //   N1 cálido + señal buenísima (on-fit, on-vertical, decisor) -> máxima prioridad (todos los bonos suman).
  //   N2 cálido + fit ok -> se suma (warmth+score normal).
  //   N3 frío + fit BUENÍSIMO (on-vertical decisor) -> solo para rellenar: pierde el bono de calidez pero
  //      conserva el de fit, así flota por encima del frío-mal-fit pero por debajo de cualquier cálido.
  //   N4 frío + fit flojo / vertical adyacente -> se hunde con penalización fuerte (no debe llegar a la IA).
  // Señales: _rolRelevante = fit-de-función real (endurecido: función del ICP o decisión+pista de vertical);
  // _offVert = la empresa/industria cae en una vertical a EXCLUIR del PLAN (ruido adyacente).
  const _scoreCand = (c) => {
    const rolOk = _rolRelevante(c.head, titulos, industriasICP);   // fit-de-función real (endurecido)
    const off   = _offVert(c);                                     // vertical adyacente a excluir
    const calido = c.dist===1 || c.dist===2;
    return (c.ancla?30:0)
      + (_matchFuncion(c.head, titulos)?25:0)
      + _rankSenioridad(c.head)*6
      + _sizeBoost(c.headcount, tamMin)*2
      + _warmth(c.dist)*4
      + (c.cerca?3:0)
      + (c.recienAsumio?8:0)                                   // señal de compra: asumió el rol hace poco
      + (c.posts>0?2:0)                                        // señal de actividad: activo en LinkedIn
      // SEÑALES DE EMPRESA (reales del MCP): realce ADITIVO modesto, NO filtro. Funding/leadership son los
      // disparadores de compra más fuertes (+3 c/u); hiring/growth son contexto de actividad (+2 c/u). Capeado.
      + (c.senales ? Math.min(7, (c.senales.funding?3:0)+(c.senales.leadership?3:0)+(c.senales.hiring?2:0)+(c.senales.growth?2:0)) : 0)
      - (c.icSuelto?60:0)
      // N3/N4: la FUNCIÓN equivocada (off-vertical o sin fit real) se hunde ANTES de cortar los 18 a la IA,
      // para que no llegue. Más fuerte si encima es frío (N4 nunca; N3 frío-buen-fit conserva fit y no se penaliza).
      - (!rolOk ? (calido ? 25 : 80) : 0)
      - (off ? (calido ? 30 : 100) : 0);
  };

  // ===== PASADA A — ACCOUNT-FIRST: cuentas-ancla con señal de compra =====
  // Buscamos EMPRESAS que encajan el ICP (industria + geo + tamaño) y están "en movimiento" (crecimiento de
  // headcount = señal genérica y honesta de que pueden estar comprando). Si la señal recorta de más, recall sin
  // señal. Las cuentas-ancla sesgan el ranking hacia clientes reales, no hacia ICs sueltos de cualquier empresa.
  const hcMin = tamMin > 0 ? Math.max(11, Math.round(tamMin*0.5)) : 11;
  let cuentas = [];
  // SEÑALES (datos reales del MCP, NUNCA inventados): nos guardamos crudos/conteos para armarlas abajo.
  let txtCoSenal = '', txtCoBase = '';   // texto crudo de la búsqueda de empresas (para leer un total si lo trae)
  let nConSenal = 0;                      // cuántas empresas-ancla con crecimiento de headcount (señal de actividad)
  // SEÑALES DE COMPRA POR EMPRESA (id-cross): cada filtro del MCP que devuelve la empresa la "marca".
  // Las claves son flags REALES del filtro (NO inventamos monto ni fecha). Mapa id -> {funding,hiring,leadership,growth}.
  const coSenales = new Map();   // companyId(string) -> {funding,hiring,leadership,growth}
  const _marcarCo = (lista, flag) => { for(const c of (lista||[])){ if(!c.id) continue; const s = coSenales.get(c.id) || {}; s[flag] = true; coSenales.set(c.id, s); } };
  // FUNDING DEL NICHO (set por NOMBRE, no por id): la MISMA búsqueda amplia de empresas con fundingEvents:true
  // que ya corremos en pasada 1 (industry+geo del ICP) nos da TODAS las empresas con funding del nicho, no solo
  // las cuentas-ancla. La indexamos por _empKey(name) para poder marcar funding en CUALQUIER candidato del pool
  // (cuya empresa salga del headline, sin id resuelto) por NOMBRE EXACTO, sin pagar 1 resolve+1 search por card.
  const fundingNombres = new Set();   // _empKey(name) de empresas con funding del nicho (pasada 1)
  if(indIds.length && geoLocOrNull){
    const baseCo = { category:'companies', profilesLimit:SOURCE_CO_LIMIT, location:{include:geoLocOrNull}, industry:{include:indIds}, headcount:_hcDesde(hcMin) };
    try{ txtCoSenal = String(await callMCP('search_sales_navigator_filtered', {...baseCo, headcountGrowth:{min:8, max:1000}})); cuentas = _parseCompanies(txtCoSenal); nConSenal = cuentas.length; _marcarCo(cuentas, 'growth'); }
    catch(e){ console.warn('[SOURCE] companies (con señal) falló:', e.message); }
    if(cuentas.length < NUM_CUENTAS*2){   // la señal recortó demasiado para este vertical: recall sin señal
      try{ txtCoBase = String(await callMCP('search_sales_navigator_filtered', baseCo)); const more=_parseCompanies(txtCoBase); for(const c of more) if(!cuentas.some(x=>x.id===c.id)) cuentas.push(c); }
      catch(e){ console.warn('[SOURCE] companies (sin señal) falló:', e.message); }
    }
    // SEÑALES ADICIONALES POR EMPRESA (financiamiento / contratación / cambio de liderazgo). Gateadas a la
    // pasada 1 (conSenal): son REALCE de ranking + marca, NO recall, así que no se re-buscan en multi-pass
    // (mismo criterio que la Pasada D / changedJobsLast90Days; evita chocar el muro de 300s de Railway).
    // 3 llamadas MCP de companies EXTRA, en PARALELO (tope CONC) para no sumar latencia secuencial.
    if(conSenal){
      const filtros = [
        ['funding',    { fundingEvents: true }],
        ['hiring',     { hasJobOffers: true }],
        ['leadership', { seniorLeadershipChanges: true }]
      ];
      await _mapLimit(filtros, CONC, async ([flag, extra]) => {
        try{
          const lista = _parseCompanies(await callMCP('search_sales_navigator_filtered', { ...baseCo, ...extra }));
          _marcarCo(lista, flag);
          // FUNDING PRE-SELECT (1 sola llamada, NO 1 por card): esta búsqueda amplia (industry+geo, fundingEvents:true)
          // ya trae el top-N de empresas-con-funding del nicho. La indexamos por nombre para marcar funding por
          // NOMBRE EXACTO a cualquier candidato del pool más abajo, sin resolver el id de cada empresa.
          if(flag === 'funding'){ for(const c of lista){ const k=_empKey(c.name||''); if(k) fundingNombres.add(k); } }
          // las empresas que SOLO aparecen por estas señales (no estaban en la búsqueda base) también son
          // cuentas-ancla válidas: las sumamos al pool de cuentas (dedupe por id).
          for(const c of lista) if(c.id && !cuentas.some(x=>x.id===c.id)) cuentas.push(c);
        }catch(e){ console.warn(`[SIGNALS] companies (${flag}) falló:`, e.message); }
      });
      const conFunding = [...coSenales.values()].filter(s=>s.funding).length;
      const conHiring  = [...coSenales.values()].filter(s=>s.hiring).length;
      const conLead    = [...coSenales.values()].filter(s=>s.leadership).length;
      console.log(`[SIGNALS] señales por empresa (pasada 1): funding=${conFunding}, hiring=${conHiring}, leadership=${conLead}, growth=${nConSenal} sobre ${coSenales.size} empresas marcadas.`);
    } else {
      console.log('[SIGNALS] señales por empresa (funding/hiring/leadership) SALTADAS (pasada de recall; son realce, no recall).');
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
    const baseKw = { category:'companies', profilesLimit:SOURCE_CO_LIMIT, location:{include:geoLocOrNull}, headcount:_hcDesde(hcMin) };
    const listas = await _mapLimit(kwAncla, CONC, async kw => {
      try{ return _parseCompanies(await callMCP('search_sales_navigator_filtered', {...baseKw, keywords: kw})); }
      catch(e){ console.warn(`[SOURCE] companies por keyword "${kw}" falló:`, e.message); return []; }
    });
    for(const lista of listas){ for(const c of (lista||[])) if(c.id && !cuentas.some(x=>x.id===c.id)) cuentas.push(c); }
    console.log(`[SOURCE] sin industria resuelta → ancla por keyword [${kwAncla.join(', ')||'-'}]: ${cuentas.length} empresas (piso hc>=${hcMin}).`);
  }
  // no anclar en un competidor/proveedor NI en una vertical a EXCLUIR (ruido adyacente del PLAN: el
  // _parseCompanies trae la industria cruda, así que la chequeamos también contra verticales_excluir).
  cuentas = cuentas.filter(c => {
    if(!c.name || _esComp(c.name)) return false;
    if(excluir.length && (_matchVerticalExcluir(c.name, excluir) || _matchVerticalExcluir(c.industry, excluir))){
      console.warn(`[SOURCE] cuenta-ancla descartada por VERTICAL EXCLUIDA: ${c.name} (${c.industry||'?'})`);
      return false;
    }
    return true;
  });
  const anclaIds     = cuentas.map(c=>c.id).filter(Boolean).slice(0, 20);
  const anclaNombres = new Set(cuentas.map(c=>_empKey(c.name)).filter(Boolean));
  const anclaHC      = new Map(cuentas.map(c=>[_empKey(c.name), c.headcount]));
  // Señales de empresa indexadas por NOMBRE normalizado (las cards conocen la empresa por headline, no por id):
  // así propagamos {funding,hiring,leadership,growth} desde la cuenta-ancla a cada decisor de esa empresa.
  const anclaSenales = new Map(cuentas.map(c=>[_empKey(c.name), coSenales.get(c.id) || null]).filter(([,s])=>s));
  console.log(`[SOURCE] cuentas-ancla: ${cuentas.length}${cuentas.length?` (${cuentas.slice(0,8).map(c=>c.name).join(', ')}${cuentas.length>8?'…':''})`:''}.`);

  // ===== PASADA B — DECISORES dentro de las cuentas-ancla (fit alto, empresa controlada) =====
  let enCuentas = [];
  if(anclaIds.length){
    const f={ category:'people', profilesLimit:SOURCE_PROFILES_LIMIT, company:{include: anclaIds} };
    if(geoLocOrNull) f.location={include:geoLocOrNull};
    if(terminos.length) f.jobPosition={ include: terminos };   // acota a los cargos objetivo dentro de la cuenta
    try{ enCuentas = _parsePeople(await callMCP('search_sales_navigator_filtered', f)); }catch{}
  }

  // ===== PASADA C — BARRIDO people-first amplio (captura el 2do grado DISPERSO de la red) =====
  let barrido = await buscar(geoLocOrNull, true);
  if(_validosHome(barrido) < HOME_MIN) barrido = barrido.concat(await buscar(geoLocOrNull, false));

  // ===== PASADA D — SEÑAL DE COMPRA (ADITIVA): recién-cambiaron de trabajo (changedJobsLast90Days) =====
  // Misma búsqueda people que el barrido (mismos keywords/location/industria) pero filtrada a los que
  // asumieron el rol en los últimos 90 días. NO reemplaza nada: se MERGEA al pool para que esos candidatos
  // (recientes = ventana de compra abierta) COMPITAN en el ranking sin sesgarlo a puro recién-cambiado.
  // Una sola pasada (MCP es gratis; el costo es latencia): si trae con industria, no repetimos sin ella.
  // LATENCIA (fix robotic-crew/300s Railway): la Pasada D corre 1 vez por cada llamada a sourceCandidates,
  // y el multi-pass invoca esto hasta SOURCE_MAX_PASSES veces -> hasta 18 round-trips MCP extra SOLO por la
  // señal. La señal es REALCE (sube en el ranking), no RECALL (no agrega cuentas nuevas que falten); no hace
  // falta re-buscarla en las pasadas 2/3 de recall. Solo la corremos cuando conSenal=true (pasada 1).
  let recienCambio = [];
  if(conSenal){
    try{ recienCambio = await buscar(geoLocOrNull, true, true); }catch(e){ console.warn('[SIGNALS] pasada changedJobsLast90Days falló:', e.message); }
  } else {
    console.log('[SIGNALS] Pasada D (changedJobsLast90Days) SALTADA (pasada de recall; la señal es realce, no recall).');
  }
  // BLINDAJE: los candidatos de esta pasada pasaron el filtro changedJobsLast90Days:true del Sales Navigator,
  // así que son recién-cambiados POR DEFINICIÓN. Forzamos recienAsumio=true en TODOS sin depender de que
  // _parsePeople haya logrado extraer recentlyHired del texto (no confirmado en el endpoint de texto del MCP).
  // El parseo per-persona queda como BONUS aditivo para marcar también a los recién-cambiados de A/B/C.
  for(const p of recienCambio) p.recienAsumio = true;
  console.log(`[SIGNALS] changedJobsLast90Days: ${recienCambio.length} candidatos con señal (recienAsumio=true forzado por la pasada) sumados al pool.`);

  // Unimos: cuentas-ancla primero (fit), después el barrido (warm disperso), después los recién-cambiados
  // (señal). Dedupe en el loop por id; la señal se MERGEA (OR) para no perderla si el id ya venía sin ella.
  const pool = [...enCuentas, ...barrido, ...recienCambio];
  console.log(`[SOURCE] pool bruto: ${enCuentas.length} en cuentas-ancla + ${barrido.length} barrido + ${recienCambio.length} señal = ${pool.length}.`);

  // dedupe + descartes (decisor real, no la propia empresa del cliente, no competidores) + marca ancla
  const vistos=new Map(); const out=[]; const empCliente=_norm((cliente&&cliente.empresa)||'');
  for(const p of pool){
    if(!p.id) continue;
    // DEDUPE con MERGE de señal: si el id ya entró (por otra pasada), no lo duplicamos pero SÍ adoptamos su
    // señal de compra (recienAsumio por OR, posts por máximo). Así un perfil que vino sin señal en el barrido
    // y CON señal en la pasada changedJobsLast90Days no pierde el dato.
    const ya = vistos.get(p.id);
    if(ya){ ya.recienAsumio = ya.recienAsumio || !!p.recienAsumio; ya.posts = Math.max(ya.posts||0, Number(p.posts)||0); continue; }
    if(_rankSenioridad(p.head) < 1) continue;                 // descarta asistente/analista/becario/junior
    const emp=_empresaDeHeadline(p.head)||'';
    if(empCliente && emp && _mismaEmpresa(empCliente, emp)) continue;
    if(emp && _esComp(emp)){ console.warn(`[SOURCE] descartado por COMPETIDOR/proveedor: ${p.name} @ ${emp}`); continue; }
    // VERTICAL EXCLUIDA: rubro adyacente-ruido del PLAN (ej. geotecnia/militar/consultoría). Excluimos
    // directo si la empresa o el headline lo delatan; el resto (detectable solo tras enriquecer) lo hunde
    // la penalización de _scoreCand vía _offVert. Defensivo: excluir=[] si el PLAN no trae el campo.
    if(excluir.length && (_matchVerticalExcluir(emp, excluir) || _matchVerticalExcluir(p.head, excluir))){
      console.warn(`[SOURCE] descartado por VERTICAL EXCLUIDA: ${p.name} @ ${emp||'?'} ("${String(p.head||'').slice(0,40)}")`);
      continue;
    }
    const cerca = _esCerca(p.loc);
    const ancla = (emp && anclaNombres.has(_empKey(emp))) ? 1 : 0;
    const hcPre = ancla ? (anclaHC.get(_empKey(emp)) ?? null) : null;   // headcount ya conocido de la cuenta-ancla
    // SEÑALES DE EMPRESA (datos reales del MCP): si la empresa del candidato es una cuenta-ancla marcada,
    // la card hereda {funding,hiring,leadership,growth}. Es ADITIVO (realce + marca), nunca filtro.
    let senalesCo = (emp && anclaSenales.get(_empKey(emp))) || null;
    // FUNDING PRE-SELECT por NOMBRE EXACTO: si la empresa del candidato (del headline) está en el set de
    // empresas-con-funding del nicho (búsqueda amplia de pasada 1), marcamos funding aunque NO sea cuenta-ancla
    // (id desconocido). Match por _empKey EXACTO, NO token-share. Es BOOST de ranking, no dato mostrado: el
    // display real lo reconfirma post-SELECT en enriquecerSenalesEmpresa, así que un match de nombre alcanza.
    if(emp && fundingNombres.has(_empKey(emp))){ senalesCo = { ...(senalesCo||{}), funding:true }; }
    // SEÑALES DE COMPRA (datos reales del MCP): se propagan tal cual al pool y llegan a SELECT.
    const cand = { id:p.id, name:p.name, head:p.head, empresa:emp, dist:p.dist, loc:p.loc, cerca, ancla, headcount:hcPre, rank:_rankSenioridad(p.head), fit:_rankFit(p.head, titulos), recienAsumio:!!p.recienAsumio, posts:Number(p.posts)||0, senales:senalesCo };
    out.push(cand); vistos.set(p.id, cand);   // el Map apunta al objeto pusheado → el merge de señal lo muta in situ
  }
  // log de cobertura de la señal: cuántos candidatos del pool deduplicado quedaron con recienAsumio:true
  // (Pasada D forzada + parseo de recentlyHired en A/B/C, mergeados por OR). Si esto es >0 la señal llega.
  console.log(`[SIGNALS] recienAsumio:true en ${out.filter(c=>c.recienAsumio).length}/${out.length} candidatos del pool (Pasada D + parseo).`);
  // FUNDING PRE-SELECT (búsqueda amplia + cruce por nombre): 1 sola llamada MCP (la search funding de pasada 1)
  // marcó este set; acá reportamos cuántos candidatos del pool quedaron con funding por NOMBRE EXACTO.
  if(conSenal && fundingNombres.size){
    console.log(`[FUNDING] pre-SELECT (amplio): ${fundingNombres.size} empresas-con-funding del nicho (1 llamada) → ${out.filter(c=>c.senales&&c.senales.funding).length}/${out.length} candidatos del pool marcados por nombre exacto.`);
  } else if(conSenal){
    console.log('[FUNDING] pre-SELECT (amplio): la búsqueda de funding del nicho no trajo empresas (sin marcas por nombre).');
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
        // SEÑAL sobre el FINALISTA: si el perfil expone recién-cambió/antigüedad-corta, marcamos recienAsumio
        // (OR: nunca pisamos una señal previa de la Pasada D con un null/desconocido del perfil).
        if(prof.recienAsumio===true) c.recienAsumio = true;
      }catch{}
    }
    c.cerca = _esCerca(c.loc);
    // ROL: si el ICP pide decisores, penalizamos fuerte a los IC sueltos para que los decisores floten arriba
    // del pool que ve la IA. No es descarte (la card sigue disponible si no hay alternativa) -> degradación digna.
    c.icSuelto = pideDecisores && _esICsuelto(c.head);
    c.score = _scoreCand(c);
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
        if(prof.recienAsumio===true) c.recienAsumio = true;   // SEÑAL sobre el finalista (OR, ver loop de arriba)
        // recomputar el score ahora que el tamaño se conoce (head puede haber cambiado al enriquecer -> reevaluar IC)
        c.icSuelto = pideDecisores && _esICsuelto(c.head);
        c.score = _scoreCand(c);
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

  // RANKING FINAL: el pool que ve la IA tiene que estar ordenado por score COMPLETO. Los que entraron por el
  // relleno (out.slice(K)), la cuota de 2do grado o el repoblado egregio y ya traían headcount NUNCA pasaron
  // por el scoring de arriba (score/icSuelto quedaban undefined) → viajaban con su orden de inserción. Acá
  // garantizamos score+icSuelto para TODOS y ordenamos: país primero (desempate de geo), después score. No
  // recorta nada → no expulsa a los que la cuota de 2do grado metió, solo los reordena.
  for(const c of final){
    c.icSuelto = pideDecisores && _esICsuelto(c.head);
    c.score = _scoreCand(c);
  }
  final.sort((a,b)=> (b.cerca-a.cerca) || (b.score-a.score) || (b.ancla-a.ancla));

  // ===== GARANTÍA DE AFLORAMIENTO DE LA SEÑAL (Opción A) ====================================
  // Problema observado (brandtrack): el pool tenía 150 recién-cambiados, pero el embudo (pool → 18 → top 3)
  // los filtraba ANTES de SELECT, así que la señal "por qué ahora" nunca aparecía en una card. El +8 del score
  // no alcanza para levantar a un recién-cambiado por encima de 18 candidatos más fuertes.
  // DECISIÓN DEL DUEÑO (Opción A): RESERVAR 1-2 slots del pool a la IA para recién-cambiados que IGUAL pasen el
  // FIT (serían elegibles de todas formas), para que COMPITAN en SELECT. El fit MANDA: NO forzamos bajo-fit ni
  // fríos solo por tener señal. Gate de elegibilidad = on-vertical/decisor real (_rolRelevante, el MISMO gate que
  // armarReporte) + NO IC suelto + NO off-vertical + cálido (1er/2do grado, calidez = mejor predictor). Si ninguno
  // pasa el gate, no se fuerza nada (queda como hoy). Si ya hay alguno en `final`, no duplicamos esfuerzo.
  const RESERVA_SENAL = Math.max(0, parseInt(process.env.SOURCE_RESERVE_SIGNAL || '2', 10));
  if(RESERVA_SENAL > 0){
    const yaIds = new Set(final.map(c=>c.id));
    const yaConSenalEnFinal = final.filter(c => c.recienAsumio && _rolRelevante(c.head, titulos, industriasICP)).length;
    const cupo = RESERVA_SENAL - yaConSenalEnFinal;
    if(cupo > 0){
      const elegibles = out
        .filter(c => c.recienAsumio
          && !yaIds.has(c.id)
          && (c.dist===1 || c.dist===2)                                   // cálido (la señal NO compra fríos)
          && _rolRelevante(c.head, titulos, industriasICP)                // on-vertical / decisor real (mismo gate que armarReporte)
          && !(pideDecisores && _esICsuelto(c.head))                      // no IC suelto cuando el ICP pide decisores
          && !_offVert(c));                                               // no vertical adyacente a excluir
      // garantizar score/icSuelto: los candidatos de `out` fuera del top K nunca se scorearon (undefined) → al
      // entrar a `final` viajarían sin score y romperían el orden / la comparación de desplazamiento.
      for(const c of elegibles){ c.icSuelto = pideDecisores && _esICsuelto(c.head); c.score = _scoreCand(c); }
      elegibles.sort((a,b)=> ((b.score||0)-(a.score||0)) || (b.ancla-a.ancla) || (b.fit-a.fit));   // mejor fit/score primero
      elegibles.length = Math.min(elegibles.length, cupo);
      if(elegibles.length){
        // Si `final` ya está lleno (N_IA), desplazamos a los PEORES del final que NO tengan señal ni sean ancla,
        // para no inflar el pool ni sacar cuentas-ancla. Si hay lugar, simplemente sumamos.
        for(const e of elegibles){
          if(final.length < N_IA){ final.push(e); continue; }
          // buscar la peor víctima desplazable (sin señal, sin ancla, score más bajo)
          let peorIdx = -1, peorScore = Infinity;
          for(let i=0;i<final.length;i++){
            const f=final[i];
            if(f.recienAsumio || f.ancla) continue;
            if((f.score??0) < peorScore){ peorScore = f.score??0; peorIdx = i; }
          }
          if(peorIdx >= 0){ final[peorIdx] = e; } else { final.push(e); }   // si no hay desplazable, ampliamos por una vez
        }
        final.sort((a,b)=> (b.cerca-a.cerca) || (b.score-a.score) || (b.ancla-a.ancla));
        console.log(`[SIGNALS] afloramiento: +${elegibles.length} recién-cambiado(s) ON-FIT reservado(s) al pool a la IA (${elegibles.map(c=>c.name).join(', ')}).`);
      }
    }
  }

  // ROL: contar IC sueltos que llegan al pool de la IA (solo informativo; ya quedaron al fondo por el score).
  // Recalculamos sobre el head final de cada candidata (algunas no pasaron por enriquecimiento -> sin c.icSuelto).
  if(pideDecisores){
    const icEnPool = final.filter(c => _esICsuelto(c.head)).length;
    console.log(`[ROL] ICP pide decisores | IC sueltos en el pool a la IA: ${icEnPool}/${final.length} (penalizados en el ranking).`);
  }

  const n2 = final.filter(c=>c.dist===2).length, nAncla = final.filter(c=>c.ancla).length;
  console.log(`[SOURCE] pool ${out.length} (${out.filter(c=>c.cerca).length} en ${geografia}) | enriquecidos ${top.length} | fuera-tam ${fueraTam.length} | a la IA ${final.length} (ancla=${nAncla}, 2do=${n2}, terminos=[${terminos.join(', ')||'-'}], ind=[${indIds.join('+')||'-'}], piso<${PISO}).`);

  // ===== SEÑALES DE MERCADO (datos REALES del MCP, jamás generados por IA) =====
  // Norte: "más señales de mercado" sin reabrir el agujero de invención. Cada ítem es un dato que sale
  // textual de una llamada MCP que ya hicimos. Si una señal no se puede obtener REAL, NO se agrega.
  // El "total de mercado" exacto solo existe si el TEXTO del MCP expone un total agregado (paging.total_count
  // del gateway NO viaja en el texto del endpoint /api/mcp); cuando no está, caemos a un label HONESTO sobre
  // lo que SÍ contamos (empresas-ancla / decisores identificados), nunca a "el mercado total".
  const senales = [];
  const vertical = (Array.isArray(icp.industrias) && icp.industrias[0]) ? String(icp.industrias[0]).trim() : '';
  const enGeo = geografia ? ` en ${geografia}` : '';
  const delVert = vertical ? ` del sector ${vertical.toLowerCase()}` : (funcion ? ` del segmento ${String(funcion).toLowerCase()}` : '');

  // 1) TAMAÑO DE MERCADO — total real de empresas del vertical en la geo SOLO si el texto lo trae; si no,
  //    label honesto con la cantidad de empresas-ancla que SÍ identificamos (no afirmamos el total del mercado).
  const totalCo = _totalDe(txtCoBase) || _totalDe(txtCoSenal);
  if(totalCo && totalCo >= cuentas.length){
    senales.push({ label:`Empresas${delVert}${enGeo}`, value: _fmtAprox(totalCo) });
  } else if(cuentas.length){
    senales.push({ label:`Empresas-ancla identificadas${delVert}${enGeo}`, value: String(cuentas.length) });
  }

  // 2) SEÑAL DE ACTIVIDAD / COMPRA — empresas-ancla con crecimiento de headcount (pasada A con headcountGrowth:{min:8}).
  //    Es un conteo real de empresas "en movimiento" (señal honesta de que pueden estar comprando/contratando).
  if(nConSenal > 0){
    senales.push({ label:`Empresas${delVert} con crecimiento de plantilla`, value: String(nConSenal) });
  }

  // 3) POOL DE DECISORES — total real de la función objetivo en el vertical SOLO si el texto trae el total;
  //    si no, label honesto con los decisores reales que identificamos (pool deduplicado, sin filtro de grado).
  const totalPe = _totalDe(txtPeopleSenal);
  if(totalPe && totalPe >= out.length){
    senales.push({ label:`Decisores de ${funcion}${enGeo}`, value: _fmtAprox(totalPe) });
  } else if(out.length){
    senales.push({ label:`Decisores de ${funcion} identificados${enGeo}`, value: String(out.length) });
  }

  // 4) CERCANÍA DE RED — decisores en 2do grado dentro del pool (calidez = mejor predictor de conversión). Real.
  const n2pool = out.filter(c=>c.dist===2).length;
  if(n2pool > 0 && senales.length < 5){
    senales.push({ label:`Decisores a un contacto de distancia (2do grado)`, value: String(n2pool) });
  }

  console.log(`[SOURCE] señales (${senales.length}): ${senales.map(s=>`${s.label}=${s.value}`).join(' | ') || '-'} | totalCo=${totalCo??'(texto sin total)'} totalPe=${totalPe??'(texto sin total)'}`);
  return { pool: final, senales: senales.slice(0, 5) };
}

// ¿Un candidato del pool es "BUENO"? = "comprador presentable", NO solo "cálido-on-vertical". Exige:
//   (1) cálido (1er/2do grado),
//   (2) DECISOR/on-fit real vía _rolRelevante (función del ICP, o decisión + pista de vertical) — un IC suelto
//       on-vertical NO cuenta: en y.uno 14 procesadores de pago (pares, ICs on-vertical) inflaban el contador
//       y hacían creer que pass 1 estaba llena → la multi-pasada nunca escalaba y el juez los volteaba 0/8;
//   (3) NO off-vertical (vertical adyacente a EXCLUIR del PLAN);
//   (4) NO competidor/proveedor (PAR): Monnet/Payway/Bci no deben inflar el contador. Por eso recibe `esComp`.
// Es el contador que decide si vale la pena gastar otra pasada de sourcing. Defensivo con campos faltantes.
function _candBueno(c, titulos, excluir, industrias, esComp){
  if(!c) return false;
  const calido = c.dist===1 || c.dist===2;
  if(!calido) return false;
  // EJE DECISOR/FIT: reusamos _rolRelevante (no solo _matchFuncion) para excluir ICs sueltos on-vertical.
  if(!_rolRelevante(c.head, titulos, industrias)) return false;
  if(c.icSuelto) return false;                                   // marca explícita de IC suelto del sourcing
  if(typeof esComp === 'function' && (esComp(c.empresa) || esComp(c.name))) return false;  // PARES fuera del conteo
  if(excluir && excluir.length && (_matchVerticalExcluir(c.empresa, excluir) || _matchVerticalExcluir(c.head, excluir))) return false;
  return true;
}

// ¿Un candidato es VIABLE como card aunque NO sea cálido? = "decisor/rol-relevante on-vertical no-par",
// SIN importar el grado (cálido O frío). Es _candBueno SIN la exigencia de calidez. El negocio prefiere mandar
// 3 decisores on-vertical FRÍOS (3er grado, flag frio_campana_conexion) a no mandar PDF en nichos sin red cálida
// (ej. nextdet = voladura minera MX). PISO INNEGOCIABLE: igual exige _rolRelevante (decisor/función del ICP) y
// no-par; un IC/técnico suelto on-vertical (ej. "Quarry Operations Technician") NO es viable -> quema credibilidad.
function _candViable(c, titulos, excluir, industrias, esComp){
  if(!c) return false;
  // (sin gate de calidez: 3er grado cuenta)
  if(!_rolRelevante(c.head, titulos, industrias)) return false;
  if(c.icSuelto) return false;                                   // IC suelto NUNCA es viable (quema)
  if(typeof esComp === 'function' && (esComp(c.empresa) || esComp(c.name))) return false;  // PARES fuera
  if(excluir && excluir.length && (_matchVerticalExcluir(c.empresa, excluir) || _matchVerticalExcluir(c.head, excluir))) return false;
  return true;
}

// MULTI-PASADA ACUMULATIVA ADAPTATIVA: cada llamada al MCP devuelve un pool DISTINTO (LinkedIn no es
// determinístico), así que correr el sourcing VARIAS veces y ACUMULAR (dedupe por id) cubre mucho más del
// universo sin subir profilesLimit. PLAN NO se re-ejecuta (el ICP no cambia): solo se repiten las búsquedas
// MCP. CRITERIO DE ESCALADO (dos contadores sobre el pool ACUMULADO):
//   - BUENOS  = _candBueno  = cálido + decisor/fit + on-vertical + no-par (lo "presentable" de primera).
//   - VIABLES = _candViable = decisor/rol-relevante + on-vertical + no-par, SIN gate de calidez (cálido O frío).
// Cortamos cuando hay >= NUM_CUENTAS VIABLES: así un cliente fácil (que ya tiene BUENOS cálidos) corta en pasada 1
// igual (BUENOS ⊆ VIABLES), y un nicho flaco sin red cálida (nextdet) sigue muestreando pools DISTINTOS hasta
// juntar NUM_CUENTAS decisores on-vertical aunque sean 3er grado (fríos), en vez de quedarse colgado esperando
// cálidos que no existen y caerse por integridad. La PREFERENCIA cálido-primero NO cambia: el _nivel del ranking
// final pone cálido+fit arriba; el frío solo rellena. PISO: VIABLES exige decisor on-vertical (nunca IC suelto).
// Es BARATO en tokens (solo MCP, cada llamada con su timeout); el costo es latencia, aceptable. SELECT corre UNA
// sola vez DESPUÉS, sobre el pool acumulado (tokens planos).
// Conserva el retry anti-hipo del MCP: si una pasada sale 100% vacía, espera y reintenta esa pasada.
async function sourceConRetry(plan, cliente){
  const reintentos   = parseInt(process.env.SOURCE_RETRY_ON_EMPTY || '1', 10);
  const delay        = parseInt(process.env.SOURCE_RETRY_DELAY_MS || '6000', 10);
  // Default bajado de 5 a 3: menos pool en memoria + menos latencia (mitiga OOM). Configurable por env.
  const MAX_PASSES   = Math.max(1, parseInt(process.env.SOURCE_MAX_PASSES || '3', 10));
  const titulos = (plan && plan._plan && Array.isArray(plan._plan.titulos_objetivo)) ? plan._plan.titulos_objetivo : [];
  const excluir = _verticalesExcluir(plan);
  // industrias (pista de vertical para _rolRelevante) y detector de PARES (competidor/proveedor) para el conteo
  // ENDURECIDO de "buenos". Replicamos la MISMA salvaguarda que sourceCandidates: no usar como filtro un término
  // que sea el vertical del propio comprador (ej. "inmobiliaria"~"inmobiliario").
  const icp = (plan && plan._plan) || {};
  const industriasICP = Array.isArray(icp.industrias) ? icp.industrias : [];
  const _raiz = w => w.slice(0, Math.max(5, w.length - 2));
  const competidores = (Array.isArray(icp.competidores)?icp.competidores:[]).map(_norm).filter(c=>c.length>=4);
  // Vertical del comprador como TOKENS (ver sourceCandidates): comparar contra palabras sueltas, no el string entero.
  const _vertTokens = _vocabVertical(icp);
  const compTerminos = (Array.isArray(icp.competidor_terminos)?icp.competidor_terminos:[])
    .map(_norm).filter(t => {
      if(t.length < 4) return false;
      const rt = _raiz(t);
      return !_vertTokens.some(w => { const rw=_raiz(w); return w.includes(t)||t.includes(w)||rt.startsWith(rw)||rw.startsWith(rt); });
    });
  const esComp = (emp) => { const e=_norm(emp||''); if(!e) return false; return _esCompetidor(e, competidores) || compTerminos.some(t=>e.includes(t)); };

  // Acumulador por id. Conservamos el orden de aparición; el ranking final ya lo hizo sourceCandidates.
  const porId = new Map();
  let senales = [];
  const acumular = (res) => {
    if(res && Array.isArray(res.pool)) for(const c of res.pool){ if(c && c.id && !porId.has(c.id)) porId.set(c.id, c); }
    if(res && Array.isArray(res.senales) && res.senales.length) senales = res.senales;  // las señales reflejan el último sourcing real
  };

  for(let pass=1; pass<=MAX_PASSES; pass++){
    // La Pasada D (señal de compra changedJobsLast90Days) solo corre en la pasada 1: es realce de ranking,
    // no recall. En las pasadas 2/3 (recall) se salta para no triplicar los round-trips MCP (latencia/300s Railway).
    const conSenal = pass === 1;
    let res = await sourceCandidates(plan, cliente, conSenal);
    // anti-hipo: si ESTA pasada salió 100% vacía, esperá y reintentá (las mismas búsquedas andan segundos después).
    for(let i=0; i<reintentos && (!res || !res.pool || !res.pool.length); i++){
      console.warn(`[SOURCE] pasada ${pass}: pool vacío, reintento en ${delay}ms (posible hipo transitorio del MCP)...`);
      await new Promise(r => setTimeout(r, delay));
      res = await sourceCandidates(plan, cliente, conSenal);
    }
    acumular(res);
    const vals    = [...porId.values()];
    const buenos  = vals.filter(c => _candBueno(c, titulos, excluir, industriasICP, esComp)).length;
    const viables = vals.filter(c => _candViable(c, titulos, excluir, industriasICP, esComp)).length;
    console.log(`[SOURCE] pasada ${pass}/${MAX_PASSES}: pool acumulado ${porId.size} | BUENOS (cálido+decisor/fit+on-vertical+no-par) ${buenos}/${NUM_CUENTAS} | VIABLES (decisor/fit+on-vertical+no-par, cálido O frío) ${viables}/${NUM_CUENTAS}.`);
    // ESCALADO por VIABLES: cliente fácil corta en pasada 1 (sus BUENOS ya son VIABLES); nicho flaco sigue
    // muestreando hasta juntar NUM_CUENTAS decisores on-vertical aunque sean fríos (mejor PDF con fríos que nada).
    if(viables >= NUM_CUENTAS) break;
  }

  // RANKING FINAL del pool acumulado por niveles: cálido+fit primero; frío-buen-fit como relleno; frío-mal-fit
  // al fondo. Reusamos el orden que cada sourceCandidates ya calculó (score), reforzando con calidez+fit aquí
  // para que el orden ENTRE pasadas (que vinieron por separado) respete la prioridad. No recorta nada.
  const acumulado = [...porId.values()];
  const _nivel = (c) => {
    const calido = c.dist===1 || c.dist===2;
    const fit = _matchFuncion(c.head, titulos);
    const off = excluir.length && (_matchVerticalExcluir(c.empresa, excluir) || _matchVerticalExcluir(c.head, excluir));
    if(off) return 0;                       // N4: vertical adyacente → al fondo
    if(calido && fit) return 4;             // N1/N2: cálido + fit
    if(calido) return 3;                    // cálido sin fit fuerte
    if(fit) return 2;                       // N3: frío + buen fit (relleno)
    return 1;                               // frío + fit flojo
  };
  acumulado.sort((a,b)=> (_nivel(b)-_nivel(a)) || ((b.score||0)-(a.score||0)) || (b.cerca-a.cerca) || (b.fit-a.fit));

  const N_IA = parseInt(process.env.SOURCE_TO_IA || '18', 10);
  const pool = acumulado.slice(0, N_IA);

  // ===== FUNDING PRE-SELECT (re-rankeo; SIN llamadas MCP extra) ==============================
  // NEGOCIO: una empresa que LEVANTÓ FINANCIAMIENTO es el mejor target (presupuesto fresco + mandato).
  // OPTIMIZACIÓN (robotic-crew: ~36 llamadas, ~1 min → 0 llamadas acá): el funding ya viene MARCADO desde
  // sourceCandidates. Una sola búsqueda amplia de empresas-con-funding del nicho (industry+geo, fundingEvents:true,
  // la que ya corre en la pasada 1) construye el set de empresas-con-funding; cada candidato cuya empresa matchee
  // por NOMBRE EXACTO (_empKey) hereda senales.funding. Ya NO resolvemos id + search por cada empresa de la lista
  // corta. Acá SOLO aplicamos el BOOST al score y re-ordenamos el pool de ~18 que va a SELECT.
  // TRADEOFF ACEPTADO: la búsqueda amplia trae solo el top-N de empresas-con-funding del nicho; si una empresa con
  // funding NO entra en ese top-N, no recibe boost (queda sin priorizar). IGUAL puede entrar como card por fit, y
  // sus señales se muestran post-SELECT (enriquecerSenalesEmpresa lo reconfirma). Perdemos algo de RECALL del boost
  // a cambio de pasar de ~36 a ~1 llamada MCP (la search funding que ya hacíamos). Es el trade correcto.
  // NUNCA inventamos: senales.funding solo se setea si la empresa apareció REALMENTE en el set del MCP.
  // GATES DUROS: el boost se SUMA al score, pero el orden sigue gobernado por _nivel (off-vertical/frío-mal-fit AL
  // FONDO); el funding solo reordena DENTRO del mismo nivel. (FUNDING_PRESELECT_MS ya no aplica: 0 llamadas acá.)
  if(String(process.env.FUNDING_PRESELECT || 'on').toLowerCase() !== 'off'){
    const BOOST = parseInt(process.env.FUNDING_BOOST || '100', 10);   // grande para ganarle al score, NO al _nivel
    const conFunding = pool.filter(c => c.senales && c.senales.funding).length;
    if(conFunding){
      for(const c of pool){ if(c.senales && c.senales.funding) c.score = (c.score||0) + BOOST; }
      pool.sort((a,b)=> (_nivel(b)-_nivel(a)) || ((b.score||0)-(a.score||0)) || (b.cerca-a.cerca) || (b.fit-a.fit));
    }
    console.log(`[FUNDING] pre-SELECT (re-rankeo, 0 llamadas MCP): ${conFunding}/${pool.length} candidatos del pool con funding (boost +${BOOST}); marca propagada por nombre exacto desde la búsqueda amplia de pasada 1.`);
  }

  return { pool, senales };
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
- STATS — PROHIBIDO FABRICAR UN NÚMERO CONTANDO TU PROPIO REPORTE (defecto frecuente): un stat numérico SOLO vale si ese número sale TEXTUAL de web_search. NO inventes un stat contando elementos que vos mismo escribiste o dedujiste: prohibido "3 líneas de producto", "3 segmentos atendidos", "4 verticales objetivo", "1 país de operación confirmado", "2 modelos de negocio". Esos números los estás CONTANDO de tu propia redacción, no de una fuente, así que son inventados. ÚNICAS excepciones legítimas que no salen de web_search: (a) la cantidad ${N} de cuentas priorizadas (es un dato del propio reporte, declarado como tal), y (b) el conteo de países de operación SOLO si cada país está confirmado por web_search (ver regla de países). PROHIBIDA la palabra "confirmado/confirmada/confirmados" en el label o el num de un stat si no hay una fuente que lo respalde: no uses "confirmado" para disimular un número que vos dedujiste. Si no juntás 4 números genuinamente verificables, usá stats CUALITATIVOS o ESTRUCTURALES honestos (ej: {"num":"${N}","label":"Cuentas priorizadas"}, {"num":"Multi","label":"País de operación"} o un chip sin número de tipo categoría/modelo) en vez de fabricar cifras.
- AÑO DE FUNDACIÓN (cuidado especial): es un dato que suele estar ambiguo o contradictorio entre fuentes. Ponelo SOLO si una fuente autoritativa y específica lo confirma (la página propia del cliente o su perfil de Endeavor/Crunchbase). Si las fuentes que ves en web_search NO coinciden, o si solo lo viste en directorios genéricos, NO lo afirmes: omití el stat de año y usá otro verificable en su lugar (países de operación, ciudades de cobertura, año de un hito real como un premio o reconocimiento, la cantidad ${N} de cuentas). Nunca elijas "el primero que aparezca": si el cliente tiene un reconocimiento (ej. Endeavor) con un año, ese año es más confiable que un directorio.
- NOMBRES DE TERCEROS (CRÍTICO para la credibilidad): PROHIBIDO nombrar a una empresa específica como cliente, aliado o socio del cliente (ej. "trabaja con X", "X es cliente", "(cliente verificado)") salvo que web_search lo confirme EXPLÍCITAMENTE en una fuente. Si querés ilustrar el canal o el mercado, hacelo en GENÉRICO ("retailers de mejoramiento del hogar", "aseguradoras con línea hogar") SIN nombre propio y SIN la palabra "verificado". Un nombre de tercero inventado quema el reporte si el prospecto lo chequea.
- ICP — LAS 4 CELDAS DE LA GRILLA (estilo "señal de compra + pain", el que mejor convierte): son EXACTAMENTE, en este orden, (1) "Decisor ideal", (2) "Señal de compra", (3) "Pain primario", (4) "Tamaño de empresa". Cada "desc" en 1-2 oraciones. Redactá cada una así:
  (1) "Decisor ideal" = el rol/cargo que FIRMA o IMPULSA la compra; tiene que ser el MISMO comprador que describen _plan.funcion y _plan.titulos_objetivo (no inventes un cargo distinto).
  (2) "Señal de compra" = el GATILLO o CONDICIÓN OBSERVABLE que indica que una empresa está lista para comprar AHORA, descrito en GENÉRICO como TIPO de señal a buscar (ej. "en expansión regional", "incorporó hace poco un nuevo líder comercial", "migrando de un sistema legacy a una solución moderna", "abrió una nueva línea de negocio o canal"). CASO DEL PRINCIPIO RECTOR: PROHIBIDO afirmar que una empresa puntual ya tiene esa señal y PROHIBIDO inventar números, fechas o hechos; es la condición que define al comprador, no un dato duro de nadie.
  (3) "Pain primario" = el DOLOR concreto que el producto del cliente resuelve, redactado desde el lado del comprador (qué le duele o le falta hoy SIN la solución). Sale del value prop del cliente que ya investigaste, NO es una métrica.
  (4) "Tamaño de empresa" = el rango de empleados/escala del comprador, coherente con _plan.tamano_min.
- PLATAFORMA / INFRAESTRUCTURA / API (REGLA CRÍTICA, define industrias y comprador_ideal): si el cliente es una PLATAFORMA, INFRAESTRUCTURA o API que HABILITA una transacción de terceros (orquestación de pagos, logística, identidad/KYC, mensajería, antifraude), el comprador NO es otro proveedor del mismo servicio (par/competidor) sino la EMPRESA QUE USA ese servicio para su propio negocio. Ejemplo: un orquestador de pagos vende a quien COBRA online (ecommerce, marketplace, retailer, aerolínea, SaaS con suscripción), NO a otro PSP/procesador/pasarela. Preguntate SIEMPRE: ¿quién FIRMA EL CHEQUE para usar esto? Esa empresa es el comprador y define "industrias". En estos casos: (1) cargá las verticales del USUARIO del servicio en "industrias" (ej. para orquestador de pagos: Comercio al por menor, Comercio electrónico, Aerolíneas, Software, Marketplaces), NUNCA el rubro de la propia plataforma; (2) cargá los PROVEEDORES/PARES del MISMO servicio (ej. PSPs, procesadores, pasarelas) en "competidores" y/o "competidor_terminos" y/o "verticales_excluir", para que el sourcing los FILTRE y no se cuelen como cuentas.
- COMPRADOR IDEAL (_plan.comprador_ideal, CRÍTICO para el fit de comprador): redactá en 1-2 oraciones QUÉ TIENE QUE SER CIERTO de una EMPRESA para que compre, revenda o aloje el producto del cliente, como un test de INCLUSIÓN y EXCLUSIÓN derivado del research que ya hiciste. REGLA MENTAL QUE GOBIERNA ESTO: la pregunta NO es "¿está en el rubro?" sino "¿quién FIRMA EL CHEQUE y PODRÍA adoptar esto de forma realista?". Compartir vertical NO basta: una empresa puede estar en el mismo rubro y aun así NO ser comprador. Describí el MODELO DE COMPRADOR (qué hace esa empresa con su negocio que la obliga a necesitar lo del cliente) y agregá ANTI-PATRONES explícitos de empresas que comparten vertical pero NO compran. Considerá SIEMPRE estos cuatro anti-patrones y nombrá los que apliquen al caso:
  (a) MARCA PROPIA / CASA DE MARCA que NO aloja ni revende terceros (tipo Inditex/Zara/marca DTC): si el cliente le vende A retailers MULTIMARCA o canales que CURAN marcas de terceros, esas marcas propias NO son comprador (no incorporan producto externo). Ej. joyería que se vende vía corners en multimarca: INCLUYE "grandes almacenes y multimarca que curan/alojan marcas de terceros"; EXCLUYE "marcas propias o casas DTC que solo venden lo suyo".
  (b) GIGANTE FUERA DE RANGO REALISTA: un proveedor chico o startup NO le cierra una venta a un Fortune-50 en un ciclo normal, Y una empresa varias veces más grande que el rango del ICP NO es comprador del producto SMB (resuelve esa necesidad puertas adentro con su propio equipo). Si el cliente es chico/joven O su producto es para PyMEs/SMB, INCLUYE el rango de tamaño donde la venta es realista (agencias/comercios chicos, scaleups, medianas) y EXCLUYE EXPLÍCITAMENTE "empresas varias veces más grandes que el rango realista, cuyo ciclo de compra es irreal o que no necesitan una herramienta SMB". Ej. para un CRM que se vende a agencias inmobiliarias chicas (5 a 100 personas): INCLUYE "agencias y corredurías inmobiliarias del rango"; EXCLUYE "desarrolladoras corporativas o cadenas de 300+ empleados que venden su propio inventario con fuerza de ventas dedicada y NO son comprador del producto SMB". Cuando el ICP es SMB, este anti-patrón (b) DEBE quedar redactado de forma explícita en el comprador_ideal.
  (c) CONTRATISTA / ASESOR / MICRO-EMPRESA cuando el ICP pide OPERADORES medianos-grandes: si el cliente le vende a operadores reales (ej. operaciones mineras medianas-grandes), EXCLUYE "micro-contratistas, asesores o consultoras que no operan a esa escala".
  (d) MISMO SUSTANTIVO, DISTINTO NEGOCIO: una palabra compartida NO es fit (flota de camiones ≠ flota de robots; perforación de agua/anclajes ≠ voladura minera; etc.). EXCLUYE el negocio adyacente que comparte la palabra pero no usa el producto del cliente.
  REGLA ANTI FALSO NEGATIVO (innegociable): si el research es pobre o dudás, redactá el comprador_ideal de forma INCLUSIVA (qué empresas SÍ compran) y agregá la EXCLUSIÓN SOLO cuando el research la respalde; nunca inventes una exclusión que deje fuera compradores legítimos. Es razonamiento de negocio aproximado, no una verdad dura: marcá el anti-patrón cuando es claramente el caso, no por sospecha. Español neutro, sin guiones.
- TÍTULO (H1): el CLIENTE va PRIMERO y resaltado. h1_pre = "" (vacío); h1_company = nombre del cliente (lo resaltado, va primero); h1_post = "${N} clientes potenciales en [País o región]" (es un SUBTÍTULO que va DEBAJO del nombre; SIN "·" ni guion al principio). PROHIBIDO "para escalar".
- TÍTULO == GEOGRAFÍA SOURCEADA (REGLA DURA, defecto grave que contradice el reporte): el/los país(es) que nombra "h1_post" tienen que ser EXACTAMENTE los de "geografias", con "geografia" (el principal, geografias[0]) SIEMPRE incluido y nombrado PRIMERO. El título refleja DÓNDE se va a buscar de verdad, y el sistema busca en el principal: si el título promete un país y el reporte entrega otro, el reporte se contradice a sí mismo (caso real: título "clientes potenciales en España" mientras toda la página 1 y el sourcing hablaban de Argentina = principal). PROHIBIDO que h1_post nombre un país que NO esté en "geografias". PROHIBIDO omitir el país principal de h1_post. PROHIBIDO nombrar en h1_post un país suelto distinto del principal. Si el cliente opera en varios, h1_post nombra ESE SET (los de "geografias", con el principal primero), no uno solo distinto del principal. Misma regla para cualquier país que nombres en "lead" o "proof": solo países de "geografias". CIERRE OBLIGATORIO: antes de devolver, verificá que el país (o set de países) de h1_post sea IGUAL a "geografias", con el principal (geografias[0]) incluido y primero; si no coincide, corregí h1_post (no la geografia) antes de cerrar.
- IDIOMA: TODO en ESPAÑOL NEUTRO latinoamericano, trato de "usted". Sin voseo ni modismos argentinos ("vos", "tenés", "podés", "acá"). El prospecto puede ser de cualquier país de LatAm.
- SIN GUIONES (importante): NUNCA uses guiones largos (—) ni guiones (-) como conectores o para incisos, en NINGÚN texto (lead, proof, context, apertura, icp, prioridades). Reemplazalos por comas, paréntesis o dos puntos. Ej: en vez de "servicios técnicos —plomería, electricidad— con cobertura", escribí "servicios técnicos (plomería, electricidad) con cobertura". El texto tiene que sonar humano, no de IA.
- GEOGRAFÍA (CRÍTICO): "geografia" = país del cliente (prioritario). "geografias" = país del cliente PRIMERO + SOLO los demás países donde el cliente HOY ya puede prestar el servicio de verdad (sus países de operación actuales). PROHIBIDO mercados de expansión futura o donde el cliente todavía NO opera. El sistema prioriza fuerte el país del cliente; los demás solo rellenan.
- PAÍS DEL CLIENTE, NO DE LA AGENCIA (REGLA DURA, defecto recurrente): "geografia" y "geografias" son el/los país(es) donde opera el CLIENTE de ESTE reporte, deducidos de SU propio research (web, dominio, sede, idioma del sitio, clientes, TLD). NUNCA pongas Argentina (ni ningún otro país) "por defecto" ni porque sea el país de quien encarga el reporte: este servicio lo corre una agencia argentina, pero ESO ES IRRELEVANTE para la geografía del cliente. Ej: una empresa con sede/operación en Estados Unidos (aunque tenga dominio .com) → geografia="Estados Unidos", JAMÁS "Argentina". Si el research no deja claro el país, usá el MÁS RESPALDADO por las señales (sede, idioma del sitio, clientes, TLD), nunca Argentina por descarte. NO inventes países: si solo hay evidencia de UN país, geografias = [ese país] y geografia = ese país.
- COHERENCIA geografia ∈ geografias (INNEGOCIABLE, este bug rompió el sourcing de Robotic Crew): "geografia" (el país principal) TIENE que ser uno de los que están en "geografias"; el principal es parte de la lista, NUNCA un país que no figure en ella. PROHIBIDO devolver geografia="Argentina" con geografias=["Estados Unidos"] (eso hace que el sistema busque en el país equivocado). CIERRE OBLIGATORIO: antes de devolver, verificá que "geografia" aparezca dentro de "geografias" y que AMBOS reflejen el mercado REAL del cliente; si no, corregilo.
- ALCANCE REGIONAL / NEARSHORE (caso del principio rector, para verticales nicho donde el país principal da pool pobre): además de los países de operación actual, PODÉS sumar a "geografias" países cercanos ADICIONALES donde el cliente PUEDE prestar/vender el servicio hoy (modelo nearshore o regional), PERO con estos guardarraíles INNEGOCIABLES: (a) solo si web_search CONFIRMA en una fuente del propio cliente que sirve/le vende a esos países (cobertura regional declarada, modelo remoto/exportable, casos en la región); que sea PLAUSIBLE para el rubro NO alcanza. (b) NUNCA agregues un país solo para "rellenar" ni porque haya más gente o pool más cálido ahí: la cantidad de leads disponibles NO es una razón válida. (c) El país principal SIGUE MANDANDO y va PRIMERO. No SUB-escopees la geografía real del cliente, pero tampoco inventes mercados. COHERENCIA OBLIGATORIA: cada país que sumes a "geografias" tiene que aparecer también en el título (h1_post) y, si lo nombrás, en la prosa del "lead"; y tiene que quedar contado en el número del stat de países. Si no lo vas a nombrar en h1_post, NO lo agregues.
- NIVEL DE CERTEZA POR PAÍS (caso del principio rector; lo nota el cliente): no todos los países donde aparece un cliente están al mismo nivel. Clasificá CADA uno según cómo lo describen TUS fuentes de web_search y usá un lenguaje que coincida con esa evidencia:
  • CONSOLIDADO (la fuente dice "opera en", "tiene oficina/equipo/Country Manager en", "presencia en", "desde hace X años", "lanzó/llegó en 20XX") → escribilo como "opera en X" / "con operación en X". NUNCA lo llames "apertura a X", "posibilidad de extender a X" ni "mercado futuro" (eso subvalúa y es falso si ya está ahí hace años).
  • RECIENTE / EN ENTRADA (la fuente dice "se está expandiendo a", "está entrando en", "recién llegó a", "lanzó este año en") → escribilo como "expansión reciente a X" / "está entrando en X". No lo presentes con la misma solidez que un mercado consolidado.
  • SOLO PLAN (la fuente dice "planea", "quiere", "próximamente", "evalúa", sin operar todavía) → NO lo cuentes como país de operación, ni en el texto ni en el stat.
  REGLA DE ORO: no subas ni bajes el nivel respecto de lo que dice la fuente. Si DISTINTAS fuentes difieren en el nivel de un mismo país (ej. una dice "opera en" y otra "se está expandiendo a"), usá SIEMPRE el nivel MÁS BAJO/conservador (en ese caso, "expansión reciente"), nunca el más optimista. El stat de países (si lo ponés) cuenta los consolidados + los recientes reales (NO los aspiracionales), y el texto y el stat tienen que COINCIDIR: si decís que opera/se expande en 3 países, el stat dice 3, no 2. Si no estás seguro de un país, no lo cuentes en ningún lado, pero que texto y stat coincidan.
  COHERENCIA NUMÉRICA DE PAÍSES (CRÍTICO, defecto recurrente): fijá UNA SOLA lista de países (los consolidados + recientes reales) y usá EXACTAMENTE esa misma lista, con los MISMOS nombres y la MISMA cantidad, en los TRES lugares: (1) el número del stat de países, (2) los países nombrados en h1_post, y (3) cualquier país que menciones en la PROSA del "lead". REGLA INNEGOCIABLE: cada país que cuentes en el número del stat tiene que estar nombrado en h1_post; y cada país que nombres en h1_post o en el "lead" tiene que estar contado en el stat. PROHIBIDO contar un país en el número que no esté escrito en el texto, o nombrar en el texto uno que no esté en el cuenta (ej. contar 4 pero listar solo España, México y Guatemala sin Andorra es un BUG). EL LEAD NO PUEDE NOMBRAR UN PAÍS EXTRA (CRÍTICO, defecto recurrente que retiene reportes con cuentas buenas): si el cliente NO opera hoy en un país, ese país NO va en el "lead" aunque sea un mercado de expansión, una aspiración o una referencia de contexto. El "lead" solo puede nombrar países de la lista canónica (los mismos de h1_post). Si querés hablar de crecimiento o de mercado sin un país de operación confirmado, hacelo en GENÉRICO (ej. "la región", "Latinoamérica") SIN nombrar un país que no esté en la lista. CIERRE OBLIGATORIO: antes de cerrar el JSON, contá con el dedo los países que nombraste en h1_post, verificá que NINGÚN país del "lead" quede fuera de esa lista, y que ese número sea EXACTAMENTE el del stat de países; si no coinciden, corregilo antes de devolver.
- INDUSTRIAS (CRÍTICO — ahora es un FILTRO DURO de búsqueda): "industrias" tiene que listar SOLO las VERTICALES de prioridad ALTA donde están los COMPRADORES del cliente (las MISMAS que marcás "Alta:" en "prioridades", ni una más). PROHIBIDO meter en "industrias" las verticales "Media:" ni ninguna secundaria/aspiracional: esas van EXCLUSIVAMENTE en "prioridades" como contexto, NUNCA en "industrias" porque "industrias" es el filtro de búsqueda y meter una Media diluye el pool con cuentas de menor fit. El sistema busca decisores SOLO en estas industrias, así que tienen que ser categorías reales y reconocibles (ej: "Seguros", "Comercio al por menor", "Inmobiliario", "Banca", "Administración de propiedades"). NO pongas el rubro del propio cliente ni industrias genéricas. TAXONOMÍA (CRÍTICO para que el filtro NO se caiga): cada nombre de "industrias" tiene que ser una CATEGORÍA RECONOCIBLE de la taxonomía de industrias de LinkedIn/Sales Navigator (las que el sistema resuelve a un id de filtro), NO una etiqueta hiper-específica, de moda o inventada que no exista como industria. Una etiqueta que no resuelve deja la búsqueda SIN filtro de industria. Preferí siempre la categoría canónica más cercana al COMPRADOR: ej. usá "Ingeniería robótica" / "Robotic Engineering" o "Fabricación de maquinaria de automatización" en vez de "Robotics" a secas. Es válido (y recomendado ante la duda) poner el nombre en español Y/O su equivalente reconocible en inglés. EVITÁ verticales industriales/pesadas amplias (ej. "Construcción", "Manufactura", "Minería", "Cemento") salvo que sean LITERALMENTE el comprador: arrastran jefes de mantenimiento de planta que consumen el servicio puertas adentro pero NO son el canal de compra. Ante la duda, preferí las verticales donde el producto del cliente se compra o se revende.
- TAMAÑO (el piso refleja el COMPRADOR REAL, ni subestimado ni sobreestimado): "tamano_min" tiene que ser un número real de empleados que refleje el PISO REAL del comprador del cliente. El gate de tamaño del sistema es SOLO un PISO (no hay techo): si ponés el piso demasiado alto, dejás entrar gigantes que NO compran (el piso no los frena, solo sube a los grandes); si lo ponés demasiado bajo o en 0, entra cualquiera. Reglá el piso por el tipo de comprador, en AMBAS direcciones:
  • COMPRADOR PyME / SMB (producto SaaS o herramienta que se vende a agencias, comercios o estudios chicos): el piso tiene que ser BAJO y ACORDE al rango real, NO alto ni 0. Ej. un CRM para agencias inmobiliarias de 5 a 100 asesores → tamano_min ~5 a 10 (NUNCA 200): un piso de 200 deja colar desarrolladoras o cadenas de 300+ que no son comprador del producto SMB. El piso bajo es CORRECTO acá, no un error.
  • COMPRADOR MEDIANO-GRANDE / MARCA ANCLA (plataforma o solución que se vende a cadenas, operadores grandes o marcas establecidas): el piso alto SIGUE siendo correcto (ej. 200 o más). NO conviertas todo en SMB: si el ICP legítimamente apunta a empresas grandes, un piso alto filtra micro-empresas que no son el comprador.
  REGLA DE ORO: el piso es CHICO cuando el comprador es chico y GRANDE cuando el comprador es grande; deducilo del research del comprador real, no por defecto. NO lo dejes en 0 salvo que de verdad cualquier tamaño sirva. COHERENCIA: el piso tiene que ser consistente con la celda (4) "Tamaño de empresa" del ICP y con el comprador_ideal (si el comprador_ideal marca el anti-patrón "(b) gigante fuera de rango realista", el piso NO puede ser tan alto que ese mismo gigante igual entre).
- COMPETIDORES (importante para no quemar el reporte): en "competidores" listá los NOMBRES de empresas/PRODUCTOS que compiten DIRECTAMENTE con la solución que vende el cliente (otras herramientas/soluciones DEL MISMO TIPO), porque venden/fabrican LO MISMO que el cliente. REGLA MENTAL INNEGOCIABLE: un competidor es algo que tu comprador potencial podría comprar EN VEZ del producto del cliente; NO es el comprador potencial mismo. PROHIBIDO incluir la INDUSTRIA, la FUNCIÓN, el TIPO DE EMPRESA o la VERTICAL del COMPRADOR objetivo (eso son tus clientes, no tus rivales). Ejemplo concreto: si el cliente es un CRM que se VENDE a inmobiliarias, los competidores son OTROS CRM inmobiliarios (ej. Inmovilla, Wasi, Propify), NUNCA "inmobiliaria", "agencia inmobiliaria" ni "bienes raíces" (esos son los COMPRADORES). Buscalos con web_search e incluí TRES tipos: (i) competidores directos de tamaño similar; (ii) FABRICANTES o PROVEEDORES globales del mismo producto (ej. para detonadores/voladura: Enaex, Orica, Dyno Nobel, Sandvik; para staffing de tecnología: Toptal, Turing, Andela, TEKsystems); (iii) distribuidores o integradores que revenden ese producto. Son PARES o RIVALES, no clientes. El sistema EXCLUYE a cualquiera que trabaje en esas empresas. Usá nombres de marca/empresa REALES del research. NO pongas palabras genéricas del servicio (ej. "asistencia", "mantenimiento") porque descartaría compradores legítimos. Si no identificás competidores reales claros, MEJOR dejá la lista VACÍA que meter la vertical del comprador (que rompe el sourcing).
- COMPETIDOR_TERMINOS (filtro de respaldo, usar con cuidado): listá 0-4 términos del PRODUCTO ESPECÍFICO que el cliente fabrica/vende y que, si aparecen en el NOMBRE de otra empresa, casi seguro la delatan como proveedor o competidor (ej. "explosivos", "detonadores", "voladura", "staffing", "proptech"). MISMA REGLA MENTAL que en "competidores": un término competidor describe algo que el comprador compraría EN VEZ del producto del cliente, NUNCA describe al comprador mismo. REGLA CRÍTICA Y DURA: PROHIBIDO poner la INDUSTRIA, la FUNCIÓN, el TIPO DE EMPRESA o el VERTICAL donde el cliente VENDE. Si vende software/CRM inmobiliario NO pongas "inmobiliaria" ni "agencia inmobiliaria" ni "bienes raíces"; si le vende a minería NO pongas "minería". Eso descartaría a tus propios COMPRADORES (es exactamente el bug que quemó el sourcing de NOCNOK). Solo el nombre del producto en sí. Ante la duda, MEJOR dejá la lista VACÍA que arriesgarte a meter la vertical del comprador.
- VERTICALES_EXCLUIR (ruido adyacente del sourcing, NO inventes nada del cliente): listá 2-5 RUBROS ADYACENTES que comparten palabras o suenan parecido al ICP pero que NO son compradores del cliente, para que el sistema los descarte del pool. Son verticales del MERCADO (no del cliente): no estás afirmando nada nuevo sobre el cliente, solo marcando rubros-ruido a EXCLUIR. Ejemplos: para una empresa de voladura minera, excluí "geotecnia", "mecánica de suelos", "militar", "consultoría"; para una marca de joyería retail, excluí "hotelería", "educación". REGLA ANTI FALSO POSITIVO: NUNCA pongas acá el vertical legítimo del comprador (si el comprador está en "Seguros", JAMÁS pongas "seguros") ni un término tan corto/genérico que pueda colarse en nombres de tus compradores. Si no hay rubros adyacentes claros que confundan, dejá la lista VACÍA ([]).
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
  "icp": [ {"title":"Decisor ideal","desc":"..."}, {"title":"Señal de compra","desc":"..."}, {"title":"Pain primario","desc":"..."}, {"title":"Tamaño de empresa","desc":"..."} ],
  "context": [ "bullet 1 (corto)", "bullet 2 (corto)", "bullet 3 (corto)" ],
  "apertura": [ "hook 1", "hook 2", "hook 3" ],
  "prioridades": [ "Alta: ...", "Media: ...", "...", "..." ],
  "_plan": { "funcion": "función del comprador en 1-2 palabras", "comprador_ideal": "1-2 oraciones: el MODELO DE COMPRADOR (quién FIRMA EL CHEQUE y podría adoptar esto de forma realista) como test de INCLUSIÓN y EXCLUSIÓN, con ANTI-PATRONES explícitos de los que apliquen: (a) marca propia que no aloja terceros, (b) gigante fuera de rango realista del cliente, (c) contratista/asesor/micro cuando el ICP pide operadores medianos-grandes, (d) mismo sustantivo distinto negocio (flota de camiones ≠ flota de robots). Ej: 'Compran multimarca y grandes almacenes que curan marcas de terceros; NO marcas propias/DTC que solo venden lo suyo'. Ante research pobre, redactalo INCLUSIVO y agregá la exclusión SOLO si el research la respalda", "titulos_objetivo": ["PALABRAS SUELTAS del cargo de quien COMPRA: roles de facilities (operaciones, mantenimiento, administrador) Y roles del producto/canal del cliente (ej. hogar, asistencia, vivienda, copropiedad), ES+EN+abreviaturas"], "geografia": "el país real del cliente (prioritario)", "geografias": ["País del cliente PRIMERO, después SOLO países donde el cliente HOY opera"], "industrias": ["VERTICALES ANCLA donde se COMPRA/revende el producto, ej: Seguros, Comercio al por menor, Inmobiliario, Administración de propiedades, Banca (evitá industriales amplias tipo Construcción/Manufactura)"], "competidores": ["NOMBRES de empresas/productos que el comprador compraría EN VEZ del producto del cliente (venden lo mismo), ej: Iké Asistencia, Asissprex. NUNCA la industria/vertical del comprador (ej. para un CRM inmobiliario: otros CRM como Inmovilla/Wasi, NUNCA 'inmobiliaria')"], "competidor_terminos": ["0-4 términos del PRODUCTO que delatan a un proveedor/competidor en el nombre de su empresa, ej: explosivos, voladura, staffing; NUNCA la industria/función/vertical donde el cliente VENDE (ej. nunca 'inmobiliaria' si vende a inmobiliarias)"], "verticales_excluir": ["2-5 rubros ADYACENTES-ruido a EXCLUIR del sourcing (comparten palabras con el ICP pero NO compran), ej. para voladura minera: geotecnia, mecanica de suelos, militar, consultoria; NUNCA el vertical del comprador; [] si no aplica"], "tamano_min": 200 }
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

// Wrapper de robustez del PLAN: reintenta SOLO si el PLAN sale inválido (JSON no parsea, viene incompleto,
// o validarPlan tira). Es un hipo transitorio (web_search/modelo): el reintento corre EN FALLA (raro), así que
// el costo extra de tokens es marginal. El CAMINO FELIZ (PLAN válido a la primera) hace UNA sola llamada y
// devuelve igual que runPlan, sin overhead. Si agota los intentos, deja propagar el error (fail-closed: no se
// inventa un PLAN). NO toca el prompt ni validarPlan.
async function runPlanConRetry(args){
  const MAX   = Math.max(1, parseInt(process.env.PLAN_MAX_TRIES || '2', 10));
  const delay = parseInt(process.env.PLAN_RETRY_DELAY_MS || '2000', 10);
  let ultimoError;
  for(let intento=1; intento<=MAX; intento++){
    try{
      const plan = await runPlan(args);
      validarPlan(plan);   // idempotente: confirma que el PLAN está completo antes de seguir
      return plan;
    }catch(e){
      ultimoError = e;
      if(intento >= MAX){
        console.warn(`[PLAN] intento ${intento}/${MAX} inválido (${e.message}); agotados los reintentos, propago el error.`);
        throw e;
      }
      console.warn(`[PLAN] intento ${intento}/${MAX} inválido (${e.message}), reintento en ${delay}ms...`);
      if(delay > 0) await new Promise(r=>setTimeout(r, delay));
    }
  }
  throw ultimoError;   // inalcanzable, pero deja el contrato claro
}

// FASE 3 — IA: elige + escribe. Prompt parametrizado por (pedir, usar).
function _promptSelect(pedir, usar){ return `# IBT GTM — Fase SELECT (elegir + escribir)

Te paso una LISTA REAL de candidatos (gente que existe, con su id, nombre, cargo textual, empresa, país y grado de conexión) y el contexto del cliente. Elegís los ${pedir} MEJORES decisores EN ORDEN de prioridad (el mejor primero) y escribís, para cada uno, un ángulo y un hook. El sistema usa los primeros ${usar} válidos.

## Cómo elegir (en este orden)
1. FIT de función Y de empresa (LO MÁS IMPORTANTE): el FIT no es solo el cargo. (a) FIT de función: el cargo tiene que ser CLARAMENTE del rol que compra lo del cliente. PROHIBIDO elegir gente de OTRA área que la del comprador: si el comprador es de Operaciones/Facilities/Mantenimiento/Administración, NO elijas a nadie de Marketing/Mercadeo/Ventas/Comercial/RR.HH./Finanzas, POR MÁS que la empresa sea una marca top. Un cargo suelto sin función clara ("Mercadeo", "Analista", "Coordinador" a secas) NO sirve. Un "CEO/Dueño" de empresa chica sí sirve porque ahí decide. (b) FIT de empresa (comprador ideal) — FILTRO FUERTE de fit-de-negocio: la EMPRESA de la card tiene que ser realmente un comprador/canal del producto, no solo compartir vertical. Preguntate: ¿quién FIRMA EL CHEQUE acá y esta empresa PODRÍA adoptar lo del cliente de forma realista, o solo está en el mismo rubro? PROHIBIDO elegir una empresa que comparte vertical pero claramente NO es comprador. Rechazá en particular estos anti-patrones (están explicados en el "Comprador ideal" del contexto): (i) MARCA PROPIA / casa de marca que NO aloja ni revende terceros, cuando el cliente le vende a canales MULTIMARCA que curan marcas de terceros (ej. una marca DTC tipo Zara/Inditex NO incorpora joyería de un proveedor externo); (ii) GIGANTE muy fuera del rango realista del cliente (un proveedor chico o startup no le cierra a un Fortune-50 en un ciclo normal: preferí empresas del tamaño donde la venta es realista); (iii) CONTRATISTA / ASESOR / micro-empresa cuando el ICP pide OPERADORES medianos-grandes; (iv) MISMO SUSTANTIVO, DISTINTO NEGOCIO (flota de CAMIONES ≠ flota de ROBOTS; perforación de agua/anclajes ≠ voladura minera). Si el CARGO es correcto pero la EMPRESA cae en uno de estos anti-patrones, NO la elijas: preferí otra del pool que sí sea comprable. SALVAGUARDA (degradación digna, no vacíes el pool): esto es PREFERENCIA FUERTE, no un rechazo que reduzca la cantidad. Si NO hay alternativas mejores en la lista, elegí lo MENOS MALO antes que devolver menos de ${usar} cuentas. Y si simplemente NO podés determinar el fit de negocio (research pobre, empresa desconocida), tratala como aceptable y elegí por los demás ejes; el anti-patrón aplica cuando es CLARO, no por sospecha. MEJOR repetir vertical que UNA cuenta de función o empresa equivocada, pero NUNCA devolver menos de ${usar}.
2. VERTICALES ALTA del ICP: preferí SIEMPRE candidatos cuyas empresas estén en las verticales de prioridad ALTA del contexto (te las paso en "Verticales prioridad ALTA"). Elegí un candidato de una vertical Media/secundaria SOLO si no hay suficientes buenos de las ALTA. A igual fit de función y país, una empresa de vertical ALTA le gana a una de vertical Media.
3. PAÍS: preferí candidatos del PAÍS DEL CLIENTE (van marcados con ★ y vienen primero en la lista). Elegí de otro país de LatAm SOLO si no hay suficientes buenos del país del cliente. NUNCA elijas a alguien de un país donde el cliente no puede prestar el servicio.
4. Decisor real (PREFERENCIAL, no excluyente): cuando la "Función del comprador" del contexto apunta a gerencia/dueño (quien AUTORIZA y FIRMA la compra), PREFERÍ cargos de DECISIÓN: director, gerente, jefe, head, VP, C-level (CEO/COO/etc.), dueño, fundador, propietario, socio, broker/agente PRINCIPAL que decide. EVITÁ los cargos de CONTRIBUIDOR INDIVIDUAL / usuario final que NO autorizan la compra ("agente", "asociado", "especialista", "profesional inmobiliario" suelto, "analista", "representante", "asesor", "vendedor", "ejecutivo de ventas/cuentas"): ese rol USA el producto pero no lo compra, así que le venderías a quien no firma. MATIZ (importante, no es rechazo duro): a IGUALDAD de fit de función, país y vertical, el que DECIDE la compra GANA al contribuidor individual; pero si en la lista NO hay decisores disponibles para una empresa, es PREFERIBLE elegir el mejor IC disponible que devolver menos cuentas (degradación digna). Y si el ICP legítimamente apunta a ICs (ej. el comprador ES el agente o el dueño-operador de una empresa chica), el IC SÍ sirve. Igual que siempre: nada de trainees ni juniors.
5. Empresa ANCLA con fit de ICP: usá los "~N empleados" que te muestro para juzgar el TAMAÑO. Marca grande y conocida emociona; startup desconocida de 8 personas no. Pero si el ICP son PyMEs, una empresa enorme NO sirve aunque sea famosa: priorizá el FIT real. TAMAÑO (con matiz): a igual fit de función, país y vertical, PREFERÍ las empresas que cumplen el piso de tamaño del ICP por encima de las más chicas. EVITÁ las claramente micro (prácticamente un individuo, ej. 1 a 4 empleados cuando el ICP pide empresas/agencias con equipo) SIEMPRE QUE haya alternativas mejores on-vertical en la lista. PERO el tamaño NO es excluyente: un lead fuerte en los demás ejes (país correcto, rol claramente decisor, on-vertical, contacto cálido) en una empresa SOLO un poco por debajo del piso SÍ sirve y se puede elegir. No descartes un buen decisor por quedar apenas corto de tamaño; descartá solo los casos obviamente micro cuando existen mejores opciones.
6. Coherencia / credibilidad: si cargo+empresa+ubicación se ve raro, no la elijas.
7. Grado de conexión: a IGUAL fit y país, preferí SIEMPRE el grado más cálido (1er o 2do grado por encima de 3ro o fuera de red): un 2do grado acepta y responde mucho más porque comparten un contacto. Nunca sacrifiques fit por grado, pero entre candidatos parecidos, el más cálido gana.

## Reglas DURAS
- Elegí SOLO ids que estén en la lista. PROHIBIDO inventar una persona, un id, un cargo o una empresa.
- LOS ${pedir} ids tienen que ser DISTINTOS. Prohibido repetir la misma persona.
- EMPRESAS DISTINTAS: cada cuenta es de una empresa DIFERENTE. Si dos son de la misma empresa, quedate con el de mejor fit y completá con otra empresa.
- PROHIBIDO inventar o inflar el cargo: usá EXACTAMENTE el que figura en la lista. Si dice "Project Manager", es "Project Manager" — no lo asciendas a "Manager de Mantenimiento" ni le inventes MBA, estudios, especialidad ni un rol que no está. No le atribuyas datos (seniority, área, formación) que no estén en lo que te paso.
- PROHIBIDO atribuir un ÁREA, DEPARTAMENTO, INICIATIVA o ESPECIALIDAD que no aparezca LITERAL en el cargo de la lista. Si el cargo dice solo "Executive Director", NO escribas que "dirige Automation", "lidera Innovation" ni que está "a cargo de Automation e Innovation": esa área NO está en el cargo, te la estás inventando. Hablá del rol GENÉRICO tal como figura ("como Executive Director", "desde su rol de dirección"), NO inventes el QUÉ específico que dirige. Misma regla para el ángulo y para el hook.
- PROHIBIDO RE-ENCUADRAR EL ROL HACIA EL COMPRADOR (defecto sutil): NO le atribuyas a la persona la responsabilidad de COMPRA, DECISIÓN o LIDERAZGO de un área que su cargo real NO implica. Un "Head of Design" NO "lidera las compras de [X]"; un "People & Culture Director" NO "decide alianzas/expansión/proveedores"; un "Marketing Manager" NO "gestiona la operación de mantenimiento". Si el cargo es de OTRA función y claramente NO es el comprador del producto del cliente, NO lo fuerces a parecerlo: conectá con lo que ESE rol SÍ hace, o mejor elegí otro candidato cuyo cargo sí sea del comprador. Forzar el encuadre quema el reporte cuando el prospecto lee que le atribuís algo que no es lo suyo.
- PROHIBIDO AFIRMAR UN FIT DE NEGOCIO QUE NO CONSTA (anti-invención, defecto que MAQUILLA un mismatch): el ángulo y el hook NO pueden AFIRMAR que la empresa de la card COMPRA, ALOJA, REVENDE o INTEGRA lo del cliente si eso no está respaldado por lo que sabés de esa empresa. PROHIBIDO frases tipo "incorpora marcas externas", "aloja proveedores de terceros", "integra robótica", "suma soluciones como la de [cliente]" sobre una empresa donde NO hay evidencia de que lo haga (peor aún si es justo lo que esa empresa NO hace, ej. una marca propia que solo vende lo suyo). Si NO sabés si la empresa compra/aloja lo del cliente, NO lo afirmes: conectá con lo que ESE rol/empresa SÍ hace de forma genérica y verificable ("como responsable de [área] en [empresa], usted maneja [lo que el rol SÍ toca]"), sin atribuirle una adopción que no consta. Afirmar un fit inexistente quema el reporte apenas el prospecto lo lee.
- PROHIBIDO INVENTARLE LOGROS/CASOS/MÉTRICAS AL CLIENTE (anti-invención, tan grave como inventar el cargo): el ángulo y el hook conectan el rol con lo que el cliente OFRECE (en presente, cualitativo), NUNCA con un resultado, caso de éxito, implementación, cifra o cliente del cliente que NO esté TEXTUAL en el contexto "Qué ofrece / proof" que te paso. PROHIBIDO escribir cosas tipo "[cliente] redujo X a cero", "implementaciones activas en [sector]", "ya trabaja con empresas como la suya", "logró +X% de", "tiene casos en [vertical]" si eso no figura LITERAL en el contexto. Si el contexto no trae un logro, NO lo inventes: describí qué OFRECE el cliente y cómo eso toca el rol de esa persona. Una métrica o caso inventado del cliente lo quema apenas el prospecto repregunta.
- CADA uno DEBE tener angulo y hook NO vacíos.
- El ÁNGULO: MÁXIMO 2 oraciones (≤ 320 caracteres), específico de ESA persona/empresa, usando su cargo/empresa/perfil REALES + lo que ofrece el cliente. Corto y al hueso, sin relleno. 100% único por persona.
- ÁNGULO ANCLADO Y DISTINTO POR CARD (REGLA DURA, defecto auditado: los ángulos salían genéricos y calcados entre cards). Cada ángulo tiene que anclar un DATO o un PAIN ESPECÍFICO de ESA empresa/persona (algo que no aplicaría igual a otra card), no una frase intercambiable. Los ${pedir} ángulos del reporte NO pueden girar todos sobre el MISMO pain: cada card, un pain distinto y un ángulo distinto. PROHIBIDO el cierre TEMPLATE genérico repetido entre cards, tipo "exactamente el tipo de herramienta/solución que un [rol] necesita", "es justo lo que [empresa/rol] necesita" o "eso es exactamente lo que [cliente] resuelve": esa fórmula es relleno intercambiable y delata que no anclaste nada propio de esa cuenta (caso real: los 3 ángulos giraban sobre "gestión centralizada", y uno era puro template sin nada propio de la empresa). Si un ángulo te quedó así de genérico, reescribilo anclando algo concreto y único de ESA empresa/rol.
- SEÑAL DE COMPRA, el "por qué ahora" REAL (úsala cuando la línea del candidato la trae, JAMÁS la inventes): la lista marca, al FINAL de la línea de cada candidato, señales reales del perfil/empresa (dato del MCP, no generado por nadie). Un candidato puede traer VARIOS marcadores. REGLA DURA DE UNA SOLA SEÑAL POR CARD: tejé en el ángulo SOLO LA SEÑAL MÁS FUERTE disponible, NUNCA dos o más. Apilar señales se siente expediente/humo y BAJA la confianza del prospecto. ORDEN DE FUERZA (elegí la primera que aparezca en la línea): (1) "SEÑAL: asumió el rol hace poco" > (2) "SEÑAL: la empresa levantó financiamiento" > (3) "SEÑAL: cambio de liderazgo en la empresa" > (4) "SEÑAL: la empresa está contratando" > (5) "SEÑAL: la empresa está creciendo en plantilla". Tejé esa única señal en la prosa del ángulo como el "por qué ahora", NO como lista ni campo aparte, hilado natural:
  (a) "SEÑAL: asumió el rol hace poco" → disparador temporal de la PERSONA ("asumió la dirección comercial hace poco, momento ideal para evaluar herramientas nuevas", "como llegó hace poco al rol, está definiendo stack y proveedores").
  (b) "SEÑAL: la empresa levantó financiamiento" → ("[empresa] levantó financiamiento recientemente y suele ser cuando se evalúan nuevas herramientas"). Cualitativo: PROHIBIDO inventar monto, ronda o fecha (no los tenemos).
  (c) "SEÑAL: cambio de liderazgo en la empresa" → ("[empresa] cambió su liderazgo hace poco, etapa donde se revisan proveedores y prioridades"). Sin nombres ni fechas inventadas.
  (d) "SEÑAL: la empresa está contratando" → ("[empresa] viene sumando equipo, señal de que la operación se está escalando"). Cualitativo, sin números.
  (e) "SEÑAL: la empresa está creciendo en plantilla" → ("[empresa] está creciendo y eso suele tensionar [lo que toca el rol]"). Cualitativo.
  (f) ANTI-CREEPY, REGLA DURA: el marcador "activo en LinkedIn" es SOLO para priorización interna. NUNCA lo verbalices en ángulo ni hook (decir "vi que posteás"/"viene activo en LinkedIn" espanta al prospecto, se siente vigilado). Ignoralo al escribir. Las señales de la PERSONA ("asumió el rol") y de la EMPRESA (financiamiento, liderazgo, contratando, creciendo) SÍ se verbalizan: son públicas y no invasivas.
  (g) ANTI-INVENCIÓN, INNEGOCIABLE: SOLO afirmá una señal si SU marcador EXACTO está presente en ESA línea de candidato. PROHIBIDO escribir "asumió el rol hace poco", "recién llegó", "levantó financiamiento", "cambió su liderazgo", "está contratando", "está creciendo" o equivalentes si la línea NO trae el marcador correspondiente; sin marcador la señal NO existe y no se menciona. Todo CUALITATIVO ("hace poco"/"recientemente"/"viene sumando"), NUNCA inventes fecha, monto, ronda ni cuánto hace ("hace 2 meses", "USD 5M") salvo que figure literal (no figura).
  (h) Si la línea NO trae ninguna señal verbalizable, escribí el ángulo como siempre (por qué encaja ese rol con lo que ofrece el cliente), SIN forzar un "por qué ahora" temporal inventado.
- PROHIBIDO copiar/pegar o calcar la estructura de un ángulo a otro. Antes de cerrar, revisá que el nombre y la empresa de cada ángulo sean los de ESE id.
- El HOOK = PRIMERA LÍNEA LISTA PARA COPIAR Y ENVIAR HOY (no un resumen): UNA sola oración entre comillas, empezando por el PRIMER NOMBRE (ej: "Clara, ...") y bien cerrada. Tiene que sonar a un mensaje que se manda tal cual. Cuando la card trae señal verbalizable, FUNDÍ esa señal (el timing, el "por qué ahora") con el contexto de la persona/empresa en ese mismo mensaje (ej: "Felicitaciones por asumir como [cargo]: con [empresa] en plena expansión de equipo, me gustaría comentarle cómo..."). UNA sola señal por hook, la misma que usaste en el ángulo, jamás apilada.
- HOOK COMPLETO Y CERRADO (REGLA DURA, defecto recurrente que se ve descuidado): cada hook tiene que ser una oración ENTERA y bien terminada, nunca cortada a mitad de frase ni sin puntuación final. Si es una PREGUNTA, abrí con "¿" y cerrá con "?" (signos apareados): prohibido un hook que arranca a preguntar y termina sin "?". Si es una afirmación, cerrá con punto. PROHIBIDO devolver hooks como "Flor, ...¿hoy lo gestionan de forma centralizada" (sin "?" ni cierre) o "Samanta, ...quién la gestiona en el día a día" (sin "?"): quedan colgados y queman la credibilidad. Antes de cerrar, releé cada hook entero y confirmá que la oración llega hasta el final y cierra con la puntuación correcta.
- DIVERSIDAD ESTRUCTURAL OBLIGATORIA DE HOOKS (el defecto MÁS frecuente: las cards salen con el mismo esqueleto): los hooks tienen que usar ${pedir} ABERTURAS DISTINTAS de este MENÚ, una forma diferente por card. (1) OBSERVACIÓN concreta sobre su empresa o su cargo ("Clara, vi que en [empresa] el área de [X] viene creciendo..."); (2) PREGUNTA DIRECTA sobre una decisión propia de ESE rol ("Marcos, cómo están resolviendo hoy [decisión del rol] en [empresa]"); (3) AFIRMACIÓN que conecta lo que hace el cliente con lo que esa persona maneja, SIN pregunta ("Lucía, su rol en [empresa] toca de lleno [lo que ofrece el cliente]."). PROHIBIDO que DOS hooks compartan el mismo molde sintáctico: ni los ${pedir} terminando en "¿...?", ni los ${pedir} con la plantilla "[Nombre], en [empresa] el [X] es [adj]", ni los ${pedir} arrancando con la misma palabra después del nombre. Si al releerlos dos suenan calcados, reescribí uno con otra abertura del menú.
- PROHIBIDO EL CONDICIONAL VACÍO (en ángulo Y hook): nada de "puede ser relevante si...", "podría necesitar...", "pueden requerir...", "puede ser útil...", "quizás le interese", "tal vez le sirva". Ese hedging suena a IA y no dice nada. Si NO tenés una señal concreta de esa persona, NO te la inventes (regla de anti-invención) PERO TAMPOCO hedgees: afirmá EN PRESENTE el punto de contacto REAL entre lo que hace ese rol y lo que el cliente OFRECE (ej. no "como Head of Ops quizás necesite cobertura técnica", sí "como Head of Ops usted gestiona la red de mantenimiento que [cliente] cubre"). Cualitativo, presente, sin "si/podría/quizás".
- NUNCA menciones el grado de conexión (1er/2do/3er grado) ni inventes datos que no estén en lo que te paso.
- IDIOMA: ángulo y hook en ESPAÑOL NEUTRO latinoamericano, trato de "usted". Sin voseo ni modismos argentinos.
- Texto plano: NADA de markdown (sin **negritas**, sin asteriscos). Solo el objeto JSON.
- SIN GUIONES: NUNCA uses guiones largos (—) ni guiones (-) como conectores o incisos en el ángulo ni en el hook. Usá comas, paréntesis o dos puntos. El texto tiene que sonar a persona, no a IA. OJO con el guion PEGADO a una palabra con espacio de un solo lado (el patrón que más se escapa): "su rol -clave en operaciones" o "el área- de mantenimiento" también están PROHIBIDOS; reescribilos con coma o paréntesis ("su rol, clave en operaciones"). El guion SOLO es válido dentro de compuestos legítimos sin espacios (e-commerce, C-level, co-fundador, start-up).
- ESTILO HUMANO (sutil): los hooks se mandan como si los escribiera una persona real, no una IA impecable. Está bien (y preferible) que ALGÚN hook corto AFIRMATIVO no termine en punto, como cuando uno escribe rápido por chat. Que sea SUTIL y OCASIONAL: a lo sumo UN detalle así, y SOLO en una afirmación. OJO, ESTO NO ES UNA EXCEPCIÓN A "HOOK COMPLETO Y CERRADO": la oración SIEMPRE va entera (nunca cortada a mitad de frase) y una PREGUNTA SIEMPRE cierra con "?" (abre "¿" y cierra "?", apareados); el único relajo permitido es omitir el punto final de una afirmación corta, jamás dejar una frase trunca ni una pregunta sin "?". PROHIBIDO errores de ortografía, palabras mal escritas o mayúsculas raras. El mensaje tiene que verse profesional y creíble, solo que humano.
- COMPETIDORES: NO elijas personas de empresas que sean COMPETIDORAS directas del cliente (que vendan/ofrezcan lo mismo). Preferí empresas que serían CLIENTES del cliente, no rivales.

## Output — SOLO JSON (sin texto alrededor)
{ "seleccion": [ {"id":"<id EXACTO de la lista>", "nombre":"<nombre TEXTUAL del candidato de ESE id, copiado de la lista>", "empresa":"<empresa TEXTUAL del candidato de ESE id, copiada de la lista>", "angulo":"...", "hook":"\\"...\\""} ] }
EXACTAMENTE ${pedir} elementos distintos, en orden de prioridad. NADA fuera del objeto JSON.
Los campos "nombre" y "empresa" son OBLIGATORIOS y van copiados TEXTUAL del candidato de ESE id (re-anclan id→persona en el momento de escribir): escribilos JUSTO ANTES de "angulo"/"hook" para que el ángulo y el hook que sigan sean de ESA persona y NO de otra.

## VERIFICACIÓN FINAL (OBLIGATORIA — antes de devolver el JSON)
VERIFICÁ, elemento por elemento, que el "nombre" y la "empresa" sean los del id elegido (copiados de la lista, no de otro renglón), que el HOOK EMPIECE con el PRIMER NOMBRE de ESE id, y que el ÁNGULO NOMBRE la EMPRESA de ESE id. Si alguno no cumple, REESCRIBILO antes de cerrar: una card con el hook o el ángulo de OTRA persona/empresa (MEZCLA) quema todo el reporte.
VERIFICÁ ADEMÁS: (a) que las ${pedir} aberturas de los hooks sean ESTRUCTURALMENTE DISTINTAS (no dos con el mismo molde ni todas terminando en "?"); (b) que ningún ángulo/hook use CONDICIONAL VACÍO ("puede/podría/quizás/si necesita"); (c) que NO le atribuyas a la persona una responsabilidad de compra/decisión/liderazgo que su cargo real NO implica (re-encuadre prohibido); (d) que NO le atribuyas al CLIENTE ningún logro, caso, métrica o implementación que no esté TEXTUAL en el contexto "Qué ofrece / proof"; (e) que NINGÚN ángulo/hook AFIRME que la empresa de la card COMPRA/ALOJA/REVENDE/INTEGRA lo del cliente sin evidencia (fit de negocio inexistente), ni que hayas elegido una empresa que es claramente NO comprador (marca propia que no aloja terceros, gigante irreal para el tamaño del cliente, contratista/micro cuando el ICP pide operadores, o mismo sustantivo distinto negocio) habiendo en el pool una alternativa comprable mejor; (f) SEÑALES DE COMPRA: que NINGÚN ángulo/hook afirme una señal ("asumió el rol hace poco", "recién llegó", "levantó financiamiento", "cambió su liderazgo", "está contratando", "está creciendo") cuyo marcador EXACTO NO esté en ESA línea de candidato; que NO inventes fecha, monto, ronda ni antigüedad exacta; que cada card use UNA SOLA señal (la más fuerte), NUNCA dos o más apiladas; y que NUNCA verbalices "activo en LinkedIn" (es interno, decirlo espanta al prospecto); (g) que CADA hook esté COMPLETO y CERRADO: la oración llega hasta el final (ninguno cortado a mitad de frase), las preguntas abren "¿" y cierran "?" (signos apareados) y ninguna queda sin "?"; (h) que cada ÁNGULO ancle un dato o pain ESPECÍFICO de ESA empresa/persona y que los ${pedir} ángulos NO compartan el mismo pain ni una frase intercambiable entre cards (sin cierres template tipo "exactamente el tipo de herramienta/solución que [rol] necesita"). Si algo de esto falla, REESCRIBILO o RE-ELEGÍ antes de cerrar.

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
    // SEÑAL DE COMPRA (dato real del MCP, NO inventado): marcador para que SELECT pueda tejerlo en el ángulo.
    // Marcadores LITERALES (sin monto/fecha: el detalle datado llega en otra fase con web_search):
    //   " · SEÑAL: asumió el rol hace poco"            (recienAsumio, por persona)
    //   " · SEÑAL: la empresa levantó financiamiento"  (senales.funding)
    //   " · SEÑAL: la empresa está contratando"        (senales.hiring)
    //   " · SEÑAL: cambio de liderazgo en la empresa"  (senales.leadership)
    //   " · SEÑAL: la empresa está creciendo en plantilla" (senales.growth)
    //   " · activo en LinkedIn"                         (posts>0)
    const s = p.senales || {};
    const senal = `${p.recienAsumio?' · SEÑAL: asumió el rol hace poco':''}`
      + `${s.funding?' · SEÑAL: la empresa levantó financiamiento':''}`
      + `${s.hiring?' · SEÑAL: la empresa está contratando':''}`
      + `${s.leadership?' · SEÑAL: cambio de liderazgo en la empresa':''}`
      + `${s.growth?' · SEÑAL: la empresa está creciendo en plantilla':''}`
      + `${p.posts>0?' · activo en LinkedIn':''}`;
    return `${i+1}. id=${p.id} | ${p.name} | ${p.head} | empresa: ${p.empresa||'?'}${tam}${loc}${home} | grado ${p.dist===9?'fuera de red':p.dist+'°'}${ctx}${senal}`;
  }).join('\n');
  const _pisoTam = (plan._plan && parseInt(plan._plan.tamano_min||0,10)) || 0;
  const vertAlta = (plan._plan && Array.isArray(plan._plan.industrias) ? plan._plan.industrias.filter(Boolean) : []);
  const ctx = `Cliente: ${(cliente&&cliente.empresa)||plan.h1_company||''}. País del cliente (prioritario): ${(plan._plan&&plan._plan.geografia)||''}. Qué ofrece / proof: ${String(plan.proof||plan.lead||'').slice(0,500)}. Función del comprador: ${(plan._plan&&plan._plan.funcion)||''}.${(plan._plan&&plan._plan.comprador_ideal)?` Comprador ideal (FILTRO FUERTE de fit-de-negocio, no solo de vertical: la empresa de cada card debe poder COMPRAR/ALOJAR/REVENDER lo del cliente; evitá marcas propias que no alojan terceros, gigantes irreales para el tamaño del cliente, contratistas/micro cuando se piden operadores, y mismo-sustantivo-distinto-negocio): ${plan._plan.comprador_ideal}.`:''}${vertAlta.length?` Verticales prioridad ALTA (preferí SIEMPRE candidatos de estas; elegí de una Media solo si no hay suficientes buenos de las ALTA): ${vertAlta.join(', ')}.`:''}${_pisoTam>0?` Piso de tamaño del ICP: ${_pisoTam}+ empleados (preferí empresas que lo cumplen; evitá las claramente micro salvo que el lead sea fuerte en los demás ejes).`:''}`;
  const fixBloque = (fixes&&fixes.length) ? `\n\nCORRECCIONES del juez (aplicalas re-eligiendo o reescribiendo):\n- ${fixes.join('\n- ')}` : '';
  const messages = [{ role:'user', content:`${ctx}\n\nLISTA REAL DE CANDIDATOS (elegí de ACÁ, por id EXACTO; los ★ son del país del cliente):\n${lista}${fixBloque}\n\nElegí los ${PEDIR_SELECT} MEJORES en ORDEN de prioridad (el mejor primero), de EMPRESAS distintas y priorizando el país del cliente. Devolvé SOLO el JSON {"seleccion":[...]} con EXACTAMENTE ${PEDIR_SELECT} elementos distintos. El sistema arma el reporte con los primeros ${NUM_CUENTAS} válidos, así que los primeros ${NUM_CUENTAS} tienen que ser tus mejores.` }];
  // Temperatura un poco más alta SOLO en SELECT: empuja la diversidad estructural de hooks/ángulos (las cards
  // calcadas son el defecto más frecuente). NO toca PLAN ni el juez (que quedan en el default determinístico).
  const tempSelect = (() => { const v = parseFloat(process.env.TEMP_GEN); return Number.isFinite(v) ? v : 0.7; })();
  const data = await callClaude({ model:MODEL_GEN, system:_promptSelect(PEDIR_SELECT, NUM_CUENTAS), messages, tools:[], maxTokens:6000, temperature: tempSelect });
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
  // Guion conector ASCII: lo tratamos como inciso/conector SOLO cuando hay espacio en AL MENOS un lado
  // ("a - b", "a -b", "a- b"). Eso NO toca compuestos intra-palabra (e-commerce, C-level, co-fundador,
  // start-up) porque ahí el guion no tiene espacio en ningún lado. \s+-\s+ primero (ambos lados), luego
  // los casos de un solo lado, para no dejar comas dobles.
  t = t.replace(/\s+-\s+/g, ', ');
  t = t.replace(/\s+-(?=\S)/g, ', ');   // "texto -inciso"
  t = t.replace(/(?<=\S)-\s+/g, ', ');  // "inciso- texto"
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
// Saneo del CARGO de la card (datos REALES del MCP, solo se LIMPIA lo que vino, NO se inventa nada):
//   (a) caracteres no imprimibles / símbolos rotos de headlines de LinkedIn (emojis, glyphs "▯", zero-width)
//       — conserva tildes, ñ y puntuación normal;
//   (b) sufijo redundante " en <empresa>" / " at <empresa>" / " para <empresa>" cuando la empresa de la card
//       (que ya va aparte en otra columna) quedó pegada al cargo (caso "Jefa de marketing en Sportline.");
//   (c) puntuación/espacios sobrantes al final.
function _saneaCargo(cargo, empresa){
  let t = String(cargo || '');
  // (a) Quitar emojis, símbolos sueltos y caracteres de control / formato (zero-width, replacement char).
  // Conservamos letras (incl. acentuadas/ñ), números, espacios y la puntuación común de un cargo.
  t = t.replace(/[ --​-‏‪-‮⁠﻿�]/g, ' ');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/gu, ' ');
  t = t.replace(/\s{2,}/g, ' ').trim();
  // (b) Sufijo " en/at/para <empresa>" redundante (la empresa ya va en su propia columna).
  const emp = String(empresa || '').trim();
  if(emp.length >= 2){
    const empEsc = emp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s+(?:en|at|para)\\s+${empEsc}\\b\\.?\\s*$`, 'i'), '');
  }
  // (c) Puntuación/espacios finales sobrantes (punto, coma, separadores colgando).
  t = t.replace(/[\s.,;:·•|/\-]+$/u, '').trim();
  return t;
}
// Colapsa tokens repetidos CONSECUTIVOS en una ubicación: "X, México, México" -> "X, México",
// "México, México, México" -> "México". Genérico (cualquier token, no solo país), case-insensitive,
// conserva el primer token tal como vino (con sus tildes/mayúsculas). NO reordena ni inventa nada.
function _dedupUbicacion(loc){
  const partes = String(loc || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for(const p of partes){
    const prev = out.length ? out[out.length - 1] : null;
    if(prev && _norm(prev) === _norm(p)) continue;   // token repetido consecutivo -> se omite
    out.push(p);
  }
  return out.join(', ');
}
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
// ¿El cargo muestra FIT-DE-FUNCIÓN real, o solo seniority genérica? ENDURECIDO (decisión del cliente):
// antes alcanzaba con CUALQUIER marcador de seniority (gerente/director/...) aunque la función no tuviera
// nada que ver con el ICP -> dejaba pasar adyacentes (geotecnia, militar, consultora) que el juez después
// rechaza. Ahora exige:
//   (a) FIT DE FUNCIÓN real: el cargo contiene un término del ICP (titulos_objetivo), O
//   (b) marcador de DECISIÓN + alguna pista de vertical (un término del ICP O de las industrias del ICP
//       en el cargo). La seniority genérica SOLA (ej. "Director" a secas, sin pista de vertical) ya NO basta.
// Cuando el ICP no aporta señales de vertical (sin titulos ni industrias), caemos al comportamiento previo
// (marcador de decisión basta) para no vaciar el pool de clientes con ICP pobre.
function _rolRelevante(cargo, titulos, industrias){
  const c = _norm(cargo);
  if(!c) return false;
  const kws = (titulos||[]).map(k=>_norm(k)).filter(k=>k.length>=3);
  if(kws.some(k=>c.includes(k))) return true;                 // (a) fit de función directo
  const decide = _MARCADOR_DECISION.test(c);
  if(!decide) return false;                                   // sin decisión y sin fit -> fuera
  const indKws = (industrias||[]).map(k=>_norm(k)).filter(k=>k.length>=4);
  const pistas = kws.concat(indKws);
  if(!pistas.length) return true;                             // ICP sin señales de vertical -> decisión basta (fallback)
  // (b) decisión + pista de vertical en el cargo. Si hay pistas pero ninguna aparece, es seniority
  // genérica off-vertical -> NO relevante (que se hunda antes de llegar a la IA).
  return pistas.some(k=>c.includes(k));
}
// FIT RELAJADO — "última instancia". Igual que _rolRelevante PERO acepta a un DECISOR (marcador de decisión)
// AUNQUE no tenga pista de vertical en el cargo. Resuelve el caso nicho (indIds=0): el MCP devuelve headlines
// en inglés que no matchean las pistas de vertical del PLAN, así que _rolRelevante hunde a TODOS los decisores
// reales y un pool de cientos sale con 0 cards. SOLO se relaja la "pista de vertical"; el resto de innegociables
// (IC suelto, competidor/par, vertical excluida, empresa real, geo) se chequean APARTE en armarReporte.
function _rolRelevanteLaxo(cargo, titulos, industrias){
  const c = _norm(cargo);
  if(!c) return false;
  const kws = (titulos||[]).map(k=>_norm(k)).filter(k=>k.length>=3);
  if(kws.some(k=>c.includes(k))) return true;                 // (a) fit de función directo (igual que estricto)
  return _MARCADOR_DECISION.test(c);                          // (b laxo) decisor SIN exigir pista de vertical
}

// Etiquetas legibles de las señales REALES que un candidato del pool ya trae. Mapea los flags
// (`recienAsumio` por persona, `senales:{funding,leadership,hiring,growth}` por empresa-ancla) a texto
// mostrable. Orden por FUERZA de señal de compra. EXCLUYE deliberadamente "activo en LinkedIn"/posts
// (regla anti-creepy: solo ranking interno). Devuelve [] si no hay ninguna (no rompe el render).
function _senalesVisibles(p){
  const out = [];
  if(!p) return out;
  const s = p.senales || {};
  if(p.recienAsumio) out.push('Recién asumió el rol');
  if(s.funding)      out.push('Levantó financiamiento');
  if(s.leadership)   out.push('Cambio de liderazgo');
  if(s.hiring)       out.push('Está contratando');
  if(s.growth)       out.push('Creciendo en plantilla');
  return out;
}
function armarReporte(plan, seleccion, pool, senales){
  const titulos = (plan._plan && plan._plan.titulos_objetivo) || [];
  const industrias = (plan._plan && plan._plan.industrias) || [];
  const byId = new Map(pool.map(p=>[p.id, p]));
  const cards=[]; const usados=new Set(); const usadasEmp=new Set();
  // ROL: solo cuando el ICP pide gerencia/dueño preferimos NO tomar IC sueltos si hay decisores disponibles.
  const pideDecisores = _icpPideDecisores(plan);
  const MIN = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);

  // --- INNEGOCIABLES para el FIT RELAJADO (no se relajan; ver _rolRelevanteLaxo) ---
  // Detector de competidor/par (mismo armado que sourceConRetry): competidores explícitos + competidor_terminos
  // (sin pisar el vertical del propio comprador), match contra el NOMBRE de empresa.
  const _icp = (plan && plan._plan) || {};
  const _raiz = w => w.slice(0, Math.max(5, w.length - 2));
  const _vertTokens = _vocabVertical(_icp);
  const competidores = (Array.isArray(_icp.competidores)?_icp.competidores:[]).map(_norm).filter(c=>c.length>=4);
  const compTerminos = (Array.isArray(_icp.competidor_terminos)?_icp.competidor_terminos:[])
    .map(_norm).filter(t => {
      if(t.length < 4) return false;
      const rt = _raiz(t);
      return !_vertTokens.some(w => { const rw=_raiz(w); return w.includes(t)||t.includes(w)||rt.startsWith(rw)||rw.startsWith(rt); });
    });
  const _esComp = (emp) => { const e=_norm(emp||''); if(!e) return false; return _esCompetidor(e, competidores) || compTerminos.some(t=>e.includes(t)); };
  const excluir = _verticalesExcluir(plan);
  // GEO objetivo del reporte: países nombrados en el título/lead de página 1 + geografía declarada del PLAN.
  // Sirve para el chequeo de geo INNEGOCIABLE del fit relajado (el geo a nivel reporte ya corre downstream).
  const _paisesObjetivo = new Set([
    ..._paisesDeTexto(plan.h1_post), ..._paisesDeTexto(plan.lead),
    ..._paisesDeTexto((plan._plan && plan._plan.geografia) || '')
  ]);
  const _geoOk = (loc) => {
    if(!_paisesObjetivo.size) return true;            // sin país objetivo reconocible -> no podemos juzgar geo
    const pc = _paisesDeTexto(loc);
    if(!pc.length) return true;                       // ubicación sin país reconocible -> no bloqueamos por geo
    return pc.some(p => _paisesObjetivo.has(p));
  };

  // Intenta materializar UNA card desde la selección de la IA. Devuelve la card (sin pushear) o null si no
  // pasa los guards. NO muta estado salvo cuando `commit` es true (reserva id/empresa). Así podemos correr
  // dos pasadas (decisores primero, IC sueltos como fallback) sin tocar la lógica de cada guard.
  function intentarCard(s, { commit, laxo }={}){
    const p = byId.get(s.id);
    if(!p){ console.warn(`[SELECT] id fuera del pool, ignorado: ${s.id}`); return null; }
    if(usados.has(s.id)){ if(commit) console.warn(`[SELECT] id DUPLICADO, ignorado: ${p.name}`); return null; }
    const angulo=String(s.angulo||'').trim(), hook=String(s.hook||'').trim();
    if(!angulo || !hook){ if(commit) console.warn(`[SELECT] card sin ángulo/hook, descartada: ${p.name}`); return null; }
    const empresa = p.empresa || _empresaDeHeadline(p.head) || '';
    if(!empresa){ if(commit) console.warn(`[SELECT] card sin empresa real, descartada: ${p.name}`); return null; }
    const cargoBase = String(p.head||'').split('@')[0];

    // --- GUARDA DE FUNCIÓN: el cargo tiene que mostrar la función objetivo o ser un decisor ---
    // Modo ESTRICTO: _rolRelevante (función del ICP, o decisión + pista de vertical).
    // Modo LAXO (fallback de piso, última instancia): _rolRelevanteLaxo acepta a un DECISOR sin pista de
    // vertical, PERO igual exige los INNEGOCIABLES que NO se relajan: no IC suelto, no competidor/par, no
    // vertical excluida, empresa real (ya chequeada arriba) y geo correcta. Solo se relaja la pista de vertical.
    if(laxo){
      if(!_rolRelevanteLaxo(cargoBase, titulos, industrias)){
        if(commit) console.warn(`[FIT-RELAJADO] descartada: no es decisor ni on-función: ${p.name} ("${cargoBase.slice(0,50)}")`);
        return null;
      }
      if(_esICsuelto(cargoBase)){ if(commit) console.warn(`[FIT-RELAJADO] descartada por IC suelto: ${p.name} ("${cargoBase.slice(0,50)}")`); return null; }
      if(_esComp(empresa) || _esComp(p.name)){ if(commit) console.warn(`[FIT-RELAJADO] descartada por COMPETIDOR/par: ${p.name} @ ${empresa}`); return null; }
      if(excluir.length && (_matchVerticalExcluir(empresa, excluir) || _matchVerticalExcluir(p.head, excluir))){ if(commit) console.warn(`[FIT-RELAJADO] descartada por vertical EXCLUIDA: ${p.name} @ ${empresa}`); return null; }
      if(!_geoOk(p.loc)){ if(commit) console.warn(`[FIT-RELAJADO] descartada por GEO fuera de objetivo: ${p.name} ("${p.loc||''}")`); return null; }
    } else if(!_rolRelevante(cargoBase, titulos, industrias)){
      if(commit) console.warn(`[SELECT] card DESCARTADA por FUNCIÓN equivocada/irrelevante: ${p.name} ("${String(p.head||'').slice(0,50)}")`);
      return null;
    }

    // --- GUARD ANTI-MEZCLA: el ángulo/hook tienen que ser de ESTA persona/empresa ---
    // Señal ESPEJO (detección temprana, fail-closed): SELECT copia nombre/empresa del id elegido. Si el
    // nombre o la empresa espejo NO matchean los datos reales del id, es un cruce id→persona casi seguro
    // (la IA escribió contra otro renglón). Antes el espejo era decorativo; ahora descarta la card.
    if(s.nombre){
      const espejoN = _norm(s.nombre), nameN = _norm(p.name);
      const primeroEspejo = espejoN.split(' ')[0] || '';
      const matchEspejo = (espejoN && nameN && (nameN.includes(espejoN) || espejoN.includes(nameN))) ||
                          (primeroEspejo.length >= 3 && nameN.includes(primeroEspejo));
      if(!matchEspejo){
        if(commit) console.warn(`[SELECT] card DESCARTADA por MEZCLA (nombre espejo "${s.nombre}" no corresponde al id ${p.name})`);
        return null;
      }
    }
    // Espejo de EMPRESA: si la IA copió la empresa del id, tiene que matchear la empresa real del candidato.
    // Solo validamos cuando ambas tienen tokens útiles (>=4 chars), para no descartar por abreviaturas/sufijos.
    if(s.empresa){
      const espejoEmpN = _norm(s.empresa), realEmpN = _norm(empresa);
      const espejoTok = espejoEmpN.split(' ').filter(w => w.length >= 4);
      const realTok = realEmpN.split(' ').filter(w => w.length >= 4);
      if(espejoTok.length && realTok.length){
        const matchEmp = realEmpN.includes(espejoEmpN) || espejoEmpN.includes(realEmpN) ||
                         espejoTok.some(w => realTok.includes(w));
        if(!matchEmp){
          if(commit) console.warn(`[SELECT] card DESCARTADA por MEZCLA (empresa espejo "${s.empresa}" no corresponde al id ${p.name} @ ${empresa})`);
          return null;
        }
      }
    }
    const primerNombre = (_norm(p.name).split(' ')[0]) || '';
    const hookN = _norm(hook), angN = _norm(angulo), empN = _norm(empresa);
    const hookNombra = primerNombre.length >= 3 && hookN.includes(primerNombre);
    const empTokens = empN.split(' ').filter(w => w.length >= 4);
    const angCoherente = (primerNombre.length >= 3 && angN.includes(primerNombre)) || empTokens.some(w => angN.includes(w));
    if(!hookNombra || !angCoherente){
      if(commit) console.warn(`[SELECT] card DESCARTADA por MEZCLA (no corresponde a ${p.name} @ ${empresa}) | hook="${hook.slice(0,70)}"`);
      return null;
    }
    // --- fin guards ---

    const empKey = _empKey(empresa);
    if(empKey && usadasEmp.has(empKey)){ if(commit) console.warn(`[SELECT] empresa DUPLICADA, ignorada: ${p.name} @ ${empresa}`); return null; }
    if(commit){ usados.add(s.id); if(empKey) usadasEmp.add(empKey); }
    return {
      empresa, nombre: p.name, cargo: _saneaCargo(_cargoCorto(p.head, titulos), empresa),
      urn: p.id, slug: _slugCos(p.name),
      ubicacion: _dedupUbicacion(p.loc || ((plan._plan && plan._plan.geografia) || '')),
      grado: _degOrdinal(p.dist===9?3:p.dist, '2do') + ' grado',
      headcount: (p.headcount ?? null),
      // SEÑALES VISIBLES: etiquetas legibles SOLO de flags REALES que esta card/empresa ya tiene
      // (de _parsePeople/_parseProfile para `recienAsumio` y de la cuenta-ancla para `senales`).
      // NO inventa nada. EXCLUYE "activo en LinkedIn" (posts): esa señal es solo ranking interno
      // (regla anti-creepy), NUNCA se muestra. Orden por fuerza: recién asumió, financiamiento,
      // liderazgo, contratando, creciendo. Si no hay señales, queda []. OJO: distinto de `card.senales`,
      // que `enriquecerSenales` PISA con [{tipo,texto,fuente,fecha}] generado por la IA.
      senalesVisibles: _senalesVisibles(p),
      // fit_relajado: card materializada en la SEGUNDA pasada (gate laxo). Interno: telemetría/juez. No lo
      // toca el render. Las cards de fit ESTRICTO no llevan el flag (quedan undefined -> falsy).
      ...(laxo ? { fit_relajado:true } : {}),
      angulo: _limpia(angulo), hook: _limpia(hook)
    };
  }

  if(pideDecisores){
    // GUARDA PREFERENCIAL: dos pasadas. (1) Solo decisores de la selección. (2) IC sueltos como fallback, SOLO
    // para llenar lo que falte. Así, si hay un decisor que pasa los demás guards (empresa distinta/geo/fit), la
    // card de IC suelto NO se toma. Si el pool es TODO IC, igual se llenan cards (degradación digna, no se vacía).
    const idEsIC = s => { const p = byId.get(s.id); return p && _esICsuelto(String(p.head||'').split('@')[0]); };
    const decisores = (seleccion||[]).filter(s => !idEsIC(s));
    const ics       = (seleccion||[]).filter(s =>  idEsIC(s));
    for(const s of decisores){
      if(cards.length >= NUM_CUENTAS) break;
      const card = intentarCard(s, { commit:true });
      if(card) cards.push(card);
    }
    // ¿Quedan slots y existen IC sueltos seleccionables? Avisamos por qué los tomamos (no hubo más decisores).
    const faltan = NUM_CUENTAS - cards.length;
    if(faltan > 0 && ics.length){
      console.warn(`[ROL] ${faltan} slot(s) sin decisor disponible -> uso IC sueltos como fallback (degradación digna, no vacío el reporte).`);
      for(const s of ics){
        if(cards.length >= NUM_CUENTAS) break;
        const card = intentarCard(s, { commit:true });
        if(card){ console.warn(`[ROL] card de IC suelto aceptada por falta de decisor: ${card.nombre} ("${(card.cargo||'').slice(0,40)}").`); cards.push(card); }
      }
    } else if(ics.length){
      console.log(`[ROL] ${ics.length} IC suelto(s) en la selección OMITIDO(s): había decisores suficientes.`);
    }
  } else {
    // ICP no pide decisores (o apunta legítimamente a ICs): comportamiento original, una sola pasada.
    for(const s of (seleccion||[])){
      if(cards.length >= NUM_CUENTAS) break;
      const card = intentarCard(s, { commit:true });
      if(card) cards.push(card);
    }
  }
  // --- FALLBACK DE PISO (fit relajado) ----------------------------------------------------------------
  // Si la pasada ESTRICTA no llegó a MIN cards, completamos hasta NUM_CUENTAS con una SEGUNDA pasada sobre el
  // pool restante (los ids de la selección aún no usados) usando el gate LAXO (_rolRelevanteLaxo): aceptamos a
  // un DECISOR aunque su cargo no traiga pista de vertical (caso nicho indIds=0, headlines en inglés del MCP).
  // Los INNEGOCIABLES NO se relajan (IC suelto / competidor-par / vertical excluida / empresa real / geo: se
  // chequean dentro de intentarCard en modo laxo). Las cards estrictas YA están pusheadas primero (mejor
  // calidad), así que el fallback solo RELLENA: nunca reemplaza una buena por una relajada. El dedupe por id y
  // por empresa lo mantiene intentarCard (usados/usadasEmp). MOTIVO: un pool de cientos de decisores reales no
  // puede salir con 0 cards.
  if(cards.length < MIN){
    const estrictas = cards.length;
    for(const s of (seleccion||[])){
      if(cards.length >= NUM_CUENTAS) break;
      const card = intentarCard(s, { commit:true, laxo:true });
      if(card) cards.push(card);
    }
    const relajadas = cards.length - estrictas;
    if(relajadas > 0) console.warn(`[FIT-RELAJADO] piso estricto dio ${estrictas}/${MIN}; completo ${relajadas} cards con fit relajado.`);
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
  // SEÑALES DE MERCADO: datos REALES del MCP (sourceCandidates), no generados por IA. Se pegan tal cual.
  // Si el sourcing no logró ninguna señal real, queda [] (el template/render decide cómo mostrarlo).
  const senalesReales = Array.isArray(senales) ? senales.filter(s => s && s.label && (s.value!=null && String(s.value).trim()!=='')) : [];
  return { ...base, cards, senales: senalesReales };
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
// Compara el país de cada card contra el país objetivo del reporte. Hay DOS niveles de objetivo:
//   - TÍTULO (h1_post): es lo que el reporte AFIRMA ser ("3 clientes potenciales en España"). Es la promesa
//     que el prospecto lee primero; las cards TIENEN que poder leerse como cumpliéndola.
//   - DECLARADO (h1_post + lead): set ampliado con los países que el cliente HOY opera, nombrados en la prosa
//     del lead. Sirve para el caso multi-país legítimo (cards repartidas entre varios países que el cliente opera).
// La grilla ICP ya NO tiene celda "Geografía", por eso el set se arma de los textos visibles de la página 1.
//
// BUG QUE ESTO ARREGLA (brandtrack real): el título decía "España" y las 3 cards eran de Argentina, pero el
// lead nombraba [Argentina, México, Chile, España] (multi-país en prosa). El objetivo viejo (h1_post+lead unidos)
// incluía "argentina" → las cards de Argentina pasaban y el reporte salía APROBADO con un título mentiroso.
// CRITERIO SANO: además del chequeo por-card contra el set DECLARADO (multi-país tolerado), exigimos que el
// TÍTULO no sea huérfano: si h1_post nombra países y NINGUNA card cae en ALGÚN país del título (todas están en
// otro lado), es defecto aunque caigan dentro del set ampliado del lead.
// Devuelve null si todo coherente; o { objetivo:[...], fuera:[...] } si hay incoherencia.
function _geoIncoherente(data){
  if(!data) return null;
  const titulo    = new Set(_paisesDeTexto(data.h1_post));          // países que el TÍTULO afirma
  const declarado = new Set([...titulo, ..._paisesDeTexto(data.lead)]); // set ampliado (multi-país legítimo)
  if(!declarado.size) return null; // sin país objetivo reconocible no podemos juzgar → no bloquear
  const fuera = [];
  // 1) Chequeo por-card contra el set DECLARADO (tolera el multi-país: una card por país operado está OK).
  for(const c of (data.cards||[])){
    const paisesCard = _paisesDeTexto(c.ubicacion);
    if(!paisesCard.length) continue; // ubicación sin país reconocible → no bloquear por esta card
    if(!paisesCard.some(p => declarado.has(p))){
      fuera.push(`${c.nombre||'?'} (${c.empresa||'?'}) figura en "${c.ubicacion}", fuera del/los país(es) declarado(s) del reporte (${[...declarado].join(', ')}).`);
    }
  }
  // 2) TÍTULO HUÉRFANO: si el título nombra país(es) pero NINGUNA card (con país reconocible) cae en ALGÚN país
  //    del título, el título promete un mercado donde no hay ni una sola card → incoherente. No dispara si las
  //    cards no tienen país reconocible (no podemos afirmar nada) ni si al menos una card está en un país del título.
  if(titulo.size){
    const cardsConPais = (data.cards||[]).map(c=>({c, paises:_paisesDeTexto(c.ubicacion)})).filter(x=>x.paises.length);
    const algunaEnTitulo = cardsConPais.some(x => x.paises.some(p => titulo.has(p)));
    if(cardsConPais.length && !algunaEnTitulo){
      const detalle = cardsConPais.map(x=>`${x.c.nombre||'?'} (${x.c.empresa||'?'}) en "${x.c.ubicacion}"`).join('; ');
      fuera.push(`El título nombra ${[...titulo].join(', ')} pero NINGUNA card está ahí: ${detalle}.`);
    }
  }
  if(!fuera.length) return null;
  // objetivo reportado = el set declarado (lo que se usa en los mensajes de fix).
  return { objetivo:[...declarado], titulo:[...titulo], fuera };
}

// --- COHERENCIA DEL CONTEO DE PAÍSES (determinística) -------------------------
// Defecto recurrente que se escapa al cliente: el número del stat de países (ej. "4") no coincide con la
// cantidad de países realmente NOMBRADOS en el título (h1_post) y la prosa del lead.
// DECISIÓN DE PRODUCTO: un mismatch de conteo es COSMÉTICO, no un defecto de lead → NORMALIZAR conservador
// (auto-corregir el número a la cantidad de países efectivamente nombrados) en vez de retener todo el reporte.
// NUNCA agrega países: solo baja/ajusta el número del stat a lo que el texto ya nombra. Si no se puede
// normalizar (no hay stat de países, o el texto no nombra ningún país), devuelve {rechazar:true}.
//
// EL LEAD TAMBIÉN CUENTA (residual brandtrack #3: stat=3, ICP/h1=3, pero el lead nombraba 4): la prosa del
// lead es texto visible que el prospecto lee, así que si nombra países FUERA del set canónico (h1_post + ICP),
// hay incoherencia visible que NO se arregla normalizando el stat. NO subimos el conteo a lo que dice el lead
// (eso sería "agregar países" y el lead no es la fuente canónica del conteo): el set canónico sigue siendo
// h1_post. El lead actúa solo como CHEQUE: si menciona más países que el canónico, no se
// puede normalizar sin reescribir prosa → {rechazar:true} (devolvemos al juez/fixes en vez de mostrar el bug).
// MUTA data.stats in place (ajusta el num del stat de países). Devuelve {ajustado, antes, despues} o null.
function _paisesIncoherente(data){
  if(!data || !Array.isArray(data.stats)) return null;
  // 1) Stat de países: label que contiene "pais"/"país" (normalizado saca acentos). No confundir con "ciudad".
  const idx = data.stats.findIndex(s => s && /\bpais(es)?\b/.test(_norm(s.label||'')));
  if(idx < 0) return null;                       // no hay stat de países → nada que normalizar, no juzgamos
  const stat = data.stats[idx];
  const m = String(stat.num||'').match(/\d+/);
  if(!m) return null;                            // el num no es numérico (ej. una ciudad) → no juzgamos
  const declarado = parseInt(m[0], 10);
  // 2) Set CANÓNICO de países: los NOMBRADOS en h1_post. La grilla ICP ya NO tiene celda "Geografía", así que
  //    h1_post es la superficie autoritativa donde se nombran los países; el lead NO amplía el set canónico
  //    (nunca agregamos países), solo lo audita en el paso 4.
  const nombrados = new Set();
  for(const p of _paisesDeTexto(data.h1_post)) nombrados.add(p);
  const real = nombrados.size;
  // stat numérico > 0 pero el texto no nombra país reconocible: no se puede normalizar. (declarado 0 + 0 nombrados
  // es coherente y degenerado: cae al chequeo del lead y, si tampoco hay extra, al `declarado === real` de abajo.)
  if(real <= 0 && declarado > 0) return { rechazar:true, declarado, real };
  // 3) CHEQUE DEL LEAD (conservador, no agrega países): si la prosa del lead nombra países que NO están en el
  //    set canónico, queda un mismatch VISIBLE que no se arregla tocando solo el stat → rechazar para fixes.
  const leadExtra = _paisesDeTexto(data.lead).filter(p => !nombrados.has(p));
  if(leadExtra.length) return { rechazar:true, declarado, real, leadExtra };
  if(declarado === real) return null;            // coherente (stat == canónico y lead no agrega), nada que hacer
  // 4) Normalización conservadora: el stat pasa a la cantidad realmente nombrada (sin tocar el texto, sin
  //    agregar países). Preserva sufijos como "+" si los hubiera (ej. "4+" → "3+").
  const sufijo = String(stat.num||'').replace(/^\s*\d+/, '');
  stat.num = `${real}${sufijo}`;
  return { ajustado:true, antes:declarado, despues:real, paises:[...nombrados] };
}

// --- ARREGLO DE PÁGINA 1 POR PAÍSES (en vez de rechazar) ----------------------
// Caso recurrente (apodemia, Emi Labs): las cards son BUENAS y on-país, pero la prosa del `lead` nombra un país
// que NO está en el set canónico (h1_post). Antes eso era {rechazar:true} y NO salía PDF.
// DECISIÓN DE PRODUCTO (jefe): NO desperdiciar cards buenas. ARREGLAR la página 1 para que quede COHERENTE con
// h1_post (reducir, NUNCA agregar países que el cliente no opera), y MANDAR. Hacemos un rewrite TARGETED y
// barato (1 call corta a Claude, SIN web_search, SIN re-sourcing): le pasamos el `data` actual + la lista de países
// PERMITIDOS y le pedimos reescribir SOLO `lead`, `h1_post` y el stat de países para que nombren EXACTAMENTE esos
// países, sin tocar cards ni inventar nada. MUTA data in place (lead, h1_post, stat de países).
// Devuelve { ok:bool, permitidos:[...], antes:{lead,h1_post} } o { ok:false, motivo } si no se pudo.
async function _reescribirPaisesPagina1(data, plan){
  if(!data) return { ok:false, motivo:'sin data' };
  // Set CANÓNICO permitido = países nombrados en h1_post (lo mismo que usa _paisesIncoherente).
  // Esa es la fuente de verdad de dónde opera el cliente; el lead se recorta a ESTO, nunca al revés.
  const permitidos = new Set();
  for(const p of _paisesDeTexto(data.h1_post)) permitidos.add(p);
  // Si por algún motivo no hay países canónicos, caemos al país del cliente declarado en el plan (geografia).
  if(!permitidos.size){
    const geoPlan = (plan && plan._plan && plan._plan.geografia) || '';
    for(const p of _paisesDeTexto(geoPlan)) permitidos.add(p);
  }
  if(!permitidos.size) return { ok:false, motivo:'sin países canónicos para anclar el arreglo' };
  const lista = [...permitidos].join(', ');
  const antes = { lead: data.lead, h1_post: data.h1_post };
  const sys = `Sos un editor de un reporte de mercado en ESPAÑOL NEUTRO latinoamericano (trato de "usted", SIN voseo, SIN modismos argentinos). Tu única tarea es hacer COHERENTE la geografía de la página 1: el texto NO puede nombrar ningún país fuera de la lista PERMITIDA. NUNCA agregues un país que no esté en la lista. NUNCA inventes métricas, años, certificaciones ni nombres de terceros. SIN guiones (— ni -) como conectores: usá comas, paréntesis o dos puntos. Devolvé SOLO un JSON {"lead":"...","h1_post":"...","stat_paises_num":"N"} y nada más.`;
  const stat = Array.isArray(data.stats) ? data.stats.find(s => s && /\bpais(es)?\b/.test(_norm(s.label||''))) : null;
  const statNumActual = stat ? String(stat.num||'') : '';
  const user = `PAÍSES PERMITIDOS (los únicos que el texto puede nombrar, son donde el cliente HOY opera): ${lista}.\n\n` +
    `Reescribí SOLO estos tres campos para que sean coherentes con esa lista, conservando el sentido, el tono y el largo (lead máx 2 oraciones):\n` +
    `- "lead" actual: ${JSON.stringify(data.lead||'')}\n` +
    `- "h1_post" actual: ${JSON.stringify(data.h1_post||'')}\n` +
    (stat ? `- stat de países actual (num): ${JSON.stringify(statNumActual)}\n` : '') +
    `\nREGLAS DURAS:\n` +
    `1) Quitá del "lead" y del "h1_post" toda mención de países que NO estén en la lista permitida (ej. si menciona un país de expansión futura que no está permitido, eliminá esa mención y dejá la frase gramaticalmente correcta).\n` +
    `2) NO agregues países nuevos. Si un país permitido ya estaba, podés mantenerlo.\n` +
    `3) NO toques ningún otro dato. NO inventes nada.\n` +
    `4) "stat_paises_num" = la cantidad EXACTA de países permitidos (${permitidos.size}). Si no había stat de países, igual devolvé "${permitidos.size}".\n` +
    `Devolvé SOLO el JSON.`;
  let parsed;
  try{
    const resp = await callClaude({ model:MODEL_GEN, system:sys, messages:[{ role:'user', content:user }], tools:[], maxTokens:1200, temperature:0 });
    parsed = parseReporteJSON(_textoJSON(resp.content));
  }catch(e){
    return { ok:false, motivo:`rewrite falló (${e.message})` };
  }
  if(!parsed || typeof parsed !== 'object') return { ok:false, motivo:'rewrite sin JSON' };
  // Aplicamos solo lo que vino y pasamos por _limpia (anti-guiones / anti-inventos), igual que el resto de prosa.
  if(typeof parsed.lead === 'string' && parsed.lead.trim())     data.lead    = _limpia(parsed.lead);
  if(typeof parsed.h1_post === 'string' && parsed.h1_post.trim()) data.h1_post = _limpia(parsed.h1_post);
  if(stat){
    const sufijo = String(stat.num||'').replace(/^\s*\d+/, '');
    // Forzamos el num al canónico permitido (la IA solo redacta prosa; el conteo lo manda el código).
    stat.num = `${permitidos.size}${sufijo}`;
  }
  return { ok:true, permitidos:[...permitidos], antes };
}

// --- GATE DE CALIDEZ (determinístico) -----------------------------------------
// El caso que MÁS RÁPIDO quema credibilidad: un reporte donde TODAS las cards son 3er grado / fuera de red
// (0 cálidas). Bloquea SOLO ese extremo. Configurable por env WARM_MIN (default 1; 0 = desactivado).
// Devuelve {warm, total, min} si NO apto, o null si pasa.
function _calidezInsuficiente(data){
  const min = parseInt(process.env.WARM_MIN || '1', 10);
  if(min <= 0) return null;                      // gate desactivado
  const cards = (data && data.cards) || [];
  if(!cards.length) return null;                 // sin cards, otros gates ya lo manejan
  const warm = cards.filter(c => /1er|2do/.test(String(c.grado||''))).length;
  return warm < min ? { warm, total: cards.length, min } : null;
}

// ¿Las cards tienen FIT BUENO? = cada card on-vertical (no cae en verticales_excluir) Y con cargo decisor
// (marcador de decisión). Es la condición que habilita mandar un reporte FRÍO (gate de calidez condicional).
function _cardsFitBueno(data, plan){
  const cards = (data && data.cards) || [];
  if(!cards.length) return false;
  const excluir = _verticalesExcluir(plan);
  return cards.every(c => {
    const cargo = _norm(c.cargo||'');
    const decisor = _MARCADOR_DECISION.test(cargo);
    const off = excluir.length && (_matchVerticalExcluir(c.empresa, excluir) || _matchVerticalExcluir(c.cargo, excluir));
    return decisor && !off;
  });
}

// GATE DE CALIDEZ CONDICIONAL AL FIT (decisión del jefe: mandar frío SI el fit es bueno). Resuelve qué hacer
// con un reporte de 0 cálidas según WARM_GATE_MODE:
//   off  -> nunca retiene por calidez.
//   hard -> retiene SIEMPRE que haya 0 cálidas (comportamiento histórico).
//   soft (default) -> NO retiene si el fit es bueno (juez APROBADO O cards on-vertical decisor): se manda con
//        flag interno frio_campana_conexion:true (IBT hace campaña de conexión; el grado NO va en el PDF).
//        Retiene SOLO frío + mal fit (caso que el juez ya rechaza igual).
// Devuelve { retener:bool, frio:bool } o null si la calidez alcanza (no es un caso frío).
function _resolverGateCalidez(data, plan, judgeResult){
  const warmMal = _calidezInsuficiente(data);
  if(!warmMal) return null;                       // hay suficientes cálidas → no es caso frío
  const mode = String(process.env.WARM_GATE_MODE || 'soft').toLowerCase();
  if(mode === 'off')  return { retener:false, frio:true, warmMal };
  if(mode === 'hard') return { retener:true,  frio:true, warmMal };
  // soft: el fit bueno habilita mandar frío
  const fitBueno = (judgeResult && judgeResult.veredicto === 'APROBADO') || _cardsFitBueno(data, plan);
  return { retener: !fitBueno, frio:true, fitBueno, warmMal };
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

async function seleccionarConRetry({ cliente, plan, pool, fixes, senales }){
  const MIN = parseInt(process.env.MIN_CARDS_OK || String(NUM_CUENTAS), 10);
  const MAX = parseInt(process.env.SELECT_MAX_TRIES || '3', 10);
  let best=null, bestN=-1;
  for(let i=1;i<=MAX;i++){
    const extra = i>1 ? [`INTENTO ${i}: el intento previo no llegó a ${MIN} cuentas completas. Devolvé ${PEDIR_SELECT} ids EXACTOS de la lista (copiá el id tal cual), todos distintos, de EMPRESAS distintas y priorizando el país del cliente, cada uno con empresa real + ángulo + hook.`] : [];
    const seleccion = await runSelectWrite({ cliente, plan, pool, fixes: (fixes||[]).concat(extra) });
    const data = armarReporte(plan, seleccion, pool, senales);
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

// =================== SEÑALES DE COMPRA POR CUENTA (opcional, detrás de SIGNALS_MODE) ===================
// Para cada card (empresa target REAL ya elegida) busca en web 2 o 3 señales de compra PÚBLICAS y CON FUENTE
// (inversión, expansión, cambio de ejecutivo, lanzamiento, alianza, hito) que justifican el "por qué ahora".
// Usa un modelo BARATO (Haiku) porque es EXTRACCIÓN, no juicio. Anti-invención DURO: si no hay señal con fuente
// real, NO la inventa (devuelve menos o ninguna). Muta data.cards[i].senales. No rompe el pipeline: error o
// timeout por card -> esa card queda sin señales. No-op si SIGNALS_MODE != 'on'.
function _promptSignals(){ return `# IBT GTM — Señales de compra (extracción CON fuente)

Te paso UNA empresa y el producto que un proveedor le quiere vender. Buscá en web 2 o 3 SEÑALES DE COMPRA recientes, públicas y VERIFICABLES de esa empresa: hechos que muestren que está en movimiento y podría comprar ahora (rondas de inversión, expansión o nuevas sucursales/países, cambios de ejecutivos relevantes, lanzamientos de producto, alianzas, resultados o hitos).

## Reglas (anti-invención, INNEGOCIABLE)
- Cada señal TIENE que salir de una fuente real que encontraste con web_search. Devolvé el nombre de la fuente (medio o sitio) y la fecha (Mes Año).
- PROHIBIDO inventar cifras, fechas, fuentes o hechos. Si no encontrás una señal con respaldo, devolvé MENOS señales o ninguna. Una señal real vale más que tres inventadas.
- La señal tiene que ser RELEVANTE para por qué esa empresa compraría el producto del proveedor, no un dato al azar.
- "texto": 1 oración corta y concreta (máx 140 caracteres), español neutro, trato de usted, SIN guiones (— ni -).
- "tipo": una palabra entre inversion, expansion, ejecutivo, producto, alianza, hito.
- No repitas la misma señal redactada distinto.

## Salida — SOLO JSON (sin texto ni markdown alrededor)
{ "senales": [ {"tipo":"...","texto":"...","fuente":"...","fecha":"Mes Año"} ] }
Máximo 3 señales. Si no hay ninguna verificable, devolvé { "senales": [] }.`; }

async function _senalesDeCuenta(card, prodCtx){
  const empresa = String(card.empresa||'').trim();
  if(!empresa) return [];
  const user = `Empresa target: ${empresa}\nUbicación: ${card.ubicacion||'-'}\nProducto del proveedor que le quiere vender: ${prodCtx || '(general)'}\n\nBuscá señales de compra recientes de "${empresa}" y devolvé el JSON.`;
  try {
    const data = await callClaude({ model: MODEL_SIGNALS, system: _promptSignals(), messages:[{ role:'user', content:user }], tools:[WEB_SEARCH_TOOL], maxTokens:1500, temperature:0 });
    const arr = (data && Array.isArray(data.senales)) ? data.senales : [];
    // GUARDA DURA anti-invención: solo señales con fuente real y texto; sin fuente -> se tira (no se muestra).
    return arr.filter(s => s && String(s.texto||'').trim() && String(s.fuente||'').trim())
              .slice(0, SIGNALS_PER_CARD)
              .map(s => ({ tipo:String(s.tipo||'').trim(), texto:String(s.texto||'').trim(), fuente:String(s.fuente||'').trim(), fecha:String(s.fecha||'').trim() }));
  } catch(e){
    console.warn(`[SIGNALS] "${empresa}" falló: ${e.message}`);
    return [];
  }
}

// Enriquece data.cards con señales de compra (en paralelo). No-op si el flag está off o si ya tienen señales.
async function enriquecerSenales(data, cliente){
  if(SIGNALS_MODE !== 'on') return;
  const cards = (data && Array.isArray(data.cards)) ? data.cards : [];
  const pend = cards.filter(c => c && !Array.isArray(c.senales));
  if(!pend.length) return;
  const prodCtx = String((data && (data.proof || data.lead)) || (cliente && cliente.empresa) || '').slice(0,400);
  console.log(`[SIGNALS] buscando señales de compra para ${pend.length} cuenta(s) con ${MODEL_SIGNALS}...`);
  await Promise.all(pend.map(async c => { c.senales = await _senalesDeCuenta(c, prodCtx); }));
}

// SEÑALES DE EMPRESA EN LAS CARDS FINALES (id-cross, datos REALES del MCP — NUNCA inventados).
// PROBLEMA QUE RESUELVE: las señales de empresa (funding/hiring/leadership/growth) hoy SOLO se marcan
// en las cuentas-ancla del sourcing (coSenales en sourceCandidates). Un lead cuya empresa NO fue ancla
// (caso robotic-crew: 0 cuentas-ancla) sale sin ninguna señal de empresa en la card. Acá, post-SELECT,
// chequeamos las señales de CADA empresa final DIRECTAMENTE y las sumamos a card.senalesVisibles.
//
// APPROACH B (id-cross), elegido sobre A (structuredContent de lookup_company): el id-cross es el MISMO
// mecanismo YA probado en prod en sourceCandidates (search companies + filtro de señal + match por id).
// El structuredContent de lookup_company está CONFIRMADO presente, pero NO hay evidencia de que traiga
// los flags de señal (en el código solo se le lee website/headcount); marcar señales desde un campo no
// confirmado violaría anti-invención (podría marcar de más o de menos). Por eso usamos el filtro real.
//
// CÓMO: por empresa final, una búsqueda `companies` con keywords=nombre + UN filtro de señal por vez.
// Si en el resultado aparece una empresa cuyo nombre matchea el de la card (_mismaEmpresa/_empKey),
// la señal es REAL para esa empresa y se marca. Sin geo/industria en el filtro: la empresa puede NO
// encajar la industria-id del ICP (es justo el caso no-ancla); el scope lo da keywords + match de nombre.
// 4 filtros × 3 empresas = 12 llamadas MCP como TOPE, todas en paralelo (gratis, post-SELECT, 3 empresas).
const COMPANY_SIGNALS = (process.env.COMPANY_SIGNALS || 'on').toLowerCase();
async function enriquecerSenalesEmpresa(data){
  if(COMPANY_SIGNALS !== 'on') return;
  const cards = (data && Array.isArray(data.cards)) ? data.cards : [];
  const objetivo = cards.filter(c => c && String(c.empresa||'').trim());
  if(!objetivo.length) return;
  const CONC = parseInt(process.env.SOURCE_CONCURRENCY || '4', 10);
  // flag -> etiqueta legible (las MISMAS que _senalesVisibles, para no duplicar texto) + filtro MCP.
  const filtros = [
    ['funding',    'Levantó financiamiento', { fundingEvents: true }],
    ['hiring',     'Está contratando',       { hasJobOffers: true }],
    ['leadership', 'Cambio de liderazgo',    { seniorLeadershipChanges: true }],
    ['growth',     'Creciendo en plantilla', { headcountGrowth:{min:8, max:1000} }]
  ];
  await _mapLimit(objetivo, CONC, async (card) => {
    const nombre = String(card.empresa||'').trim();
    if(!nombre) return;
    // 1) ID EXACTO de la empresa del lead (NO match difuso por palabra compartida): una vez que tenemos al
    // potencial lead, resolvemos SU empresa a su id de Sales Navigator y confirmamos las señales por
    // IGUALDAD DE ID. Así "Acme Logistics" (id 555) nunca se marca por culpa de "Global Logistics" (id 999)
    // que comparte el token "logistics". Si resolve no devuelve id, caemos a NOMBRE NORMALIZADO EXACTO
    // (_empKey), nunca al token-share. resolve(type:COMPANY) es un lookup vivo de LinkedIn.
    let coId = null, coName = nombre;
    try{
      const txt = String(await callMCP('resolve_sales_navigator_id', { type:'COMPANY', keywords:nombre, limit:5 }));
      const ms = [...txt.matchAll(/id="?([0-9]+)"?\s+"([^"]+)"/g)].map(m=>({ id:m[1], name:m[2] }));
      const elegido = ms.find(x => _empKey(x.name) === _empKey(nombre)) || ms[0];   // exacto > top
      if(elegido){ coId = elegido.id; coName = elegido.name; }
    }catch(e){ /* sin id: el match cae a nombre normalizado exacto abajo (no difuso) */ }
    // confirma que la empresa devuelta por una búsqueda de señal ES la del lead: por ID si lo tenemos,
    // si no por igualdad de nombre normalizado (sin el branch de token compartido de _mismaEmpresa).
    const _esLaMisma = (co) => coId ? String(co.id) === String(coId) : _empKey(co.name) === _empKey(nombre);
    const encontradas = new Set();   // flags que el MCP confirmó REALES para ESTA empresa (por id exacto)
    // las 4 búsquedas de señal de ESTA empresa en paralelo (independientes entre sí).
    await Promise.all(filtros.map(async ([flag, , extra]) => {
      try{
        const lista = _parseCompanies(await callMCP('search_sales_navigator_filtered', {
          category:'companies', profilesLimit:10, keywords:coName, ...extra
        }));
        if(lista.some(_esLaMisma)) encontradas.add(flag);
      }catch(e){ /* una señal que falla no rompe las demás ni la card; queda sin marcar */ }
    }));
    if(!encontradas.size){ console.log(`[SIGNALS] empresa final "${nombre}"${coId?` (id=${coId})`:' (sin id)'}: (ninguna señal de empresa)`); return; }
    // SUMAR a senalesVisibles SIN duplicar las que ya trae la card (recién asumió, o señales de ancla).
    const ya = new Set(Array.isArray(card.senalesVisibles) ? card.senalesVisibles : []);
    const nuevas = [];
    for(const [flag, label] of filtros){ if(encontradas.has(flag) && !ya.has(label)){ nuevas.push(label); ya.add(label); } }
    if(nuevas.length){
      card.senalesVisibles = [...(Array.isArray(card.senalesVisibles)?card.senalesVisibles:[]), ...nuevas];
    }
    console.log(`[SIGNALS] empresa final "${nombre}"${coId?` (id=${coId})`:' (sin id)'}: ${[...encontradas].join('/')}${nuevas.length?` (agrega: ${nuevas.join(', ')})`:' (ya estaban)'}`);
  });
}

async function procesar(jobId, { email, dominio, empresa, nombre, profileId, evalMode }) {
  return _statsALS.run(_nuevoStats(), async () => {
  try {
    console.log(`\n========== Job ${jobId} - Inicio (${NUM_CUENTAS} cuentas) ==========`);
    console.log(`Empresa: ${empresa} | Email: ${email} | Dominio: ${dominio} | profileId: ${profileId ?? '-'}`);

    const cliente = await resolverCliente({ profileId, dominio, empresa });
    const empresaFinal = cliente.empresa || empresa;

    const fechaHoy = _fechaHoy();
    const plan = await runPlanConRetry({ empresa: empresaFinal, dominio, email, nombre, cliente, fechaHoy });
    const { pool, senales } = await sourceConRetry(plan, cliente);
    if (!pool.length) throw new Error(`Sourcing devolvió 0 candidatos (geo=${(plan._plan&&plan._plan.geografia)||'?'}, industrias=[${((plan._plan&&plan._plan.industrias)||[]).join(', ')||'-'}]). Revisar términos de rol / industria / geografía.`);
    let data = await seleccionarConRetry({ cliente, plan, pool, senales });
    await enriquecerSenales(data, cliente);   // señales de compra por cuenta (no-op si SIGNALS_MODE off)
    await enriquecerSenalesEmpresa(data);     // señales REALES de EMPRESA en las 3 cards finales (id-cross MCP)

    let cleanHtml = limpiarHtml(renderReport(data));
    if (!cleanHtml) throw new Error('No se pudo renderizar el reporte');

    // El juez evalúa el HTML; el PDF se genera una sola vez al final y SOLO si queda apto.
    let judgeResult = await runJudge(cleanHtml, null);

    // Si el juez rechaza, reintenta re-seleccionando con los fixes. NO se renderiza PDF en
    // el medio: solo HTML + juez. Configurable con MAX_FIX_ITERS (default 1).
    const MAX_FIX = parseInt(process.env.MAX_FIX_ITERS || '1', 10);
    // CORTE TEMPRANO: si SELECT devolvió 0 cards válidas, NO arrancamos la ronda de fix.
    // Es tirar tokens/memoria (otro seleccionarConRetry = 3 SELECT + otro juez de N votos) sobre un
    // reporte vacío que igual va a fallar la guarda de integridad. Cerramos en error abajo.
    if (_cuentaCompletas(data) === 0) {
      console.warn(`[Job ${jobId}] SELECT entregó 0 cards válidas — salto la ronda de fix (sería gasto sobre reporte vacío).`);
    }
    for (let intento = 1; intento <= MAX_FIX && _cuentaCompletas(data) > 0 && judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0; intento++) {
      console.log(`[Job ${jobId}] Juez rechazó ${judgeResult.score}/8 — fix ${intento}/${MAX_FIX}...`);
      try {
        const fixedData = await seleccionarConRetry({ cliente, plan, pool, fixes: judgeResult.fixes, senales });
        if (_cuentaCompletas(fixedData) < _cuentaCompletas(data)) {
          console.warn(`[FIX] el fix dio menos cards completas — conservo el previo y corto.`);
          break;
        }
        data = fixedData;
        await enriquecerSenales(data, cliente);   // re-busca señales para las cuentas nuevas del fix
        await enriquecerSenalesEmpresa(data);     // re-chequea señales de EMPRESA para las cuentas del fix
        cleanHtml = limpiarHtml(renderReport(data));
        console.log(`[Job ${jobId}] Re-validando con el juez (re-render incluye normalización de países)...`);
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
    // PAÍSES: normaliza (conservador) el num del stat de países a la cantidad realmente nombrada. Si el lead nombra
    // un país FUERA del set canónico (h1_post), NO rechazamos: ARREGLAMOS la página 1 (rewrite
    // targeted barato, sin web_search, sin re-sourcing) para que la prosa quede coherente con los países permitidos,
    // y mandamos con las cards buenas. Solo rechazamos (fail-closed) si el arreglo no logra dejarla coherente.
    let paisesMal = _paisesIncoherente(data);
    let paisesReescrito = false;
    if (paisesMal && paisesMal.rechazar && paisesMal.leadExtra && paisesMal.leadExtra.length) {
      console.warn(`[PAISES] Lead nombra países fuera del ICP (${paisesMal.leadExtra.join(', ')}) → arreglo página 1 (sin re-sourcing, sin tocar cards).`);
      const fix = await _reescribirPaisesPagina1(data, plan);
      if (fix.ok) {
        paisesReescrito = true;
        console.warn(`[PAISES] Página 1 reescrita a países permitidos [${fix.permitidos.join(', ')}]. lead: ${JSON.stringify(fix.antes.lead)} → ${JSON.stringify(data.lead)}.`);
        paisesMal = _paisesIncoherente(data); // re-validar tras el arreglo
      } else {
        console.warn(`[PAISES] Arreglo no aplicó (${fix.motivo}); se mantiene la incoherencia para rechazo fail-closed.`);
      }
    }
    if (paisesMal && paisesMal.ajustado) {
      console.warn(`[PAISES] Conteo incoherente normalizado: stat ${paisesMal.antes} → ${paisesMal.despues} (países nombrados: ${paisesMal.paises.join(', ')}).`);
      cleanHtml = limpiarHtml(renderReport(data));
    } else if (paisesMal && paisesMal.rechazar) {
      const fixPaises = (paisesMal.leadExtra && paisesMal.leadExtra.length)
        ? `CONTEO DE PAÍSES INCOHERENTE: el lead nombra países (${paisesMal.leadExtra.join(', ')}) que NO están en el título (h1_post). Unificá: el lead, el h1_post y el número del stat tienen que nombrar/contar EXACTAMENTE los MISMOS países (reducí, nunca agregues países que el cliente no opera).`
        : `CONTEO DE PAÍSES INCOHERENTE: el stat dice ${paisesMal.declarado} países pero el título (h1_post) no nombra ninguno reconocible. Hacé que el número del stat y los países de h1_post sean EXACTAMENTE los mismos.`;
      console.warn(`[PAISES] No se pudo normalizar (stat=${paisesMal.declarado}, canónico=${paisesMal.real}${paisesMal.leadExtra&&paisesMal.leadExtra.length?`, lead-extra=${paisesMal.leadExtra.join('/')}`:''}) → RECHAZADO.`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
        fixes: [fixPaises].concat(judgeResult.fixes||[]) };
    } else if (paisesReescrito) {
      // Tras un arreglo exitoso de página 1 hay que re-renderizar para que el PDF refleje lead/h1_post/stat corregidos.
      cleanHtml = limpiarHtml(renderReport(data));
    }
    // CALIDEZ (condicional al fit): un reporte 100% frío NO se retiene si el fit es bueno (se manda con flag
    // frio_campana_conexion para que IBT haga campaña de conexión). Solo retiene frío + mal fit. WARM_GATE_MODE.
    let frioCampanaConexion = false;
    const gateCal = _resolverGateCalidez(data, plan, judgeResult);
    if (gateCal) {
      const w = gateCal.warmMal;
      if (gateCal.retener) {
        console.warn(`[WARM] Calidez insuficiente + fit no bueno: ${w.warm}/${w.total} cards cálidas (mínimo ${w.min}) → RECHAZADO.`);
        judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
          fixes: [`CALIDEZ INSUFICIENTE: las ${w.total} cuentas son 3er grado / fuera de red (0 cálidas) y el fit no es claramente bueno. Priorizá decisores en 1er/2do grado (red cercana) o subí el fit (on-vertical, decisor) aunque haya que repetir vertical.`].concat(judgeResult.fixes||[]) };
      } else {
        frioCampanaConexion = true;
        console.warn(`[WARM] Reporte FRÍO con buen fit (${w.warm}/${w.total} cálidas) → se MANDA con frio_campana_conexion:true (campaña de conexión; el grado NO va en el PDF).`);
      }
    }
    const aptoEnvio = cardsValidas >= MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO';
    const descartadas = [];
    console.log(aptoEnvio
      ? `[INTEGRIDAD] OK: ${cardsValidas} cards completas + juez APROBADO.${frioCampanaConexion?' (frío, campaña de conexión)':''}`
      : `[INTEGRIDAD] ⚠️ NO apto: ${cardsValidas}/${MIN_CARDS_OK} completas, juez ${judgeResult.veredicto}.`);

    // ALWAYS_SEND (default true, decisión del negocio): se genera el PDF SIEMPRE, apto o no,
    // así n8n siempre tiene qué mandar. PERO con PISO de viabilidad: ALWAYS_SEND manda los reportes
    // "flojos pero viables" (frío, fit dudoso, juez por personalización, países normalizables), NO los
    // EGREGIAMENTE rotos. Piso: cards en país equivocado (geo) o menos de MIN_VIABLE cards completas
    // (env nuevo, default 2: 0-1 cards no es un reporte). Si el reporte cae bajo el piso, NO se genera PDF
    // (pdf_base64 null, como el fail-closed) aunque ALWAYS_SEND esté activo.
    const _alwaysSend = String(process.env.ALWAYS_SEND ?? 'true').toLowerCase() !== 'false';
    const MIN_VIABLE = parseInt(process.env.MIN_VIABLE || '2', 10);
    const _pisoRoto = !!geoMal ? 'geo' : (cardsValidas < MIN_VIABLE ? 'integridad' : null);
    let pdfBuffer = null, pageCount = null;
    if (aptoEnvio || (_alwaysSend && !_pisoRoto)) {
      pdfBuffer = await renderizarPdf(cleanHtml);
      pageCount = await contarPaginas(pdfBuffer);
    } else if (_alwaysSend && _pisoRoto) {
      console.warn(`[ALWAYS_SEND] retenido por piso (${_pisoRoto})`);
    }

    logTokenCost(`Job ${jobId}`);

    jobs.set(jobId, {
      status: 'ok',
      pdf_base64: pdfBuffer ? pdfBuffer.toString('base64') : null,
      reporte: evalMode ? data : undefined, // solo en modo eval: objeto estructurado para inspección (async, sin tocar prod)
      empresa: empresaFinal,
      anclado: cliente.anclado,
      cliente_resuelto: cliente,
      apto_envio: aptoEnvio,
      frio_campana_conexion: frioCampanaConexion,   // reporte frío pero on-fit: IBT corre campaña de conexión
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
    const motivoRechazo = _motivoRechazo({
      aptoEnvio,
      integridadMal: cardsValidas < MIN_CARDS_OK,
      geoMal: !!geoMal,
      paisesMal: !!(paisesMal && paisesMal.rechazar),
      tamMal: !!tamMal,
      calidezMal: !!(gateCal && gateCal.retener),
      juezRechazo: judgeResult.veredicto === 'RECHAZADO'
    });
    _registrarResultado(_recResultado({ jobId, input: { email, dominio, empresa, profileId }, cliente, plan, data, judgeResult, aptoEnvio, pageCount, motivo_rechazo: motivoRechazo }));
    console.log(`========== Job ${jobId} - ${aptoEnvio ? `OK ${pageCount} páginas` : 'NO apto (sin PDF)'}, juez FINAL ${judgeResult.veredicto} ${judgeResult.score}/8 (motivo: ${motivoRechazo}) ==========\n`);
  } catch (err) {
    console.error(`[Job ${jobId}] Error:`, err);
    jobs.set(jobId, { status: 'error', error: err.message, finishedAt: Date.now() });
    _registrarResultado(_recResultado({ jobId, input: { email, dominio, empresa, profileId }, error: err.message }));
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
  // GATE DE LA LANDING (uso privado): si LANDING_KEY está seteada (solo en el servicio de la landing,
  // NO en el de producción que usa n8n), exigimos la clave en el header. Si no está seteada, no gatea
  // (producción/n8n sigue igual). Así la misma /generar sirve para n8n (sin gate) y para la landing (con gate).
  if (process.env.LANDING_KEY && req.header('x-landing-key') !== process.env.LANDING_KEY) {
    return res.status(401).json({ error: 'Clave invalida' });
  }
  const { email, dominio, empresa, nombre, profileId, eval: evalMode, debug } = req.body || {};
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

  // CINTURÓN GLOBAL: cualquier await sin timeout (presente o futuro) podía dejar el job en "processing"
  // para siempre; el TTL del Map limpia el registro a 1h pero NO mata el promise de fondo, e infla
  // jobs_activos. Promise.race contra JOB_TIMEOUT_MS (default 8 min) garantiza que el job SIEMPRE cierra.
  // No rompe el flujo normal: los jobs que terminan antes resuelven primero y este timeout queda inerte.
  // procesar() maneja sus propios errores internamente (status:'error'); este race solo cubre el cuelgue total.
  const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '480000', 10);
  let jobTimer;
  const timeoutGlobal = new Promise((resolve) => {
    jobTimer = setTimeout(() => {
      console.error(`[Job ${jobId}] TIMEOUT GLOBAL (>${JOB_TIMEOUT_MS}ms). Se marca error; el promise de fondo puede seguir, pero el job ya no queda zombie.`);
      jobs.set(jobId, { status: 'error', error: 'timeout global del job (>8min)', finishedAt: Date.now() });
      resolve();
    }, JOB_TIMEOUT_MS);
  });

  Promise.race([
    procesar(jobId, { email, dominio, empresa: empresa || dominio, nombre: nombre || '', profileId, evalMode: evalMode || debug }),
    timeoutGlobal
  ])
  // CATCH DEFENSIVO: procesar() maneja sus errores internamente (try/catch -> status:'error'),
  // pero si alguna vez rechaza (o rechaza el rewrite de países / seleccionarConRetry sin atrapar),
  // sin este .catch sería un unhandledRejection. Marcamos el job en error y NO re-lanzamos.
  .catch((err) => {
    console.error(`[Job ${jobId}] Rechazo no atrapado en el path async (lo absorbo, no tumbo el server):`, err?.stack || err);
    const prev = jobs.get(jobId);
    if (!prev || prev.status === 'processing') {
      jobs.set(jobId, { status: 'error', error: err?.message || String(err), finishedAt: Date.now() });
    }
  })
  .finally(() => {
    clearTimeout(jobTimer);
    if (key && enProgreso.get(key) === jobId) enProgreso.delete(key);
  });
});

app.get('/resultado/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
  res.json(job);
});

// Descarga del PDF por jobId (para la landing). Sin gate: el jobId es un UUID no adivinable y expira a 1h.
// Sirve el pdf_base64 que ya guardó el job como un PDF nativo descargable (Content-Disposition).
app.get('/pdf/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
  if (job.status === 'processing') return res.status(409).json({ error: 'el reporte todavia se esta generando' });
  if (!job.pdf_base64) return res.status(422).json({ error: 'el reporte no generó PDF (no apto o sin cuentas)' });
  const buf = Buffer.from(job.pdf_base64, 'base64');
  const nombre = String(job.pdf_filename || 'Analisis de Mercado.pdf').replace(/[\\/:*?"<>|]/g, '');
  // Los headers HTTP viajan en Latin-1, así que un filename con acentos ("Análisis") se corrompe
  // ("Anýlisis"). RFC 5987: filename* en UTF-8 percent-encoded para navegadores modernos + un filename
  // ASCII (sin acentos) de fallback para clientes viejos.
  const nombreAscii = nombre.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreAscii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`);
  res.send(buf);
});

app.post('/generar-reporte', async (req, res) => {
  const { email, dominio, empresa, nombre, profileId, eval: evalMode, debug } = req.body || {};
  if (!email || !dominio) return res.status(400).json({ error: 'email y dominio son obligatorios' });

  await _statsALS.run(_nuevoStats(), async () => {
  try {
    const cliente = await resolverCliente({ profileId, dominio, empresa: empresa || dominio });
    const empresaFinal = cliente.empresa || empresa || dominio;
    const fechaHoy = _fechaHoy();
    const plan = await runPlanConRetry({ empresa: empresaFinal, dominio, email, nombre: nombre || '', cliente, fechaHoy });
    const { pool, senales } = await sourceConRetry(plan, cliente);
    if (!pool.length) return res.status(422).json({ error: `Sourcing devolvió 0 candidatos (geo=${(plan._plan&&plan._plan.geografia)||'?'}, industrias=[${((plan._plan&&plan._plan.industrias)||[]).join(', ')||'-'}]). Revisar términos de rol / industria / geografía.` });
    let data = await seleccionarConRetry({ cliente, plan, pool, senales });
    await enriquecerSenales(data, cliente);   // señales de compra por cuenta (no-op si SIGNALS_MODE off)
    await enriquecerSenalesEmpresa(data);     // señales REALES de EMPRESA en las 3 cards finales (id-cross MCP)

    let cleanHtml = limpiarHtml(renderReport(data));
    if (!cleanHtml) return res.status(500).json({ error: 'No se pudo renderizar el reporte' });

    // El juez evalúa el HTML; el PDF se genera abajo y solo si quedó apto.
    let judgeResult = await runJudge(cleanHtml, null);

    // Si el juez rechaza, reintenta re-seleccionando con los fixes (sin renderizar PDF en el medio).
    const MAX_FIX = parseInt(process.env.MAX_FIX_ITERS || '1', 10);
    // CORTE TEMPRANO: 0 cards válidas -> no arrancamos la ronda de fix (gasto sobre reporte vacío).
    if (_cuentaCompletas(data) === 0) {
      console.warn(`[generar-reporte] SELECT entregó 0 cards válidas — salto la ronda de fix.`);
    }
    for (let intento = 1; intento <= MAX_FIX && _cuentaCompletas(data) > 0 && judgeResult.veredicto === 'RECHAZADO' && judgeResult.fixes.length > 0; intento++) {
      try {
        const fixedData = await seleccionarConRetry({ cliente, plan, pool, fixes: judgeResult.fixes, senales });
        if (_cuentaCompletas(fixedData) < _cuentaCompletas(data)) {
          console.warn(`[FIX] el fix dio menos cards completas — conservo el previo y corto.`);
          break;
        }
        data = fixedData;
        await enriquecerSenales(data, cliente);   // re-busca señales para las cuentas nuevas del fix
        await enriquecerSenalesEmpresa(data);     // re-chequea señales de EMPRESA para las cuentas del fix
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
    // PAÍSES: normaliza (conservador) el num del stat de países a la cantidad realmente nombrada. Si el lead nombra
    // un país FUERA del set canónico (h1_post), NO rechazamos: ARREGLAMOS la página 1 (rewrite
    // targeted barato, sin web_search, sin re-sourcing) para que la prosa quede coherente con los países permitidos,
    // y mandamos con las cards buenas. Solo rechazamos (fail-closed) si el arreglo no logra dejarla coherente.
    let paisesMal = _paisesIncoherente(data);
    let paisesReescrito = false;
    if (paisesMal && paisesMal.rechazar && paisesMal.leadExtra && paisesMal.leadExtra.length) {
      console.warn(`[PAISES] Lead nombra países fuera del ICP (${paisesMal.leadExtra.join(', ')}) → arreglo página 1 (sin re-sourcing, sin tocar cards).`);
      const fix = await _reescribirPaisesPagina1(data, plan);
      if (fix.ok) {
        paisesReescrito = true;
        console.warn(`[PAISES] Página 1 reescrita a países permitidos [${fix.permitidos.join(', ')}]. lead: ${JSON.stringify(fix.antes.lead)} → ${JSON.stringify(data.lead)}.`);
        paisesMal = _paisesIncoherente(data); // re-validar tras el arreglo
      } else {
        console.warn(`[PAISES] Arreglo no aplicó (${fix.motivo}); se mantiene la incoherencia para rechazo fail-closed.`);
      }
    }
    if (paisesMal && paisesMal.ajustado) {
      console.warn(`[PAISES] Conteo incoherente normalizado: stat ${paisesMal.antes} → ${paisesMal.despues} (países nombrados: ${paisesMal.paises.join(', ')}).`);
      cleanHtml = limpiarHtml(renderReport(data));
    } else if (paisesMal && paisesMal.rechazar) {
      const fixPaises = (paisesMal.leadExtra && paisesMal.leadExtra.length)
        ? `CONTEO DE PAÍSES INCOHERENTE: el lead nombra países (${paisesMal.leadExtra.join(', ')}) que NO están en el título (h1_post). Unificá: el lead, el h1_post y el número del stat tienen que nombrar/contar EXACTAMENTE los MISMOS países (reducí, nunca agregues países que el cliente no opera).`
        : `CONTEO DE PAÍSES INCOHERENTE: el stat dice ${paisesMal.declarado} países pero el título (h1_post) no nombra ninguno reconocible. Hacé que el número del stat y los países de h1_post sean EXACTAMENTE los mismos.`;
      console.warn(`[PAISES] No se pudo normalizar (stat=${paisesMal.declarado}, canónico=${paisesMal.real}${paisesMal.leadExtra&&paisesMal.leadExtra.length?`, lead-extra=${paisesMal.leadExtra.join('/')}`:''}) → RECHAZADO.`);
      judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
        fixes: [fixPaises].concat(judgeResult.fixes||[]) };
    } else if (paisesReescrito) {
      // Tras un arreglo exitoso de página 1 hay que re-renderizar para que el PDF refleje lead/h1_post/stat corregidos.
      cleanHtml = limpiarHtml(renderReport(data));
    }
    // CALIDEZ (condicional al fit): un reporte 100% frío NO se retiene si el fit es bueno (se manda con flag
    // frio_campana_conexion para que IBT haga campaña de conexión). Solo retiene frío + mal fit. WARM_GATE_MODE.
    let frioCampanaConexion = false;
    const gateCal = _resolverGateCalidez(data, plan, judgeResult);
    if (gateCal) {
      const w = gateCal.warmMal;
      if (gateCal.retener) {
        console.warn(`[WARM] Calidez insuficiente + fit no bueno: ${w.warm}/${w.total} cards cálidas (mínimo ${w.min}) → RECHAZADO.`);
        judgeResult = { veredicto:'RECHAZADO', score: Math.min(judgeResult.score, 4),
          fixes: [`CALIDEZ INSUFICIENTE: las ${w.total} cuentas son 3er grado / fuera de red (0 cálidas) y el fit no es claramente bueno. Priorizá decisores en 1er/2do grado (red cercana) o subí el fit (on-vertical, decisor) aunque haya que repetir vertical.`].concat(judgeResult.fixes||[]) };
      } else {
        frioCampanaConexion = true;
        console.warn(`[WARM] Reporte FRÍO con buen fit (${w.warm}/${w.total} cálidas) → se MANDA con frio_campana_conexion:true (campaña de conexión; el grado NO va en el PDF).`);
      }
    }
    const aptoEnvio = cardsValidas >= MIN_CARDS_OK && judgeResult.veredicto === 'APROBADO';
    const descartadas = [];
    console.log(aptoEnvio
      ? `[INTEGRIDAD] OK: ${cardsValidas} cards completas + juez APROBADO.${frioCampanaConexion?' (frío, campaña de conexión)':''}`
      : `[INTEGRIDAD] ⚠️ NO apto: ${cardsValidas}/${MIN_CARDS_OK} completas, juez ${judgeResult.veredicto}.`);

    // ALWAYS_SEND (default true): genera el PDF siempre (apto o no), así n8n siempre manda. PERO con PISO de
    // viabilidad: manda los "flojos pero viables", NO los EGREGIAMENTE rotos. Piso: cards en país equivocado (geo)
    // o menos de MIN_VIABLE cards completas (env nuevo, default 2). Bajo el piso → NO se genera PDF (pdf_base64 null).
    const _alwaysSend = String(process.env.ALWAYS_SEND ?? 'true').toLowerCase() !== 'false';
    const MIN_VIABLE = parseInt(process.env.MIN_VIABLE || '2', 10);
    const _pisoRoto = !!geoMal ? 'geo' : (cardsValidas < MIN_VIABLE ? 'integridad' : null);
    let pdfBuffer = null, pageCount = null;
    if (aptoEnvio || (_alwaysSend && !_pisoRoto)) {
      pdfBuffer = await renderizarPdf(cleanHtml);
      pageCount = await contarPaginas(pdfBuffer);
    } else if (_alwaysSend && _pisoRoto) {
      console.warn(`[ALWAYS_SEND] retenido por piso (${_pisoRoto})`);
    }

    logTokenCost('generar-reporte');
    const motivoRechazo = _motivoRechazo({
      aptoEnvio,
      integridadMal: cardsValidas < MIN_CARDS_OK,
      geoMal: !!geoMal,
      paisesMal: !!(paisesMal && paisesMal.rechazar),
      tamMal: !!tamMal,
      calidezMal: !!(gateCal && gateCal.retener),
      juezRechazo: judgeResult.veredicto === 'RECHAZADO'
    });
    _registrarResultado(_recResultado({ input: { email, dominio, empresa, profileId }, cliente, plan, data, judgeResult, aptoEnvio, pageCount, motivo_rechazo: motivoRechazo }));

    return res.json({
      status: 'ok',
      pdf_base64: pdfBuffer ? pdfBuffer.toString('base64') : null,
      reporte: (evalMode || debug) ? data : undefined, // solo en modo eval: objeto estructurado para inspección
      empresa: empresaFinal,
      anclado: cliente.anclado,
      cliente_resuelto: cliente,
      apto_envio: aptoEnvio,
      frio_campana_conexion: frioCampanaConexion,   // reporte frío pero on-fit: IBT corre campaña de conexión
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
    _registrarResultado(_recResultado({ input: { email, dominio, empresa, profileId }, error: err.message }));
    return res.status(500).json({ error: err.message });
  }
  });
});

app.get('/health', (req, res) => {
  // jobs_activos = jobs corriendo AHORA (termómetro de zombies); jobs_en_cache = total en el Map
  // (incluye terminados ok/error hasta el barrido de 1h). jobs.size mezclaba ambos y confundía.
  let activos = 0; for (const j of jobs.values()) if (j.status === 'processing') activos++;
  res.json({ ok: true, jobs_activos: activos, jobs_en_cache: jobs.size, cuentas: NUM_CUENTAS, signals_mode: SIGNALS_MODE });
});

// Descarga del log de resultados (JSONL). ?tail=N devuelve solo las últimas N líneas.
// Cada línea es un job estructurado, listo para analizar con IA.
app.get('/resultados-log', (req, res) => {
  try {
    if (!fs.existsSync(RESULT_LOG)) return res.status(404).json({ error: 'sin resultados todavía', path: RESULT_LOG });
    let txt = fs.readFileSync(RESULT_LOG, 'utf8');
    const tail = parseInt(req.query.tail || '0', 10);
    if (tail > 0) txt = txt.trim().split('\n').slice(-tail).join('\n') + '\n';
    res.type('text/plain').send(txt);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT} (NUM_CUENTAS=${NUM_CUENTAS}, EXPECTED_PAGES=${EXPECTED_PAGES||'no validar'})`));
}

module.exports = {
  validarPlan, sourceCandidates, armarReporte, verificarLinksData,
  parseReporteJSON, _rankFit, _rankSenioridad, _parseProfile, _sizeBoost,
  _norm, _empresaDeHeadline, _empKey, _slugCos, _degOrdinal, _headlineLimpio, _fechaHoy,
  _esICsuelto, _icpPideDecisores, _matchFuncion, _warmth, _geoAliasSet,
  _geoIncoherente, _paisesIncoherente, _reescribirPaisesPagina1, _calidezInsuficiente, _paisesDeTexto,
  _rolRelevante, _rolRelevanteLaxo, _verticalesExcluir, _matchVerticalExcluir, _candBueno, _candViable,
  _cardsFitBueno, _resolverGateCalidez, sourceConRetry, runPlanConRetry,
  _saneaCargo, _dedupUbicacion
};