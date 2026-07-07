// pipeline.js — Pipeline productizado del "Diagnóstico ROI Personalizado" de Delta Teams.
//
// Mismo playbook que el GTM de IBT (server.js): research REAL → cálculo determinístico →
// copy de IA con guardas → juez fail-closed. server.js inyecta las dependencias compartidas
// vía crearDeltaRouter(deps) y monta el router en /delta; este módulo NO toca el pipeline GTM.
//
// Fases:
//   1. CLIENTE    resolverCliente (compartido): ancla empresa/dominio/headcount vía MCP.
//   2. LIDERAZGO  Sales Nav company-first: cuenta líderes REALES (fallback: tabla del skill).
//   3. RESEARCH   Claude + web_search: industria, país, referente con fuentes, supuestos del cálculo.
//   4. CALC       calculo.js (puro código): los 18 montos USD. La IA nunca escribe dinero.
//   5. CONTENT    Claude sin tools: el copy, con presupuestos de caracteres estrictos.
//   6. GUARDAS    determinísticas (TEPI, largos, bars=100, CTA Camila, $ solo calculados...).
//   7. RENDER     template-delta.html + Puppeteer → PDF de 4 páginas EXACTAS.
//   8. JUEZ       8 criterios, APROBADO solo 8/8, fail-closed, 1 ronda de fix.
//
// Los checkpoints A/B del skill original (aprobación humana del comercial) NO existen acá:
// los reemplazan las guardas + el juez, igual que en GTM.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const {
  numerosParaTemplate, clampCostoHora, clampHorasPerdidas, liderazgoEstimado, _rangoCostoHora,
} = require('./calculo.js');
const { renderDelta } = require('./render-delta.js');

// ── Config (envs con default, prefijo DELTA_ para no chocar con el GTM) ─────
const DELTA_EXPECTED_PAGES    = parseInt(process.env.DELTA_EXPECTED_PAGES || '4', 10);
const DELTA_RESEARCH_TRIES    = parseInt(process.env.DELTA_RESEARCH_TRIES || '2', 10);
const DELTA_CONTENT_TRIES     = parseInt(process.env.DELTA_CONTENT_TRIES || '3', 10);
const DELTA_MAX_FIX_ITERS     = parseInt(process.env.DELTA_MAX_FIX_ITERS || '1', 10);
const DELTA_JOB_TIMEOUT_MS    = parseInt(process.env.DELTA_JOB_TIMEOUT_MS || '720000', 10);
const DELTA_LIDER_LIMIT       = parseInt(process.env.DELTA_LIDER_LIMIT || '50', 10);
// Fail-closed por default (producto nuevo, prompts sin curtir): solo se adjunta PDF si el juez aprueba.
// Cuando el escape-rate medido dé confianza, flipear a true para el comportamiento ALWAYS_SEND del GTM.
const DELTA_ALWAYS_SEND       = String(process.env.DELTA_ALWAYS_SEND || 'false').toLowerCase() === 'true';

// GOOGLE SHEET (opcional): MISMO webhook que el GTM (SHEET_WEBHOOK_URL → apps-script-sheet.gs),
// pero cada fila viaja con hoja:"Delta" para caer en la pestaña de Delta del Sheet de gastos.
// Fire-and-forget: jamás bloquea ni rompe el job. A diferencia del GTM, los jobs de TEST también
// se registran (estado:"test"): sirve para verificar el cableado de la pestaña a costo cero.
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || '';
const DELTA_SHEET_TAB   = process.env.DELTA_SHEET_TAB || 'Delta';

// ── Identidad de marca (del skill; el CTA/footer viven FIJOS en el template) ─
const CIFRAS_DELTA_WHITELIST = ['61.4%', '81.7%', '-30%', '+20-40%', '90 días'];

// ── Presupuestos de longitud (chars máx por campo; ver Delta/SCHEMA.md) ─────
// Calibrados con la holgura REAL de cada página (las 4 tenían aire de sobra en el preview);
// el guardián definitivo del desborde es el PDF de 4 páginas exactas, no estos números.
// Producción mostró que la IA no sabe contar chars: los límites son la meta, y el recorte
// determinístico (_recorteDeterminista) garantiza que SIEMPRE se cumplen.
const LIMITES = {
  HEADLINE: 110, SUBHEADLINE: 240, DIAGNOSIS_HEADING: 60, DIAGNOSIS_BODY: 560, BENCHMARK_NOTA: 190,
  INEFF_TITLE: 55, INEFF_DESC: 240, TIMEBARS_HEADING: 75, BAR_LABEL: 45,
  REF_NARRATIVA: 520, GAP_DIM: 30, GAP_PROSPECT: 40, GAP_REF: 45, GAP_CLOSING_BODY: 480,
  PLAN_INTRO: 260, OKR_OBJETIVO: 80, OKR_KR: 80, OKR_CELDA: 20,
  BENEFIT_TITLE: 55, BENEFIT_DESC: 170, PROJ_NOTA: 340, QUOTE: 280, CTA_HEADING: 90, CTA_BODY: 220,
};

// Framing TEPI: metodología interna PROHIBIDA en copy externo. OJO: "DOS", "Rocks" y "EOS"
// solo en mayúsculas/capitalizado (en español "dos" y "eos" minúsculas son palabras normales).
const _RE_TEPI = [
  { re: /\bDOS\b/,             label: 'DOS' },
  { re: /\bRocks\b/,           label: 'Rocks' },
  { re: /\bL10\b/i,            label: 'L10' },
  { re: /\bEOS\b/,             label: 'EOS' },
  { re: /people\s+analyzer/i,  label: 'People Analyzer' },
  { re: /\btraction\b/i,       label: 'Traction' },
];

const _RE_LIDER = /\b(ceo|coo|cfo|cto|cmo|chro|cio|chief|founder|co[- ]?founder|fundador(?:a)?|cofundador(?:a)?|director(?:a)?|gerente|general manager|country manager|head of|vp|vice ?president(?:e)?|presidente|presidenta|managing partner|partner|socio|socia|owner|due[nñ][oa])\b/i;

module.exports = function crearDeltaRouter(deps) {
  const {
    callClaude, callMCP, resolverCliente, renderizarPdf, contarPaginas,
    statsALS, nuevoStats, setStage, logTokenCost,
    sinGuiones, extraerJSON, parsePeople,
    MODEL_GEN, MODEL_JUDGE, WEB_SEARCH_TOOL,
  } = deps;

  const MODEL_DELTA_GEN   = process.env.DELTA_MODEL_GEN || MODEL_GEN;
  const MODEL_DELTA_JUDGE = process.env.DELTA_MODEL_JUDGE || MODEL_JUDGE;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const _MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  function _fechaEs() { const d = new Date(); return `${_MESES[d.getMonth()]} ${d.getFullYear()}`; }

  function _empKeyDelta(n) {
    return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\b(s\.?a\.?s?|s\.?r\.?l|inc|llc|ltda?|corp|group|grupo|company|co)\b\.?/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function _nombrePila(nombre) {
    const t = String(nombre || '').trim().split(/\s+/)[0] || '';
    return t.length >= 3 ? t : '';
  }
  function _nombreArchivo(empresa) {
    return `Diagnóstico ROI - ${String(empresa || 'Empresa')}.pdf`.replace(/[\\/:*?"<>|]/g, '');
  }
  function _textoDe(resp) {
    return (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  function _parseJSON(raw, fase) {
    const t = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const block = extraerJSON(t);
    if (!block) throw new Error(`${fase}: la IA no devolvió JSON`);
    try { return JSON.parse(block); } catch (e) { throw new Error(`${fase}: JSON inválido (${e.message})`); }
  }
  // Saneo profundo: sin em dashes (guarda compartida del GTM), espacios colapsados.
  function _sanearDeep(o) {
    if (typeof o === 'string') return sinGuiones(o).replace(/\s+/g, ' ').trim();
    if (Array.isArray(o)) return o.map(_sanearDeep);
    if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) r[k] = _sanearDeep(o[k]); return r; }
    return o;
  }
  function _stats() { return statsALS.getStore(); }

  // Una fila por análisis al Google Sheet (pestaña Delta), vía el mismo Apps Script del GTM.
  function _registrarEnSheet(fila) {
    if (!SHEET_WEBHOOK_URL) return;
    try {
      const ctrl = new AbortController();
      const _t = setTimeout(() => ctrl.abort(), 10000);
      fetch(SHEET_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hoja: DELTA_SHEET_TAB, fecha: new Date().toISOString(), ...fila }),
        signal: ctrl.signal,
      }).catch(e => console.warn('[DELTA:SHEET] no pude registrar en el Google Sheet:', e.message))
        .finally(() => clearTimeout(_t));
    } catch (e) { console.warn('[DELTA:SHEET] error:', e.message); }
  }
  function _costoUSD() {
    try { return deps.costoTotal ? Number(deps.costoTotal(_stats()).toFixed(4)) : ''; }
    catch (e) { return ''; }
  }

  // ── FASE 2: LIDERAZGO (Sales Nav company-first, experiencia del sourcing GTM) ─
  async function buscarLiderazgo(cliente) {
    const nombreEmp = cliente && cliente.empresa;
    if (!nombreEmp) return { lideres: [], fuente: 'sin_empresa' };
    try {
      const txt = String(await callMCP('resolve_sales_navigator_id', { type: 'COMPANY', keywords: nombreEmp, limit: 5 }));
      const cands = [...txt.matchAll(/id="?([0-9]+)"?\s+"([^"]+)"/g)].map(m => ({ id: m[1], name: m[2] }));
      // ANTI-EMPRESA-EQUIVOCADA (memoria: el resolve por nombre trae la equivocada): exigimos match de
      // nombre; sin match NO contamos líderes ajenos, caemos a la tabla estimada (y se declara estimado).
      const kEmp = _empKeyDelta(nombreEmp);
      const hit = cands.find(c => _empKeyDelta(c.name) === kEmp)
        || cands.find(c => { const k = _empKeyDelta(c.name); return k && kEmp && (k.includes(kEmp) || kEmp.includes(k)); });
      if (!hit) {
        console.warn(`[DELTA:LID] resolve no matcheó "${nombreEmp}" (candidatos: ${cands.map(c => c.name).join(', ') || '-'}) → liderazgo por tabla.`);
        return { lideres: [], fuente: 'sin_match' };
      }
      const gente = parsePeople(String(await callMCP('search_sales_navigator_filtered', {
        category: 'people', profilesLimit: DELTA_LIDER_LIMIT, company: { include: [hit.id] },
      })));
      const vistos = new Set(); const lideres = [];
      for (const p of gente) {
        if (p.id && !vistos.has(p.id) && _RE_LIDER.test(p.head || '')) {
          vistos.add(p.id);
          lideres.push({ name: p.name, role: p.head, confirmed: true });
        }
      }
      console.log(`[DELTA:LID] "${hit.name}" (id ${hit.id}): ${lideres.length} líderes confirmados de ${gente.length} perfiles.`);
      return { lideres, companyId: hit.id, companyName: hit.name, fuente: 'sales_nav' };
    } catch (e) {
      console.warn('[DELTA:LID] búsqueda de liderazgo falló (sigo con tabla):', e.message);
      return { lideres: [], fuente: 'error' };
    }
  }

  // Regla determinística: con 3+ líderes confirmados manda el conteo REAL (cap 15, techo de la tabla);
  // con menos, la tabla del skill sobre el headcount total. La fuente viaja al copy (honestidad).
  function resolverLiderazgo(lid, headcountTotal) {
    const n = (lid.lideres || []).length;
    if (n >= 3) return { cantidad: Math.min(n, 15), confirmados: n, fuente: 'sales_nav' };
    return { cantidad: liderazgoEstimado(headcountTotal), confirmados: n, fuente: n > 0 ? 'mixto' : 'tabla' };
  }

  // ── FASE 3: RESEARCH (Claude + web_search) ─────────────────────────────────
  function _promptResearch() {
    return `# DELTA TEAMS — Diagnóstico ROI · Fase RESEARCH (investigación con fuentes)

Sos un analista comercial de Delta Teams (categoría TEPI: Team Execution & Performance Infrastructure, infraestructura de ejecución para equipos en crecimiento en LATAM). Tu única tarea: investigar a la empresa prospecto con web_search y devolver un JSON de datos VERIFICADOS para un diagnóstico de ROI. NO escribís el diagnóstico; solo juntás los datos.

## PRINCIPIO RECTOR (NO NEGOCIABLE)
El nivel de certeza al escribir debe igualar al de la fuente. Prohibido inventar métricas, headcounts, años de fundación, revenues, nombres de personas o de terceros. Si un dato no tiene fuente, NO va. Preferí "sin dato" a un dato fabricado.

## DATOS YA CONFIRMADOS POR EL SISTEMA (no los contradigas)
Vienen en el mensaje del usuario: empresa, dominio, headcount de LinkedIn (si hay) y la lista de líderes CONFIRMADOS en Sales Navigator. Esos líderes son personas reales: no los borres ni los renombres.

## QUÉ INVESTIGAR
1. LA EMPRESA: qué hace, industria (etiqueta corta estilo "IT Consulting / Capital Markets"), ciudad/país sede, escala y contexto de crecimiento (adquisiciones, expansión, fondeo) SOLO con fuente. Si el headcount total no vino confirmado, buscalo y citá la fuente.
2. EQUIPO DIRECTIVO: solo para COMPLEMENTAR lo que Sales Navigator no trajo. Cada rol que agregues necesita fuente pública (sitio de la empresa, LinkedIn, prensa); si no la hay, no lo agregues.
3. REFERENTE DEL SECTOR: una empresa REAL y reconocida del mismo sector (o el más cercano), idealmente del mismo país del prospecto (si no hay, regional). Necesito EXACTAMENTE 4 métricas del referente, cada una con fuente y año (escala de personas, revenue publicado, países de operación, años en mercado, u otras con respaldo). Solo cifras publicadas: nada de estimaciones propias. El referente NO puede ser la misma empresa prospecto ni un competidor directo agresivo (buscá inspiración, no amenaza).
4. PATRÓN OPERATIVO DEL SECTOR: 2 a 4 hechos o tendencias del sector en ese país, con fuente, que sirvan para diagnosticar fricción operativa (crecimiento del sector, presión de escala, consolidación).
5. SUPUESTOS DEL CÁLCULO:
   - costo_hora de un líder en USD según país e industria. Benchmarks de referencia: Colombia/México SaaS-Tech $35; Argentina Tech $30-35; Perú Inmobiliario/FoodTech $35-38; Chile Fintech/Retail $38-40; Guatemala/Honduras Distribución/Agro $28, Tech/Gaming $30-45; Costa Rica/El Salvador Operaciones/Logística $22-32; México Multinacional/Gaming $45-55; Global/PE-backed C-level $45-55.
   - horas_perdidas por líder/semana según complejidad: 5 operación pequeña o procesos avanzados; 6 mediana estándar; 7 multipaís/multidivisión/multicanal; 8 holding o post-adquisición.
   Justificá ambos en una oración.

## RECENCIA
Descartá métricas y prensa con más de ~3 años de antigüedad, salvo hechos estructurales (año de fundación, sede).

## SALIDA
SOLO este JSON (sin markdown, sin texto alrededor):
{
  "company": { "name": "", "industry": "", "headcount_total": 0, "location": "", "country": "", "descripcion": "", "hechos": ["hecho con fuente y año", "..."] },
  "leadership_extra": [ { "name": "", "role": "", "fuente": "" } ],
  "supuestos": { "costo_hora": 0, "horas_perdidas": 0, "justificacion": "" },
  "referente": { "nombre": "", "desc": "una línea: qué es, escala, origen", "metricas": [ { "label": "", "value": "", "fuente": "" }, {}, {}, {} ], "hechos": ["hecho con fuente"], "fuente_principal": "" },
  "sector": { "patron": "el patrón operativo del sector en 2-3 oraciones, basado en los hechos", "fuentes": ["url o medio + año"] }
}`;
  }

  function validarResearch(r, ctx) {
    const p = [];
    const c = r && r.company;
    if (!c || !String(c.industry || '').trim()) p.push('company.industry vacío');
    if (!c || !String(c.country || '').trim()) p.push('company.country vacío');
    const hc = ctx.cliente.headcount || (c && Number(c.headcount_total)) || 0;
    if (!(hc >= 5)) p.push('headcount_total desconocido o menor a 5 (buscalo con fuente; sin headcount no hay cálculo)');
    const s = r && r.supuestos;
    if (!s || !Number.isFinite(Number(s.costo_hora))) p.push('supuestos.costo_hora no numérico');
    if (!s || !Number.isFinite(Number(s.horas_perdidas))) p.push('supuestos.horas_perdidas no numérico');
    const ref = r && r.referente;
    if (!ref || !String(ref.nombre || '').trim()) p.push('referente.nombre vacío');
    else if (_empKeyDelta(ref.nombre) === _empKeyDelta(ctx.empresa)) p.push('el referente no puede ser la misma empresa prospecto');
    const mets = (ref && Array.isArray(ref.metricas)) ? ref.metricas : [];
    if (mets.length !== 4) p.push(`referente.metricas debe tener EXACTAMENTE 4 (vinieron ${mets.length})`);
    mets.forEach((m, i) => {
      if (!m || !String(m.label || '').trim() || !String(m.value || '').trim()) p.push(`referente.metricas[${i}] sin label/value`);
      if (!m || !String(m.fuente || '').trim()) p.push(`referente.metricas[${i}] SIN FUENTE (métrica sin fuente no va)`);
    });
    if (!ref || !String(ref.fuente_principal || '').trim()) p.push('referente.fuente_principal vacío');
    return p;
  }

  async function researchConRetry(ctx) {
    const lidTxt = ctx.lid.lideres.length
      ? ctx.lid.lideres.map(l => `- ${l.role} (${l.name})`).join('\n')
      : '(Sales Navigator no devolvió líderes confirmados; el sistema usará la tabla de estimación y lo declarará)';
    let feedback = '';
    for (let intento = 1; intento <= DELTA_RESEARCH_TRIES; intento++) {
      const resp = await callClaude({
        model: MODEL_DELTA_GEN,
        system: _promptResearch(),
        messages: [{
          role: 'user',
          content: `Empresa prospecto: ${ctx.empresa}\nDominio: ${ctx.dominio || '(sin dominio)'}\nHeadcount total (LinkedIn): ${ctx.cliente.headcount ?? 'desconocido'}\nPaís probable: ${ctx.cliente.pais || 'desconocido (investigalo)'}\nContacto comercial (solo contexto, NO va al documento): ${ctx.nombre || '-'} <${ctx.email || '-'}>\n\nLíderes CONFIRMADOS en Sales Navigator (${ctx.lid.lideres.length}):\n${lidTxt}${feedback}`,
        }],
        tools: [WEB_SEARCH_TOOL],
      });
      let r;
      try { r = _parseJSON(_textoDe(resp), 'RESEARCH'); }
      catch (e) { feedback = `\n\nEL INTENTO ANTERIOR FALLÓ: ${e.message}. Devolvé SOLO el JSON pedido.`; continue; }
      const problemas = validarResearch(r, ctx);
      if (!problemas.length) return r;
      console.warn(`[DELTA:RESEARCH] intento ${intento}/${DELTA_RESEARCH_TRIES} con problemas: ${problemas.join(' | ')}`);
      feedback = `\n\nEL INTENTO ANTERIOR TUVO ESTOS PROBLEMAS (corregilos TODOS):\n- ${problemas.join('\n- ')}`;
    }
    throw new Error('RESEARCH no pasó las guardas tras ' + DELTA_RESEARCH_TRIES + ' intentos (referente sin 4 métricas con fuente, o datos base incompletos)');
  }

  // ── FASE 5: CONTENT (Claude sin tools, presupuestos estrictos) ─────────────
  function _promptContent() {
    return `# DELTA TEAMS — Diagnóstico ROI · Fase CONTENT (redacción)

Sos el redactor comercial de Delta Teams. Recibís research verificado + montos YA CALCULADOS, y escribís el copy de un PDF de 4 páginas: (1) El costo, (2) Referente y brecha, (3) El plan 6 meses, (4) Proyección y siguiente paso. El documento lo lee un CEO/founder sin contexto previo.

## IDENTIDAD
- Delta Teams, categoría TEPI (Team Execution & Performance Infrastructure). Voz ejecutiva, directa, orientada a resultados. Sin motivacional ni genérico.
- Cifras propias citables (ÚNICAS permitidas como track record): 61.4% avance OKRs (IBT), 81.7% retención (IBT), -30% reuniones improductivas, +20-40% velocidad de ejecución, implementación en 90 días.

## REGLAS DURAS (violarlas = rechazo)
1. FRAMING TEPI: PROHIBIDO escribir DOS, Rocks, L10, People Analyzer, EOS o Traction. Usá: "infraestructura de ejecución", "sistema de reuniones estructurado", "visibilidad del equipo", "objetivos con dueño y seguimiento", "decisiones con trazabilidad".
2. SIN EM DASHES: prohibido "—". Usá coma, punto o reestructurá.
3. DIAGNÓSTICO = PATRÓN DE INDUSTRIA: diagnosis.body habla del patrón del sector ("Las empresas de X en LATAM enfrentan..."), JAMÁS afirma conductas del CEO/founder/contacto específico. No nombres a ninguna persona.
4. MONTOS: NO escribas NINGÚN monto de dinero. Los montos ya están calculados y el sistema los pone en el template. Si necesitás referirte al costo, hacelo sin cifra ("lo que eso cuesta por año"). Únicas excepciones: métricas del REFERENTE que vengan del research (con su valor textual) y el costo hora del supuesto (te lo doy en el contexto), que podés citar en benchmark_nota.
5. ESPAÑOL LATAM NEUTRO: sin voseo argentino. Términos del sector (OKRs, KPIs, Scorecard, accountability) quedan en inglés.
6. CTA: cta.body invita a "20 minutos con Camila". NUNCA el nombre del prospecto en el CTA.
7. HONESTIDAD DE DATOS: usá SOLO hechos del research. Nada de años, cantidades, certificaciones o nombres que no estén ahí. benchmark_nota SIEMPRE arranca con "Estimación basada en..." y si el liderazgo vino estimado (te lo dice el contexto), lo aclara ("liderazgo estimado por tamaño").
8. QUOTE: reflexión ejecutiva del sector, SIN números ni porcentajes.
9. proj_nota debe mencionar el supuesto de crecimiento del 12% anual y que no incluye costo de oportunidad.
10. ESPEJO DE IDENTIDAD: consultora especializada → "quien ayuda a otros a X necesita la misma X internamente"; filial/COO → brecha entre estrategia global y ejecución local; holding → visibilidad centralizada de divisiones.

## ELEGÍ 4 FUENTES DE FRICCIÓN (distintas, las que mejor apliquen)
Reuniones sin estructura ni seguimiento · Objetivos y KPIs sin dueño claro ni revisión semanal · Decisiones sin trazabilidad entre áreas · CEO/director como único punto de coordinación · Operación multipaís/multidivisión sin visibilidad centralizada · Nuevas iniciativas sin seguimiento estructurado · Equipo distribuido sin métricas de performance por rol · Estrategia global sin traducción a ejecución local · Post-adquisición: divisiones con procesos distintos sin alineación.

## ELEGÍ 2 BENEFICIOS (para "Lo que Delta activa en 90 días")
Reuniones que generan decisiones documentadas con seguimiento · Dashboard unificado de objetivos, KPIs y avances en tiempo real · Decisiones con trazabilidad entre áreas y regiones · Objetivos conectados a ejecución semanal con dueños claros · Visibilidad del desempeño del equipo sin entrar a la operación.

## TIME BARS (ilustrativas, autodiagnóstico)
4 categorías de a dónde se va el tiempo redirigible de los líderes en ese sector. Porcentajes ENTEROS entre 5 y 60 que sumen EXACTAMENTE 100, en orden descendente.

## OKRs (página 3)
2 OKRs (Q1 días 1-90, Q2 días 91-180) que cierren las brechas identificadas. Cada uno: objetivo + 3 KRs con "hoy" (estado plausible del prospecto, honesto: "Sin dato" o "Línea base" si no sabés), "meta" (Q1/Q2) y "referente" (benchmark del referente o cifra Delta de la whitelist). Celdas hoy/meta/referente ULTRA cortas (máx 15 chars).

## PRESUPUESTOS DE LONGITUD (chars máx, NO los superes; el sistema rechaza si te pasás)
Apuntá a ~85% del máximo de cada campo, contando caracteres CON espacios. Ante la duda, MÁS CORTO: un campo corto es válido, uno pasado se rechaza.
headline 110 · subheadline 240 · diagnosis.heading 60 · diagnosis.body 560 · benchmark_nota 190 · ineficiencias title 55 / desc 240 · timebars.heading 75 / bar label 45 · ref_narrativa 520 · gaps dim 30 / prospect 40 / ref 45 · gap_closing 480 · plan_intro 260 · okr objetivo 80 / kr 80 / celdas 20 · benefits title 55 / desc 170 · proj_nota 340 · quote 280 · cta.heading 90 / cta.body 220.

## SALIDA
SOLO este JSON (sin markdown):
{
  "headline": "", "subheadline": "",
  "diagnosis": { "heading": "", "body": "" },
  "benchmark_nota": "",
  "ineficiencias": [ { "title": "", "desc": "" }, {}, {}, {} ],
  "timebars": { "heading": "", "bars": [ { "label": "", "pct": 0 }, {}, {}, {} ] },
  "ref_narrativa": "",
  "gaps": [ { "dim": "", "prospect": "", "ref": "" }, {}, {}, {}, {}, {} ],
  "gap_closing": "",
  "plan_intro": "",
  "okrs": [ { "objetivo": "", "krs": [ { "kr": "", "hoy": "", "meta": "", "ref": "" }, {}, {} ] }, {} ],
  "benefits": [ { "title": "", "desc": "" }, {} ],
  "proj_nota": "", "quote": "",
  "cta": { "heading": "", "body": "" }
}`;
  }

  function _chk(p, cond, msg) { if (!cond) p.push(msg); }
  function _len(p, campo, txt, max) {
    const n = String(txt || '').length;
    if (n === 0) p.push(`${campo} vacío`);
    else if (n > max) {
      p.push(`${campo} demasiado largo (${n}/${max} chars): recortalo`);
      if (p._largos) p._largos.push({ ruta: campo, actual: n, max });
    }
  }

  // Acceso por ruta ("okrs[0].krs[1].kr") para el pase de acorte dirigido.
  function _partesRuta(ruta) {
    return String(ruta).split('.').flatMap(seg => {
      const m = seg.match(/^([^[\]]+)((?:\[\d+\])*)$/);
      if (!m) return [seg];
      return [m[1], ...((m[2].match(/\d+/g) || []).map(Number))];
    });
  }
  function _getRuta(o, ruta) { return _partesRuta(ruta).reduce((a, k) => (a == null ? a : a[k]), o); }
  function _setRuta(o, ruta, v) {
    const ps = _partesRuta(ruta);
    let a = o;
    for (let i = 0; i < ps.length - 1; i++) { if (a == null) return; a = a[ps[i]]; }
    if (a != null) a[ps[ps.length - 1]] = v;
  }

  // RED FINAL contra los largos: la IA no sabe contar caracteres (verificado 2 veces en producción,
  // ni el acorte dirigido converge siempre). Recorte SEGURO: tira oraciones enteras del final;
  // si ni una oración entra (campos cortos), corta en límite de palabra. El juez evalúa el texto
  // FINAL, así que un recorte que rompa el sentido no pasa sin control.
  function _recorteDeterminista(texto, max) {
    let t = String(texto || '').trim();
    if (t.length <= max) return t;
    const oraciones = t.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (oraciones && oraciones.length > 1) {
      let out = '';
      for (const o of oraciones) {
        if ((out + o).trim().length > max) break;
        out += o;
      }
      out = out.trim();
      if (out.length >= Math.min(40, max * 0.5)) return out;
    }
    let corte = t.slice(0, max);
    const esp = corte.lastIndexOf(' ');
    if (esp > max * 0.6) corte = corte.slice(0, esp);
    corte = corte.replace(/[\s,;:.]+$/, '');
    return (/[.!?]$/.test(t) && corte.length + 1 <= max) ? corte + '.' : corte;
  }

  // GUARDAS determinísticas sobre el copy (el juez NO puede saltarlas).
  function validarContenido(c, ctx) {
    const p = [];
    p._largos = [];   // desbordes de largo estructurados, para el pase de acorte dirigido
    if (!c || typeof c !== 'object') return ['CONTENT no devolvió un objeto'];

    _len(p, 'headline', c.headline, LIMITES.HEADLINE);
    _len(p, 'subheadline', c.subheadline, LIMITES.SUBHEADLINE);
    _chk(p, c.diagnosis && typeof c.diagnosis === 'object', 'falta diagnosis');
    if (c.diagnosis) {
      _len(p, 'diagnosis.heading', c.diagnosis.heading, LIMITES.DIAGNOSIS_HEADING);
      _len(p, 'diagnosis.body', c.diagnosis.body, LIMITES.DIAGNOSIS_BODY);
    }
    _len(p, 'benchmark_nota', c.benchmark_nota, LIMITES.BENCHMARK_NOTA);
    if (!/estimaci/i.test(String(c.benchmark_nota || ''))) p.push('benchmark_nota debe declararse como estimación ("Estimación basada en...")');
    if (ctx.liderazgo.fuente !== 'sales_nav' && !/estimad|estimaci/i.test(String(c.benchmark_nota || ''))) {
      p.push('el liderazgo vino ESTIMADO por tabla: benchmark_nota debe aclararlo');
    }

    _chk(p, Array.isArray(c.ineficiencias) && c.ineficiencias.length === 4, `ineficiencias debe tener EXACTAMENTE 4 (vinieron ${(c.ineficiencias || []).length})`);
    (c.ineficiencias || []).forEach((x, i) => { _len(p, `ineficiencias[${i}].title`, x && x.title, LIMITES.INEFF_TITLE); _len(p, `ineficiencias[${i}].desc`, x && x.desc, LIMITES.INEFF_DESC); });

    const bars = (c.timebars && c.timebars.bars) || [];
    _len(p, 'timebars.heading', c.timebars && c.timebars.heading, LIMITES.TIMEBARS_HEADING);
    _chk(p, bars.length === 4, `timebars.bars debe tener EXACTAMENTE 4 (vinieron ${bars.length})`);
    if (bars.length === 4) {
      bars.forEach((b, i) => {
        _len(p, `timebars.bars[${i}].label`, b && b.label, LIMITES.BAR_LABEL);
        const v = Number(b && b.pct);
        if (!Number.isInteger(v) || v < 5 || v > 60) p.push(`timebars.bars[${i}].pct debe ser entero entre 5 y 60 (vino ${b && b.pct})`);
      });
      const suma = bars.reduce((a, b) => a + (Number(b && b.pct) || 0), 0);
      if (suma !== 100) p.push(`los pct de las bars deben sumar EXACTAMENTE 100 (suman ${suma})`);
    }

    _len(p, 'ref_narrativa', c.ref_narrativa, LIMITES.REF_NARRATIVA);
    _chk(p, Array.isArray(c.gaps) && c.gaps.length === 6, `gaps debe tener EXACTAMENTE 6 (vinieron ${(c.gaps || []).length})`);
    (c.gaps || []).forEach((g, i) => {
      _len(p, `gaps[${i}].dim`, g && g.dim, LIMITES.GAP_DIM);
      _len(p, `gaps[${i}].prospect`, g && g.prospect, LIMITES.GAP_PROSPECT);
      _len(p, `gaps[${i}].ref`, g && g.ref, LIMITES.GAP_REF);
    });
    _len(p, 'gap_closing', c.gap_closing, LIMITES.GAP_CLOSING_BODY);
    _len(p, 'plan_intro', c.plan_intro, LIMITES.PLAN_INTRO);

    _chk(p, Array.isArray(c.okrs) && c.okrs.length === 2, `okrs debe tener EXACTAMENTE 2 (vinieron ${(c.okrs || []).length})`);
    (c.okrs || []).forEach((o, i) => {
      _len(p, `okrs[${i}].objetivo`, o && o.objetivo, LIMITES.OKR_OBJETIVO);
      const krs = (o && o.krs) || [];
      _chk(p, krs.length === 3, `okrs[${i}].krs debe tener EXACTAMENTE 3 (vinieron ${krs.length})`);
      krs.forEach((k, j) => {
        _len(p, `okrs[${i}].krs[${j}].kr`, k && k.kr, LIMITES.OKR_KR);
        _len(p, `okrs[${i}].krs[${j}].hoy`, k && k.hoy, LIMITES.OKR_CELDA);
        _len(p, `okrs[${i}].krs[${j}].meta`, k && k.meta, LIMITES.OKR_CELDA);
        _len(p, `okrs[${i}].krs[${j}].ref`, k && k.ref, LIMITES.OKR_CELDA);
      });
    });

    _chk(p, Array.isArray(c.benefits) && c.benefits.length === 2, `benefits debe tener EXACTAMENTE 2 (vinieron ${(c.benefits || []).length})`);
    (c.benefits || []).forEach((b, i) => { _len(p, `benefits[${i}].title`, b && b.title, LIMITES.BENEFIT_TITLE); _len(p, `benefits[${i}].desc`, b && b.desc, LIMITES.BENEFIT_DESC); });

    _len(p, 'proj_nota', c.proj_nota, LIMITES.PROJ_NOTA);
    if (!/12\s*%/.test(String(c.proj_nota || ''))) p.push('proj_nota debe mencionar el supuesto de crecimiento del 12% anual');
    _len(p, 'quote', c.quote, LIMITES.QUOTE);
    if (/[%$\d]/.test(String(c.quote || ''))) p.push('quote no puede tener números, % ni montos (reflexión sin cifras)');
    _chk(p, c.cta && typeof c.cta === 'object', 'falta cta');
    if (c.cta) {
      _len(p, 'cta.heading', c.cta.heading, LIMITES.CTA_HEADING);
      _len(p, 'cta.body', c.cta.body, LIMITES.CTA_BODY);
      if (!/camila/i.test(String(c.cta.body || ''))) p.push('cta.body debe invitar a la llamada con Camila');
    }

    // Framing TEPI + contacto + montos, sobre TODO el texto del copy
    const textos = [];
    (function walk(o, ruta) {
      if (typeof o === 'string') { textos.push([ruta, o]); return; }
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${ruta}[${i}]`)); return; }
      if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], ruta ? `${ruta}.${k}` : k);
    })(c, '');

    for (const [ruta, t] of textos) {
      for (const { re, label } of _RE_TEPI) if (re.test(t)) p.push(`${ruta}: usa el término prohibido "${label}" (framing TEPI: reemplazalo por lenguaje de infraestructura de ejecución)`);
      if (/[—–]/.test(t)) p.push(`${ruta}: contiene em dash`);
    }
    const pila = _nombrePila(ctx.nombre);
    if (pila) {
      const rePila = new RegExp(`\\b${pila.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (c.diagnosis && rePila.test(String(c.diagnosis.body || ''))) p.push(`diagnosis.body nombra al contacto (${pila}): el diagnóstico habla del patrón de industria, no de la persona`);
      if (c.cta && (rePila.test(String(c.cta.heading || '')) || rePila.test(String(c.cta.body || '')))) p.push(`el CTA nombra al prospecto (${pila}): el CTA es siempre con Camila`);
    }
    // Montos: la IA no escribe dinero. Se permiten SOLO montos calculados, métricas del referente
    // y el costo hora del supuesto con su rango de benchmark (citarlo en benchmark_nota es honesto).
    const permitidos = new Set(Object.values(ctx.nums).map(v => String(v).replace(/[^0-9]/g, '')));
    for (const m of (ctx.montosReferente || [])) permitidos.add(String(m).replace(/[^0-9]/g, ''));
    for (const m of (ctx.montosSupuestos || [])) permitidos.add(String(m).replace(/[^0-9]/g, ''));
    for (const [ruta, t] of textos) {
      for (const m of String(t).matchAll(/\$\s?([\d][\d.,]*)/g)) {
        const digitos = m[1].replace(/[^0-9]/g, '');
        if (digitos && !permitidos.has(digitos)) p.push(`${ruta}: cita un monto "$${m[1]}" que NO es de los calculados ni del referente (prohibido inventar dinero)`);
      }
    }
    return p;
  }

  // Pase de ACORTE DIRIGIDO: cuando lo ÚNICO que falla son largos, no regeneramos todo el copy
  // (visto en la primera corrida real: regenerar arreglaba unos campos y rompía otros); una llamada
  // barata reescribe SOLO los campos excedidos y el resto queda intacto.
  async function acortarCampos(c, largos) {
    const items = largos.map(l => ({ ruta: l.ruta, max: l.max, texto: String(_getRuta(c, l.ruta) || '') }));
    const resp = await callClaude({
      model: MODEL_DELTA_GEN,
      system: 'Sos el editor de textos de Delta Teams. Recibís campos de un documento que EXCEDEN su máximo de caracteres. Reescribí CADA UNO por debajo de su "max" (apuntá al 85% del max, contando caracteres CON espacios), conservando el sentido y el dato principal. Reglas duras: sin em dashes, sin montos de dinero nuevos, sin DOS/Rocks/L10/EOS/Traction, español LATAM neutro sin voseo. Respondé SOLO un JSON de la forma {"<ruta>": "<texto nuevo>", ...} con EXACTAMENTE las mismas rutas que recibiste.',
      messages: [{ role: 'user', content: JSON.stringify(items) }],
      maxTokens: 3000,
    });
    const nuevos = _parseJSON(_textoDe(resp), 'ACORTE');
    const out = JSON.parse(JSON.stringify(c));
    for (const [ruta, texto] of Object.entries(nuevos)) {
      if (typeof texto === 'string' && texto.trim()) _setRuta(out, ruta, _sanearDeep(texto));
    }
    return out;
  }

  async function contentConRetry(ctx, research, fixes) {
    const numsTxt = Object.entries(ctx.nums).map(([k, v]) => `${k}: ${v}`).join('\n');
    const lidNota = ctx.liderazgo.fuente === 'sales_nav'
      ? `${ctx.liderazgo.cantidad} líderes CONFIRMADOS en Sales Navigator`
      : `${ctx.liderazgo.cantidad} líderes ESTIMADOS por tabla de tamaño (solo ${ctx.liderazgo.confirmados} confirmados): declaralo en benchmark_nota`;
    let feedback = fixes && fixes.length ? `\n\nCORRECCIONES DEL JUEZ (aplicalas TODAS):\n- ${fixes.join('\n- ')}` : '';
    for (let intento = 1; intento <= DELTA_CONTENT_TRIES; intento++) {
      const resp = await callClaude({
        model: MODEL_DELTA_GEN,
        system: _promptContent(),
        messages: [{
          role: 'user',
          content: `## Empresa prospecto\n${ctx.empresa} (${research.company.industry}, ${research.company.country}, ${ctx.headcountTotal} personas, ${lidNota}).\nDescripción: ${research.company.descripcion || '-'}\nHechos con fuente: ${JSON.stringify(research.company.hechos || [])}\nPatrón del sector: ${research.sector && research.sector.patron || '-'}\n\n## Referente (research verificado)\n${JSON.stringify(research.referente)}\n\n## Supuestos aplicados\ncosto hora USD ${ctx.supuestos.costoHora} · ${ctx.supuestos.horasPerdidas}h perdidas/semana por líder · ${ctx.liderazgo.cantidad} líderes · Justificación: ${research.supuestos.justificacion || '-'}\n\n## Montos YA calculados (NO escribas ninguno en el copy; solo contexto)\n${numsTxt}\n\n## Fecha del documento\n${ctx.fecha}${feedback}`,
        }],
      });
      let c;
      try { c = _sanearDeep(_parseJSON(_textoDe(resp), 'CONTENT')); }
      catch (e) { feedback = `\n\nEL INTENTO ANTERIOR FALLÓ: ${e.message}. Devolvé SOLO el JSON pedido.`; continue; }
      let problemas = validarContenido(c, ctx);
      const _soloLargos = (pr) => pr.length && pr._largos && pr.length === pr._largos.length;
      // Si TODOS los problemas son de largo: 1 pase de acorte con IA (calidad)...
      if (_soloLargos(problemas)) {
        console.warn(`[DELTA:CONTENT] ${problemas.length} campos exceden el largo → acorte dirigido (${problemas._largos.map(l => l.ruta).join(', ')})`);
        try { c = await acortarCampos(c, problemas._largos); problemas = validarContenido(c, ctx); }
        catch (e) { console.warn('[DELTA:CONTENT] acorte dirigido falló:', e.message); }
      }
      // ...y lo que siga pasado se recorta determinístico: los largos ya NO pueden tumbar el job.
      if (_soloLargos(problemas)) {
        console.warn(`[DELTA:CONTENT] recorte determinístico final de ${problemas._largos.length} campos (${problemas._largos.map(l => l.ruta).join(', ')})`);
        for (const l of problemas._largos) _setRuta(c, l.ruta, _recorteDeterminista(String(_getRuta(c, l.ruta) || ''), l.max));
        problemas = validarContenido(c, ctx);
      }
      if (!problemas.length) return c;
      console.warn(`[DELTA:CONTENT] intento ${intento}/${DELTA_CONTENT_TRIES}: ${problemas.length} problemas: ${problemas.slice(0, 6).join(' | ')}${problemas.length > 6 ? ' | ...' : ''}`);
      feedback = `${fixes && fixes.length ? `\n\nCORRECCIONES DEL JUEZ (aplicalas TODAS):\n- ${fixes.join('\n- ')}` : ''}\n\nEL INTENTO ANTERIOR VIOLÓ ESTAS GUARDAS (corregilas TODAS):\n- ${problemas.join('\n- ')}`;
    }
    throw new Error('CONTENT no pasó las guardas tras ' + DELTA_CONTENT_TRIES + ' intentos');
  }

  // ── Armar el objeto data (claves = placeholders del template) ──────────────
  function armarData(ctx, research, c) {
    const ref = research.referente;
    const d = {
      COMPANY_NAME: ctx.empresa,
      COMPANY_INDUSTRY: research.company.industry,
      COMPANY_HEADCOUNT_TOTAL: String(ctx.headcountTotal),
      COMPANY_HEADCOUNT_LEADERSHIP: String(ctx.liderazgo.cantidad),
      COMPANY_LOCATION: research.company.location || research.company.country,
      COMPANY_COUNTRY: research.company.country,
      REPORT_DATE: ctx.fecha,
      HEADLINE: c.headline, SUBHEADLINE: c.subheadline,
      DIAGNOSIS_HEADING: c.diagnosis.heading, DIAGNOSIS_BODY: c.diagnosis.body,
      BENCHMARK_NOTA: c.benchmark_nota,
      TIMEBARS_HEADING: c.timebars.heading,
      REF_NAME: ref.nombre, REF_DESC: ref.desc,
      REF_NARRATIVA: c.ref_narrativa,
      REF_FUENTE: `Fuente: ${ref.fuente_principal}`,
      GAP_CLOSING_BODY: c.gap_closing,
      PLAN_INTRO: c.plan_intro,
      PROJ_NOTA: c.proj_nota, QUOTE: c.quote,
      CTA_HEADING: c.cta.heading, CTA_BODY: c.cta.body,
      ...ctx.nums,
    };
    c.ineficiencias.forEach((x, i) => { d[`INEFF_${i + 1}_TITLE`] = x.title; d[`INEFF_${i + 1}_DESC`] = x.desc; });
    c.timebars.bars.forEach((b, i) => { d[`BAR_${i + 1}_LABEL`] = b.label; d[`BAR_${i + 1}_PCT`] = String(b.pct); });
    ref.metricas.forEach((m, i) => { d[`REF_METRIC_${i + 1}_LABEL`] = m.label; d[`REF_METRIC_${i + 1}_VALUE`] = m.value; });
    c.gaps.forEach((g, i) => { d[`GAP_${i + 1}_DIM`] = g.dim; d[`GAP_${i + 1}_PROSPECT`] = g.prospect; d[`GAP_${i + 1}_REF`] = g.ref; });
    c.okrs.forEach((o, i) => {
      d[`OKR_${i + 1}_OBJETIVO`] = o.objetivo;
      o.krs.forEach((k, j) => {
        d[`OKR_${i + 1}_KR_${j + 1}`] = k.kr; d[`OKR_${i + 1}_HOY_${j + 1}`] = k.hoy;
        d[`OKR_${i + 1}_META_${j + 1}`] = k.meta; d[`OKR_${i + 1}_REF_${j + 1}`] = k.ref;
      });
    });
    c.benefits.forEach((b, i) => { d[`BENEFIT_${i + 1}_TITLE`] = b.title; d[`BENEFIT_${i + 1}_DESC`] = b.desc; });
    return d;
  }

  // ── FASE 8: JUEZ (fail-closed, 8 criterios) ────────────────────────────────
  const SYSTEM_PROMPT_JUDGE_DELTA = `Sos un juez de control de calidad EXTREMADAMENTE ESTRICTO para el "Diagnóstico ROI Personalizado" de Delta Teams (documento comercial que un CEO recibe por email). Recibís los DATOS CONFIRMADOS del sistema, los MONTOS CALCULADOS y el CONTENIDO final del documento. Evaluá los 8 criterios; APROBADO exige 8/8.

1. ANTI-INVENCIÓN DEL PROSPECTO: nombre de empresa, industria, headcount y país del documento coinciden con los datos confirmados. FAIL si aparecen hechos del prospecto (años, adquisiciones, metas, tecnologías) que no estén en el research provisto.
2. REFERENTE VERIFICABLE: el referente es una empresa real del sector, las 4 métricas tienen fuente en el research, la narrativa no agrega cifras nuevas y REF_FUENTE está presente. FAIL si alguna métrica del referente no está respaldada.
3. PATRÓN DE INDUSTRIA: el diagnóstico habla del patrón del sector, no atribuye conductas a personas específicas del prospecto. FAIL si nombra al CEO/contacto o le atribuye comportamientos.
4. FRAMING TEPI: cero menciones de DOS, Rocks, L10, People Analyzer, EOS, Traction. Lenguaje de "infraestructura de ejecución". Voz ejecutiva, sin motivacional genérico.
5. IDIOMA: español LATAM neutro, sin voseo argentino, sin em dashes (—), sin errores graves.
6. COHERENCIA NUMÉRICA: todo monto de dinero del contenido es EXACTAMENTE uno de los montos calculados o una métrica del referente con fuente; las cifras de track record de Delta/IBT son solo de la whitelist (${CIFRAS_DELTA_WHITELIST.join(', ')}); las time bars suman 100.
7. HONESTIDAD Y DATOS SANOS: si el liderazgo fue estimado (no confirmado), el documento lo declara; sin placeholders rotos ([INSERT], undefined, {{...}}), sin celdas vacías, sin contradicciones internas.
8. CTA Y MARCA: el CTA invita a 20 minutos con Camila (nunca al prospecto por nombre), tono consistente con Delta Teams.

REGLA DE ORO: ante la duda, RECHAZADO. Este PDF define la credibilidad de Delta Teams.

Respondé SOLO este JSON:
{"veredicto":"APROBADO|RECHAZADO","score":0-8,"criterios":{"anti_invencion":true,"referente":true,"patron_industria":true,"framing_tepi":true,"idioma":true,"coherencia_numerica":true,"honestidad":true,"cta_marca":true},"fixes":["instrucción concreta y accionable por cada problema"]}`;

  async function runJudgeDelta(payload) {
    setStage('judge');
    try {
      const resp = await callClaude({
        model: MODEL_DELTA_JUDGE,
        system: SYSTEM_PROMPT_JUDGE_DELTA,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
        temperature: 0,
        maxTokens: 4000,
      });
      const j = _parseJSON(_textoDe(resp), 'JUDGE');
      const veredicto = j.veredicto === 'APROBADO' ? 'APROBADO' : 'RECHAZADO';
      const score = Number.isFinite(Number(j.score)) ? Number(j.score) : 0;
      return { veredicto, score, fixes: Array.isArray(j.fixes) ? j.fixes : [] };
    } catch (e) {
      // FAIL-CLOSED: si el juez no parsea, el reporte NO sale.
      console.warn('[DELTA:JUDGE] no parseó (fail-closed → RECHAZADO):', e.message);
      return { veredicto: 'RECHAZADO', score: 0, fixes: ['El juez no pudo evaluar el documento (respuesta no parseable): regenerar el contenido.'] };
    } finally { setStage('gen'); }
  }

  // ── Render + conteo de páginas (guarda determinística de overflow) ─────────
  async function renderYContar(data) {
    const html = renderDelta(data);
    const pdf = await renderizarPdf(html);
    const paginas = await contarPaginas(pdf);
    return { html, pdf, paginas };
  }

  // ── MODO TEST (plumbing n8n end-to-end, $0): renderiza la fixture Optimissa ─
  async function _reporteDePrueba() {
    const { supuestos, lookup, contenido } = require('./fixture-optimissa.js');
    const data = { ...lookup, ...contenido, ...numerosParaTemplate(supuestos) };
    return await renderYContar(data);
  }

  // ── PIPELINE COMPLETO (async job) ───────────────────────────────────────────
  const jobs = new Map();
  const enProgreso = new Map();
  const _leadKey = ({ profileId, dominio, email, empresa }) => String(profileId || dominio || email || empresa || '').trim().toLowerCase();

  setInterval(() => {
    const limite = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of jobs.entries()) if ((job.finishedAt || job.createdAt || 0) < limite) jobs.delete(id);
  }, 30 * 60 * 1000);

  async function procesarDelta(jobId, { email, dominio, empresa, nombre, profileId, evalMode, test }) {
    return statsALS.run(nuevoStats(), async () => {
      try {
        console.log(`\n===== [DELTA] Job ${jobId} - Inicio =====\nEmpresa: ${empresa} | Email: ${email} | Dominio: ${dominio} | profileId: ${profileId ?? '-'}`);

        // MODO TEST: renderiza la fixture Optimissa con el template REAL y Puppeteer REAL
        // (a diferencia del GTM, acá el test también ejercita render + conteo de páginas). $0.
        if (test === true || String(test).toLowerCase() === 'on' || String(process.env.DELTA_TEST_MODE || '').toLowerCase() === 'on') {
          console.log(`[DELTA:TEST] Job ${jobId}: fixture Optimissa, sin Claude ni MCP ($0).`);
          const { pdf, paginas } = await _reporteDePrueba();
          jobs.set(jobId, {
            status: 'ok', test: true, producto: 'delta_roi', apto_envio: true,
            pdf_base64: pdf.toString('base64'),
            empresa: empresa || 'Optimissa México (fixture)', nombre: nombre || '', email: email || '',
            pdf_filename: _nombreArchivo('TEST ' + (empresa || 'Optimissa')),
            paginas, juez: 'TEST (sin evaluar)',
            tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0, web_searches: 0 },
            finishedAt: Date.now(),
          });
          _registrarEnSheet({ empresa: empresa || 'Optimissa (fixture)', dominio: dominio || '', estado: 'test', apto_envio: 'SI', paginas, costo_usd: 0, jobId });
          console.log(`===== [DELTA] Job ${jobId} - TEST OK (${paginas} páginas, $0) =====\n`);
          return;
        }

        setStage('gen');
        // 1-2. CLIENTE + LIDERAZGO (MCP, datos reales)
        const cliente = await resolverCliente({ profileId, dominio, empresa });
        const empresaFinal = cliente.empresa || empresa;
        if (!empresaFinal) throw new Error('No se pudo resolver la empresa (sin empresa/dominio/profileId anclables)');
        const lid = await buscarLiderazgo(cliente);

        // 3. RESEARCH (Claude + web_search)
        const ctxBase = { empresa: empresaFinal, dominio, email, nombre, cliente, lid, fecha: _fechaEs() };
        const research = await researchConRetry(ctxBase);

        // 4. CALC (determinístico; los supuestos de la IA pasan por los clamps del benchmark)
        const headcountTotal = cliente.headcount || Number(research.company.headcount_total) || 0;
        if (!(headcountTotal >= 5)) throw new Error('Headcount total desconocido: sin él no hay cálculo de ROI honesto');
        const liderazgo = resolverLiderazgo(lid, headcountTotal);
        const costoHora = clampCostoHora(research.supuestos.costo_hora, research.company.country, research.company.industry);
        const horasPerdidas = clampHorasPerdidas(research.supuestos.horas_perdidas);
        const nums = numerosParaTemplate({ headcountLeadership: liderazgo.cantidad, costoHora, horasPerdidas });
        console.log(`[DELTA:CALC] ${liderazgo.cantidad} líderes (${liderazgo.fuente}) × $${costoHora}/h × ${horasPerdidas}h → ${nums.INEFF_COST_ANNUAL}/año`);

        const rangoBenchmark = _rangoCostoHora(research.company.country, research.company.industry);
        const ctx = {
          ...ctxBase, headcountTotal, liderazgo, nums,
          supuestos: { costoHora, horasPerdidas },
          montosReferente: (research.referente.metricas || []).map(m => m && m.value).filter(Boolean),
          montosSupuestos: [costoHora, rangoBenchmark.min, rangoBenchmark.max],
        };

        // 5-7. CONTENT → guardas → render → páginas (reintento si el PDF no da 4 páginas exactas)
        let contenido = await contentConRetry(ctx, research, null);
        let data = armarData(ctx, research, contenido);
        let r = await renderYContar(data);
        if (r.paginas !== DELTA_EXPECTED_PAGES) {
          console.warn(`[DELTA:PAGES] PDF con ${r.paginas} páginas (esperadas ${DELTA_EXPECTED_PAGES}) → reintento con copy más corto.`);
          contenido = await contentConRetry(ctx, research, [
            `El documento renderizado ocupó ${r.paginas} páginas y debe ocupar EXACTAMENTE ${DELTA_EXPECTED_PAGES}. Acortá los textos largos (diagnosis.body, ref_narrativa, gap_closing, descripciones) usando como máximo el 80% del presupuesto de cada campo.`,
          ]);
          data = armarData(ctx, research, contenido);
          r = await renderYContar(data);
        }

        // 8. JUEZ (+ hasta DELTA_MAX_FIX_ITERS rondas de fix)
        const payloadJuez = () => ({
          datos_confirmados: {
            empresa: empresaFinal, headcount_total: headcountTotal,
            liderazgo: { cantidad: liderazgo.cantidad, confirmados: liderazgo.confirmados, fuente: liderazgo.fuente },
            industria: research.company.industry, pais: research.company.country,
            contacto_no_publicable: nombre || '-',
          },
          research: { referente: research.referente, sector: research.sector, hechos_empresa: research.company.hechos || [] },
          montos_calculados: ctx.nums,
          documento: data,
        });
        let judge = await runJudgeDelta(payloadJuez());
        for (let i = 1; i <= DELTA_MAX_FIX_ITERS && judge.veredicto === 'RECHAZADO' && judge.fixes.length; i++) {
          console.log(`[DELTA:JUDGE] Rechazado ${judge.score}/8 → fix ${i}/${DELTA_MAX_FIX_ITERS}: ${judge.fixes.slice(0, 3).join(' | ')}`);
          setStage('fix');
          try {
            contenido = await contentConRetry(ctx, research, judge.fixes);
            data = armarData(ctx, research, contenido);
            r = await renderYContar(data);
            judge = await runJudgeDelta(payloadJuez());
          } catch (e) {
            console.warn('[DELTA:FIX] falló, conservo la versión previa:', e.message);
            break;
          } finally { setStage('gen'); }
        }

        const aptoEnvio = judge.veredicto === 'APROBADO' && r.paginas === DELTA_EXPECTED_PAGES;
        const adjuntar = aptoEnvio || DELTA_ALWAYS_SEND;
        logTokenCost(`[DELTA] Job ${jobId}`);
        const st = _stats();
        jobs.set(jobId, {
          status: 'ok', producto: 'delta_roi',
          pdf_base64: adjuntar && r.pdf ? r.pdf.toString('base64') : null,
          reporte: evalMode ? { data, research, supuestos: ctx.supuestos, liderazgo } : undefined,
          empresa: empresaFinal, nombre: nombre || '', email: email || '',
          anclado: cliente.anclado, cliente_resuelto: cliente,
          apto_envio: aptoEnvio,
          paginas: r.paginas, paginas_ok: r.paginas === DELTA_EXPECTED_PAGES,
          liderazgo_fuente: liderazgo.fuente, lideres_confirmados: liderazgo.confirmados,
          juez: `${judge.veredicto} ${judge.score}/8`, juez_fixes: judge.fixes,
          pdf_filename: _nombreArchivo(empresaFinal),
          tokens: { ...(st ? st.total : {}) },
          finishedAt: Date.now(),
        });
        _registrarEnSheet({
          empresa: empresaFinal, dominio: dominio || '', estado: 'ok',
          veredicto: judge.veredicto, score: judge.score,
          apto_envio: aptoEnvio ? 'SI' : 'NO',
          lideres: `${liderazgo.cantidad} (${liderazgo.fuente})`,
          costo_ineficiencia: ctx.nums.INEFF_COST_ANNUAL,
          paginas: r.paginas,
          motivo: aptoEnvio ? 'ok' : (r.paginas !== DELTA_EXPECTED_PAGES ? 'paginas' : 'juez'),
          costo_usd: _costoUSD(), jobId,
        });
        console.log(`===== [DELTA] Job ${jobId} - ${aptoEnvio ? `OK ${r.paginas} páginas` : 'NO apto'}, juez ${judge.veredicto} ${judge.score}/8 =====\n`);
      } catch (err) {
        console.error(`[DELTA] Job ${jobId} Error:`, err);
        jobs.set(jobId, { status: 'error', producto: 'delta_roi', error: err.message, finishedAt: Date.now() });
        _registrarEnSheet({
          empresa: empresa || '', dominio: dominio || '', estado: 'error',
          apto_envio: 'NO', motivo: String(err.message || err).slice(0, 180),
          costo_usd: _costoUSD(), jobId,
        });
      }
    });
  }

  // ── Router (espejo de /generar + /resultado + /pdf + /health del GTM) ──────
  const router = express.Router();

  // Landing web de Delta (misma mecánica que index.html del GTM, branding Delta Teams).
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));

  router.post('/generar', (req, res) => {
    // GATE DE LANDING (mismo patrón que /generar del GTM): si DELTA_LANDING_KEY (o LANDING_KEY,
    // para reusar el mismo servicio de landing) está seteada, se exige la clave en el header.
    // Sin la env no gatea: n8n/producción siguen igual que siempre.
    const _landingKey = process.env.DELTA_LANDING_KEY || process.env.LANDING_KEY;
    if (_landingKey && req.header('x-landing-key') !== _landingKey) {
      return res.status(401).json({ error: 'Clave invalida' });
    }
    const { email, dominio, empresa, nombre, profileId, eval: evalMode, debug, test } = req.body || {};
    if (!empresa && !dominio && !profileId) return res.status(400).json({ error: 'Falta empresa, dominio o profileId' });

    const key = _leadKey({ profileId, dominio, email, empresa });
    if (key && enProgreso.has(key)) {
      const previo = enProgreso.get(key);
      const j = jobs.get(previo);
      if (j && j.status === 'processing') {
        console.log(`[DELTA:DEDUP] Lead "${key}" ya en proceso (job ${previo}).`);
        return res.status(202).json({ jobId: previo, status: 'processing', deduplicado: true });
      }
    }

    const jobId = crypto.randomUUID();
    jobs.set(jobId, { status: 'processing', producto: 'delta_roi', createdAt: Date.now() });
    if (key) enProgreso.set(key, jobId);
    res.status(202).json({ jobId, status: 'processing' });

    // Cinturón global anti-zombie (mismo patrón que /generar del GTM).
    let jobTimer;
    const timeoutGlobal = new Promise((resolve) => {
      jobTimer = setTimeout(() => {
        console.error(`[DELTA] Job ${jobId} TIMEOUT GLOBAL (>${DELTA_JOB_TIMEOUT_MS}ms).`);
        jobs.set(jobId, { status: 'error', producto: 'delta_roi', error: 'timeout global del job', finishedAt: Date.now() });
        resolve();
      }, DELTA_JOB_TIMEOUT_MS);
    });
    Promise.race([
      procesarDelta(jobId, { email, dominio, empresa: empresa || dominio, nombre: nombre || '', profileId, evalMode: evalMode || debug, test }),
      timeoutGlobal,
    ]).catch((err) => {
      console.error(`[DELTA] Job ${jobId} rechazo no atrapado:`, err && err.stack || err);
      const prev = jobs.get(jobId);
      if (!prev || prev.status === 'processing') jobs.set(jobId, { status: 'error', producto: 'delta_roi', error: err && err.message || String(err), finishedAt: Date.now() });
    }).finally(() => {
      clearTimeout(jobTimer);
      if (key && enProgreso.get(key) === jobId) enProgreso.delete(key);
    });
  });

  router.get('/resultado/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
    res.json(job);
  });

  router.get('/pdf/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'jobId no encontrado o expirado' });
    if (job.status === 'processing') return res.status(409).json({ error: 'el diagnóstico todavía se está generando' });
    if (!job.pdf_base64) return res.status(422).json({ error: 'el diagnóstico no generó PDF (no apto)' });
    const buf = Buffer.from(job.pdf_base64, 'base64');
    const nombre = String(job.pdf_filename || 'Diagnostico ROI.pdf');
    const nombreAscii = nombre.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreAscii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`);
    res.send(buf);
  });

  router.get('/health', (req, res) => {
    let activos = 0; for (const j of jobs.values()) if (j.status === 'processing') activos++;
    res.json({
      ok: true, producto: 'delta_roi', jobs_activos: activos, jobs_en_cache: jobs.size,
      paginas_esperadas: DELTA_EXPECTED_PAGES, always_send: DELTA_ALWAYS_SEND,
      // Railway inyecta el SHA del commit deployado: corta la duda de "¿qué versión corre?"
      commit: String(process.env.RAILWAY_GIT_COMMIT_SHA || 'local').slice(0, 7),
    });
  });

  // Helpers puros expuestos para test (convención del repo)
  router._interno = { validarContenido, validarResearch, resolverLiderazgo, armarData, _empKeyDelta, _fechaEs, _getRuta, _setRuta, _recorteDeterminista, LIMITES };
  return router;
};
