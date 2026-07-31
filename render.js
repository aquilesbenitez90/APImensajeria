'use strict';
const fs = require('fs');
const path = require('path');

// Logo: se lee del repo (LOGO_PATH o ./logo-white.png) y se inyecta como data URI
// en el render, pisando el base64 embebido de la plantilla (que queda solo de fallback).
const LOGO_PATH = process.env.LOGO_PATH || path.join(__dirname, 'logo-white.png');
let _logoCache; // undefined = no probado | '' = no encontrado | string = data URI
function _logoDataUri() {
  if (_logoCache !== undefined) return _logoCache;
  try {
    const buf = fs.readFileSync(LOGO_PATH);
    _logoCache = 'data:image/png;base64,' + buf.toString('base64');
  } catch {
    _logoCache = '';
    console.warn('[RENDER] no encontré ' + LOGO_PATH + ' — uso el logo embebido de la plantilla');
  }
  return _logoCache;
}

/**
 * Render de reporte determinístico.
 * La IA YA NO genera HTML: devuelve SOLO el objeto `data` (ver schema abajo).
 * Esta función pega ese data en template.html (diseño fijo) -> HTML final.
 *
 * Schema de `data` (lo que devuelve el gen):
 * {
 *   empresa, fecha, eyebrow, h1_pre, h1_company, h1_post, lead, proof,
 *   ribbon:  [{label, value}]   x5,
 *   stats:   [{num, label}]     x4,
 *   icp:     [{title, desc}]    x4,
 *   context: [string]           x3,
 *   apertura:[string]           x3,
 *   prioridades:[string]        x4,
 *   cards:   [{ empresa, nombre, cargo, slug, urn, ubicacion, grado, angulo, hook, senales? }] x3
 *     senales (opcional, fase SIGNALS): [{ tipo, texto, fuente, fecha, url? }] — señales de compra CON fuente.
 *       url (opcional): link a la fuente, YA validado server-side contra los resultados reales de web_search.
 * }
 * Nota: `urn` es el member URN real (ACwAA...). El href usa urn; el texto visible usa slug.
 * Si urn viene vacío, cae al slug (compatibilidad).
 */

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _initials(nombre) {
  const p = String(nombre || '').trim().split(/\s+/);
  return ((p[0] && p[0][0] || '') + (p[1] && p[1][0] || '')).toUpperCase();
}

// Member URN opaco de LinkedIn (ACwAA.../ACoAA...). Los slugs públicos limpios nunca lo son.
function _isOpaque(s) {
  return /^AC[ow]AA[A-Za-z0-9_-]{6,}$/i.test(String(s || ''));
}

// Señales de compra por cuenta (opcional, vienen de la fase SIGNALS con fuente). Lista chica bajo la card.
// Si no hay señales (flag off o ninguna verificable), devuelve '' y la card queda idéntica a antes.
function _senalesCard(senales) {
  const arr = Array.isArray(senales) ? senales.filter(s => s && String(s.texto || '').trim()) : [];
  if (!arr.length) return '';
  const items = arr.slice(0, 2).map(s => {
    const tag = String(s.tipo || '').trim();
    const partes = [String(s.fuente || '').trim(), String(s.fecha || '').trim()].filter(Boolean).join(', ');
    // url: solo se linkea si vino validada del server (URL real de web_search). Saneo invisibles + exijo http(s).
    const url = String(s.url || '').replace(/[​-‍﻿­\s]/g, '');
    const urlOk = /^https?:\/\//i.test(url);
    let src = '';
    if (partes) {
      src = urlOk
        ? ' <span class="sig-src">(<a class="sig-link" href="' + _esc(url) + '">' + _esc(partes) + ' ↗</a>)</span>'
        : ' <span class="sig-src">(' + _esc(partes) + ')</span>';
    }
    return '      <li class="sig">' + (tag ? '<span class="sig-tag">' + _esc(tag) + '</span>' : '') +
      _esc(s.texto) + src + '</li>';
  }).join('\n');
  return '\n    <div class="angle-label">' + _esc(_L().senales) + '</div>\n    <ul class="acct-sigs">\n' + items + '\n    </ul>';
}

// Señales de compra DURAS (flags reales del MCP) como DISPARADORES visibles en la cuadrilla de cada lead.
// c.senalesVisibles = array de etiquetas (ej. "Recién asumió el rol", "Levantó financiamiento").
// Si no hay, devuelve '' y la card queda igual. NO incluye "activo en LinkedIn" (regla anti-creepy, se excluye en server).
// Peso comercial (mayor = más arriba y destacada), criterio del auditor GTM: financiamiento (plata + mandato)
// > decisor nuevo (ventana real de recompra) > contratando (condicional) > creciendo en plantilla (contexto).
const _PESO_SENAL = {
  'Levantó financiamiento': 6,   // la "reina": plata fresca + mandato de gastar
  'Recién asumió el rol': 5,     // señal de la PERSONA (es sobre ella) -> manda el ↑ cuando está
  'Cambio de liderazgo': 4,      // señal de EMPRESA
  'Está contratando': 3,
  'Creciendo en plantilla': 2,
};
// ---------------------------------------------------------------------------
// I18N DE RÓTULOS FIJOS: el contenido (lead, ICP, ángulos) lo traduce el PLAN/SELECT por idioma; estos son
// los rótulos del ANDAMIAJE (secciones, footer, señales-con-contexto, puente). El idioma del DOCUMENTO viaja
// en data._idioma (lo setea el server desde el store del job). Default 'es'. _LANG se fija al inicio de
// renderReport (render es síncrono, así que un módulo-level es seguro). Las señales llevan su "(por qué importa)"
// genérico (feedback Diego), sin sobre-afirmar que van a comprar (anti-invención).
const _LBL = {
  es: {
    val_intro:'Así entendimos su negocio antes de buscar. Si algo no encaja, lo ajustamos en una llamada.',
    como:'Cómo lo entendimos', icp:'Tu cliente ideal', decisor:'Decisor', industrias:'Industrias', geografia:'Geografía', tamano:'Tamaño',
    modelo:'Modelo', vertical:'Vertical', porque:'Por qué ahora', senales_col:'Señales a tener en cuenta', senal:'Señal de compra.', pain:'Pain primario.',
    contexto:'Contexto de mercado', empezar:'Por dónde empezar', anti:'A quién no apuntamos', senales:'Señales', mensaje:'Mensaje para enviar',
    guia:'Este es tu diagnóstico: a quién apuntar, qué señales mirar, cómo está el mercado y por dónde empezar. Al final, los 3 clientes potenciales.',
    analisis:'Análisis de Mercado', pagina:'Página', verperfil:'Ver perfil en LinkedIn ↗', proofLbl:'Respaldo',
    clientesN:n=>`Clientes potenciales · 01 — ${n}`, cliente1:'Cliente potencial · 01',
    universo:(geo,k)=>`Encontramos varios decisores que encajan con este perfil${geo?(' en '+geo):''}. En esta ocasión, te mostramos ${k} potenciales clientes.`,
    senalCtx:{
      'Levantó financiamiento':'Levantó financiamiento (tiene presupuesto fresco: buen momento para proponerle)',
      'Recién asumió el rol':'Decisor nuevo en el cargo (al llegar suele redefinir proveedores)',
      'Cambio de liderazgo':'Cambio de liderazgo en su empresa (el nuevo equipo revisa proveedores)',
      'Está contratando':'Está contratando (está creciendo: buen momento para entrar)',
      'Creciendo en plantilla':'Creciendo en plantilla (su operación está escalando)',
    },
  },
  en: {
    val_intro:'This is how we understood your business before sourcing. If something is off, we adjust it on a call.',
    como:'How we understood it', icp:'Your ideal customer', decisor:'Decision-maker', industrias:'Industries', geografia:'Geography', tamano:'Company size',
    modelo:'Model', vertical:'Vertical', porque:'Why now', senales_col:'Signals to watch', senal:'Buying signal.', pain:'Primary pain.',
    contexto:'Market context', empezar:'Where to start', anti:'Who we are not targeting', senales:'Signals', mensaje:'Message to send',
    guia:'This is your diagnosis: who to target, what signals to watch, how the market looks, and where to start. At the end, your 3 potential customers.',
    analisis:'Market Analysis', pagina:'Page', verperfil:'View LinkedIn profile ↗', proofLbl:'Track record',
    clientesN:n=>`Prospects · 01 — ${n}`, cliente1:'Prospect · 01',
    universo:(geo,k)=>`We found several decision-makers matching this profile${geo?(' in '+geo):''}. This time, we are showing you ${k} potential customers.`,
    senalCtx:{
      'Levantó financiamiento':'Raised funding (fresh budget: good time to pitch)',
      'Recién asumió el rol':'New in the role (usually redefines vendors on arrival)',
      'Cambio de liderazgo':'Leadership change (the new team reviews vendors)',
      'Está contratando':'Hiring (growing: good time to reach out)',
      'Creciendo en plantilla':'Growing headcount (operation scaling up)',
    },
  },
  pt: {
    val_intro:'Foi assim que entendemos o seu negócio antes de buscar. Se algo não encaixa, ajustamos numa ligação.',
    como:'Como entendemos', icp:'Seu cliente ideal', decisor:'Decisor', industrias:'Indústrias', geografia:'Geografia', tamano:'Tamanho',
    modelo:'Modelo', vertical:'Vertical', porque:'Por que agora', senales_col:'Sinais a considerar', senal:'Sinal de compra.', pain:'Dor principal.',
    contexto:'Contexto de mercado', empezar:'Por onde começar', anti:'A quem não miramos', senales:'Sinais', mensaje:'Mensagem para enviar',
    guia:'Este é o seu diagnóstico: quem mirar, que sinais observar, como está o mercado e por onde começar. No final, os 3 clientes potenciais.',
    analisis:'Análise de Mercado', pagina:'Página', verperfil:'Ver perfil no LinkedIn ↗', proofLbl:'Histórico',
    clientesN:n=>`Clientes potenciais · 01 — ${n}`, cliente1:'Cliente potencial · 01',
    universo:(geo,k)=>`Encontramos vários decisores que encaixam neste perfil${geo?(' em '+geo):''}. Nesta ocasião, mostramos ${k} clientes potenciais.`,
    senalCtx:{
      'Levantó financiamiento':'Captou investimento (orçamento novo: bom momento para propor)',
      'Recién asumió el rol':'Novo no cargo (costuma redefinir fornecedores ao chegar)',
      'Cambio de liderazgo':'Mudança de liderança (o novo time revisa fornecedores)',
      'Está contratando':'Está contratando (crescendo: bom momento para contatar)',
      'Creciendo en plantilla':'Crescendo em quadro (operação em expansão)',
    },
  },
};
let _LANG = 'es';
function _L(){ return _LBL[_LANG] || _LBL.es; }
function _senalesBadges(senalesVisibles) {
  const arr = Array.isArray(senalesVisibles) ? senalesVisibles.filter(s => String(s || '').trim()) : [];
  if (!arr.length) return '';
  // Orden por peso comercial (desc). Mostramos hasta 4: TODAS las señales reales que tenga la card (no
  // inventamos; si solo hay 1, va 1). La más fuerte destacada (↑), el resto tenue (●).
  const top = arr.slice().sort((a, b) => (_PESO_SENAL[b] || 1) - (_PESO_SENAL[a] || 1)).slice(0, 4);
  const flags = top.map(s => '<div class="sig-flag">' + _esc(_L().senalCtx[s] || s) + '</div>').join('');
  return '\n    <div class="sig-flags">' + flags + '</div>';
}

// Genera el <article> de UNA card. Las cards se renderizan por código (NO por la IA) desde
// data.cards, así el reporte se adapta a 1, 2 o 3 cuentas sin recuadros vacíos. La estructura
// HTML es idéntica a la que tenía el template fijo, para no cambiar el diseño de un reporte de 3.
function _cardArticle(c, i) {
  c = c || {};
  const n = i + 1;
  const num = String(n).padStart(2, '0');
  const urn  = String(c.urn  || '').replace(/[​-‍﻿­\s]/g, '');
  const slug = String(c.slug || '').replace(/[​-‍﻿­\s]/g, '');
  const href = urn || slug;
  const vis = (slug && !_isOpaque(slug)) ? slug : '';
  const linktext = vis ? ('linkedin.com/in/' + vis) : _L().verperfil;
  // Empresa + ubicación + grado = METADATO (la persona/empresa van chicas; la SEÑAL manda).
  const meta = [c.empresa, c.ubicacion, c.grado].map(x => String(x || '').trim()).filter(Boolean).map(_esc).join(' · ');
  return `  <article class="acct">
    <div class="acct-head">
      <span class="acct-num">${num}</span>
      <div class="acct-id">
        <div class="nm">${_esc(c.nombre)} <span class="role">· ${_esc(c.cargo)}</span></div>
        <div class="meta">${meta}${meta ? ' · ' : ''}<a class="lk" href="https://www.linkedin.com/in/${_esc(href)}">${_esc(linktext)}</a></div>
      </div>
    </div>${_senalesBadges(c.senalesVisibles)}
    <div class="angle-label">${_esc(_L().porque)}</div>
    <p class="angle">${_esc(c.angulo)}</p>${_senalesCard(c.senales)}
    <div class="angle-label">${_esc(_L().mensaje)}</div>
    <p class="acct-hook">${_esc(c.hook)}</p>
  </article>`;
}

function flatten(data) {
  const f = {};
  const scalars = ['empresa', 'fecha', 'eyebrow', 'h1_pre', 'h1_company', 'h1_post', 'lead', 'proof'];
  scalars.forEach(k => { f[k] = data[k]; });

  (data.ribbon || []).forEach((r, i) => { f[`ribbon${i + 1}_label`] = r.label; f[`ribbon${i + 1}_value`] = r.value; });
  (data.stats || []).forEach((s, i) => { f[`stat${i + 1}_num`] = s.num; f[`stat${i + 1}_label`] = s.label; });
  (data.icp || []).forEach((c, i) => { f[`icp${i + 1}_title`] = c.title; f[`icp${i + 1}_desc`] = c.desc; });
  (data.context || []).forEach((c, i) => { f[`context${i + 1}`] = c; });
  (data.apertura || []).forEach((c, i) => { f[`apertura${i + 1}`] = c; });
  (data.prioridades || []).forEach((c, i) => { f[`prio${i + 1}`] = c; });

  // HOJA DE VALIDACIÓN (página 1): industrias objetivo como lista, derivado del ICP interno (_plan).
  // El anti-ICP ("a quién NO apuntamos") se inyecta como sección completa en renderReport ({{anti_icp_html}}),
  // para no dejar un encabezado con cuerpo en blanco cuando el PLAN no trae verticales_excluir.
  const _icp = (data && data._plan) || {};
  f['industrias_list'] = Array.isArray(_icp.industrias) ? _icp.industrias.filter(Boolean).join(' · ') : '';

  // RÓTULOS FIJOS de página 1, según idioma del documento (_LANG ya fijado en renderReport).
  const L = _L();
  f['lbl_val_intro']=L.val_intro; f['lbl_como']=L.como; f['lbl_icp']=L.icp;
  f['lbl_decisor']=L.decisor; f['lbl_industrias']=L.industrias; f['lbl_geografia']=L.geografia; f['lbl_tamano']=L.tamano;
  f['lbl_modelo']=L.modelo; f['lbl_vertical']=L.vertical; f['lbl_porque']=L.porque; f['lbl_senales_col']=L.senales_col;
  f['lbl_guia']=L.guia;
  f['lbl_senal']=L.senal; f['lbl_pain']=L.pain; f['lbl_contexto']=L.contexto; f['lbl_empezar']=L.empezar;
  f['lbl_analisis']=L.analisis; f['lbl_pagina']=L.pagina;

  (data.cards || []).forEach((c, i) => {
    const n = i + 1;
    // saneo invisibles (zero-width, etc.) que rompen el link aunque no se vean
    const urn  = String(c.urn  || '').replace(/[\u200B-\u200D\uFEFF\u00AD\s]/g, '');
    const slug = String(c.slug || '').replace(/[\u200B-\u200D\uFEFF\u00AD\s]/g, '');
    f[`card${n}_empresa`]   = c.empresa;
    f[`card${n}_initials`]  = _initials(c.nombre);
    f[`card${n}_nombre`]    = c.nombre;
    f[`card${n}_cargo`]     = c.cargo;
    f[`card${n}_urn`]       = urn || slug;   // href: URN real; fallback slug
    f[`card${n}_slug`]      = slug;          // (compat, ya no se usa en el template)
    // Texto visible del link: slug limpio -> "linkedin.com/in/slug"; opaco/vacío -> label limpio
    const vis = (slug && !_isOpaque(slug)) ? slug : '';
    f[`card${n}_linktext`]  = vis ? ('linkedin.com/in/' + vis) : 'Ver perfil en LinkedIn ↗';
    f[`card${n}_ubicacion`] = c.ubicacion;
    f[`card${n}_grado`]     = c.grado;
    f[`card${n}_angulo`]    = c.angulo;
    f[`card${n}_hook`]      = c.hook;
  });
  return f;
}

// Señales de mercado REALES (de sourceCandidates/MCP, no IA): fila de número + etiqueta.
// Si no hay señales, devuelve '' (no rompe; queda solo el contexto cualitativo).
function _senalesHtml(senales) {
  const arr = Array.isArray(senales) ? senales.filter(s => s && s.label && String(s.value == null ? '' : s.value).trim()) : [];
  if (!arr.length) return '';
  const items = arr.map(s => `    <div class="ms"><div class="ms-v">${_esc(s.value)}</div><div class="ms-l">${_esc(s.label)}</div></div>`).join('\n');
  return `  <div class="mkt-signals">\n${items}\n  </div>`;
}

function renderReport(data, templatePath) {
  templatePath = templatePath || path.join(__dirname, 'template.html');
  // IDIOMA del documento (lo trae el server en data._idioma desde el store del job). Default español.
  _LANG = (data && (data._idioma === 'en' || data._idioma === 'pt')) ? data._idioma : 'es';
  let html = fs.readFileSync(templatePath, 'utf8');
  const flat = flatten(data);
  for (const k of Object.keys(flat)) {
    html = html.split('{{' + k + '}}').join(_esc(flat[k]));
  }
  // Cards por código (NO por la IA), CON PAGINACIÓN: con señales web las cards son altas y NO entran 3 en
  // una hoja (297mm) -> 2 por página; sin señales entran todas en una sola. Cada página es una <section
  // class="page"> propia con header/footer y número correcto (auto-calculado), así una card nunca se parte
  // ni se desborda a una página fantasma con el pie mal numerado.
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const cardsHead = cards.length > 1
    ? _L().clientesN(String(cards.length).padStart(2, '0'))
    : _L().cliente1;
  const conSenales = cards.some(c => Array.isArray(c.senales) && c.senales.length);
  const perPage = conSenales ? 2 : (cards.length || 1);
  const chunks = [];
  for (let i = 0; i < cards.length; i += perPage) chunks.push(cards.slice(i, i + perPage));
  const totalPages = 1 + (chunks.length || 1);   // página 1 (overview) + páginas de cards
  const fecha = _esc(data.fecha || '');
  const empresaEsc = _esc(data.empresa || '');
  const LOGO = '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" alt="IBT">';
  const cardsPages = chunks.map((chunk, ci) => {
    const start = ci * perPage;
    const cardsHtml = chunk.map((c, j) => _cardArticle(c, start + j)).join('\n');
    const head = ci === 0 ? ('\n  <div class="cards-head">' + _esc(cardsHead) + '</div>') : '';
    return `<section class="page">
  <header class="page-header">
    <div class="logo-pill">${LOGO}</div>
    <span class="doc-date">${fecha}</span>
  </header>${head}
  <div class="cards-wrap">
${cardsHtml}
  </div>
  <footer class="page-footer"><span>Inbound-Tools.com ● ${_esc(_L().analisis)} · ${empresaEsc}</span><span>${_esc(_L().pagina)} ${2 + ci} / ${totalPages}</span></footer>
</section>`;
  }).join('\n');
  html = html.split('{{cards_pages}}').join(cardsPages);
  html = html.split('{{total_pages}}').join(String(totalPages));
  // Señales de mercado reales (inyección CRUDA, es HTML). Vacío si no hay señales.
  html = html.split('{{senales_html}}').join(_senalesHtml(data.senales));
  // PUENTE DE VENTA (universo -> muestra): "hay varios decisores con este perfil; estos son los 3
  // prioritarios". Convierte el diagnóstico en inventario (las 3 cards = muestra de algo más grande).
  // El CONTEO NO SE MUESTRA (decisión del dueño): un número exacto tipo "90 decisores" invita a discutir
  // el número en vez de los leads. Igual seguimos EXIGIENDO que el conteo real exista (`_s0`) para hacer
  // la afirmación: si la búsqueda no devolvió ningún conteo, no decimos "hay varios" (misma regla de
  // certeza que el resto del reporte: el nivel de afirmación iguala al de la fuente). Vacío si no hay conteo.
  const _s0 = (Array.isArray(data.senales) ? data.senales.find(s => s && String(s.value == null ? '' : s.value).trim()) : null);
  const _geoU = _esc((data.ribbon && data.ribbon[1] && data.ribbon[1].value) || '');
  const universoHtml = _s0
    ? `  <p class="puente">${_L().universo(_geoU, cards.length)}</p>`
    : '';
  html = html.split('{{universo_html}}').join(universoHtml);
  // A QUIÉN NO APUNTAMOS (anti-ICP): sección COMPLETA o vacía si el PLAN no trae verticales_excluir
  // (no dejamos un encabezado con cuerpo en blanco). Datos del ICP interno (_plan).
  const _excl = (data && data._plan && Array.isArray(data._plan.verticales_excluir)) ? data._plan.verticales_excluir.filter(Boolean) : [];
  const antiIcpHtml = _excl.length
    ? `  <div class="sec-label">${_esc(_L().anti)}</div>\n  <p class="anti">${_esc(_excl.join(' · '))}</p>`
    : '';
  html = html.split('{{anti_icp_html}}').join(antiIcpHtml);
  // PROOF POINT (respaldo del cliente): clientes/marcas reales con las que trabaja (lo genera el PLAN en `proof`).
  // Da credibilidad y deja que el juez VERIFIQUE las referencias que un hook pueda citar (evita falso positivo de
  // "dato inventado"). Vacío si el PLAN no trae proof (research sin casos). Va bajo la apertura.
  const _proof = String((data && data.proof) || '').trim();
  const proofHtml = _proof ? `  <p class="respaldo"><b>${_esc(_L().proofLbl)}</b> ${_esc(_proof)}</p>` : '';
  html = html.split('{{proof_html}}').join(proofHtml);

  // Logo del repo: pisa el base64 embebido en TODAS las páginas (flag g) si el archivo existe.
  const logo = _logoDataUri();
  if (logo) html = html.replace(/src="data:image\/png;base64,[A-Za-z0-9+/=]+"/g, () => 'src="' + logo + '"');
  // Seguridad: si el gen entregó menos cards de las esperadas (p.ej. 2 en vez de 3),
  // no dejes {{...}} crudos en el PDF. Logueá cuáles faltaron y blanqueá.
  const leftover = html.match(/\{\{[^}]+\}\}/g);
  if (leftover && leftover.length) {
    console.warn('[RENDER] placeholders sin datos (' + leftover.length + '): ' + [...new Set(leftover)].join(', '));
    html = html.replace(/\{\{[^}]+\}\}/g, '');
  }
  return html;
}

module.exports = { renderReport, flatten, _initials, _esc };
