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
 *     senales (opcional, fase SIGNALS): [{ tipo, texto, fuente, fecha }] — señales de compra CON fuente.
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
  const items = arr.slice(0, 3).map(s => {
    const tag = String(s.tipo || '').trim();
    const src = [String(s.fuente || '').trim(), String(s.fecha || '').trim()].filter(Boolean).join(', ');
    return '      <li class="sig">' + (tag ? '<span class="sig-tag">' + _esc(tag) + '</span>' : '') +
      _esc(s.texto) + (src ? ' <span class="sig-src">(' + _esc(src) + ')</span>' : '') + '</li>';
  }).join('\n');
  return '\n    <div class="angle-label">Señales</div>\n    <ul class="acct-sigs">\n' + items + '\n    </ul>';
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
// Reetiquetado de PRESENTACIÓN: "Cambio de liderazgo" es una señal de EMPRESA (seniorLeadershipChanges del
// MCP, binaria a nivel compañía). En la card de una persona implicaría que cambió ELLA, lo cual es dudoso
// (un fundador no "cambió de liderazgo"; su empresa sí). Lo aclaramos. El resto ya se lee como nivel-empresa.
const _LABEL_SENAL = {
  'Cambio de liderazgo': 'Cambio de liderazgo en su empresa',
};
function _senalesBadges(senalesVisibles) {
  const arr = Array.isArray(senalesVisibles) ? senalesVisibles.filter(s => String(s || '').trim()) : [];
  if (!arr.length) return '';
  // Orden por peso comercial (desc). Mostramos hasta 4: TODAS las señales reales que tenga la card (no
  // inventamos; si solo hay 1, va 1). La más fuerte destacada (↑), el resto tenue (●).
  const top = arr.slice().sort((a, b) => (_PESO_SENAL[b] || 1) - (_PESO_SENAL[a] || 1)).slice(0, 4);
  const flags = top.map(s => '<div class="sig-flag">' + _esc(_LABEL_SENAL[s] || s) + '</div>').join('');
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
  const linktext = vis ? ('linkedin.com/in/' + vis) : 'Ver perfil en LinkedIn ↗';
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
    <div class="angle-label">Por qué ahora</div>
    <p class="angle">${_esc(c.angulo)}</p>${_senalesCard(c.senales)}
    <p class="acct-hook">→ ${_esc(c.hook)}</p>
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
  let html = fs.readFileSync(templatePath, 'utf8');
  const flat = flatten(data);
  for (const k of Object.keys(flat)) {
    html = html.split('{{' + k + '}}').join(_esc(flat[k]));
  }
  // Cards por código (NO por la IA): se generan desde data.cards, así el reporte se adapta a 1, 2 o 3
  // cuentas sin dejar recuadros vacíos. cards_html va CRUDO (es HTML, no se escapa).
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const cardsHtml = cards.map(_cardArticle).join('\n');
  const cardsHead = cards.length > 1
    ? ('Clientes potenciales · 01 — ' + String(cards.length).padStart(2, '0'))
    : 'Cliente potencial · 01';
  html = html.split('{{cards_html}}').join(cardsHtml);
  html = html.split('{{cards_head}}').join(_esc(cardsHead));
  // Señales de mercado reales (inyección CRUDA, es HTML). Vacío si no hay señales.
  html = html.split('{{senales_html}}').join(_senalesHtml(data.senales));

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
