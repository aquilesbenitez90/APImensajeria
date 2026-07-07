// render-delta.js — Pega el objeto data (claves = placeholders) en template-delta.html.
// Misma filosofía que render.js del GTM: la IA NUNCA genera HTML; acá solo se escapan
// strings y se insertan en la plantilla fija. Falla fuerte si queda algún placeholder vivo.
const fs = require('fs');
const path = require('path');

let _tplCache = null;
function _template() {
  if (_tplCache == null) _tplCache = fs.readFileSync(path.join(__dirname, 'template-delta.html'), 'utf8');
  return _tplCache;
}

function _esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderDelta(data) {
  let html = _template();
  for (const [k, v] of Object.entries(data)) {
    html = html.split(`{{${k}}}`).join(_esc(v));
  }
  const sueltos = html.match(/{{[A-Z0-9_]+}}/g);
  if (sueltos) throw new Error('renderDelta: placeholders sin datos: ' + [...new Set(sueltos)].join(', '));
  return html;
}

module.exports = { renderDelta, _esc };
