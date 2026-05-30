'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Render de reporte GTM determinístico.
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
 *   cards:   [{ empresa, nombre, cargo, slug, urn, ubicacion, grado, angulo, hook }] x6
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
    f[`card${n}_empresa`]   = c.empresa;
    f[`card${n}_initials`]  = _initials(c.nombre);
    f[`card${n}_nombre`]    = c.nombre;
    f[`card${n}_cargo`]     = c.cargo;
    f[`card${n}_urn`]       = c.urn || c.slug;   // href: URN real; fallback slug
    f[`card${n}_slug`]      = c.slug;            // texto visible
    f[`card${n}_ubicacion`] = c.ubicacion;
    f[`card${n}_grado`]     = c.grado;
    f[`card${n}_angulo`]    = c.angulo;
    f[`card${n}_hook`]      = c.hook;
  });
  return f;
}

function renderReport(data, templatePath) {
  templatePath = templatePath || path.join(__dirname, 'template.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  const flat = flatten(data);
  for (const k of Object.keys(flat)) {
    html = html.split('{{' + k + '}}').join(_esc(flat[k]));
  }
  // Seguridad: si el gen entregó menos items de los esperados (p.ej. 5 cards en vez de 6),
  // no dejes {{...}} crudos en el PDF. Logueá cuáles faltaron y blanqueá.
  const leftover = html.match(/\{\{[^}]+\}\}/g);
  if (leftover && leftover.length) {
    console.warn('[RENDER] placeholders sin datos (' + leftover.length + '): ' + [...new Set(leftover)].join(', '));
    html = html.replace(/\{\{[^}]+\}\}/g, '');
  }
  return html;
}

module.exports = { renderReport, flatten, _initials, _esc };
