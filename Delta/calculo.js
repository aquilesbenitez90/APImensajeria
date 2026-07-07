// calculo.js — Motor determinístico del Diagnóstico ROI de Delta Teams.
// Todas las cifras del PDF salen de acá: la IA NUNCA escribe números de dinero.
// Fórmulas exactas del skill delta-roi-diagnostic (Paso 3) + proyección a 3 años (página 4).

// ── Supuestos base (del skill) ──────────────────────────────────────────────
const SEMANAS_ANIO = 48;
const FACTOR_CONSERVADOR = 0.60;
const FACTOR_OPTIMISTA = 0.80;
const CRECIMIENTO_ANUAL_DEFAULT = 0.12; // 12% anual, supuesto de la proyección
const HORAS_MIN = 5;
const HORAS_MAX = 8;

// ── Benchmarks de costo hora por país e industria (USD, del skill) ─────────
// La IA propone un valor con justificación; _clampCostoHora lo encierra en el
// rango del benchmark que corresponda. Si no matchea ninguno, rango global.
const BENCHMARKS_COSTO_HORA = [
  { paises: ['colombia', 'mexico'], industrias: ['saas', 'tech', 'software'], min: 35, max: 35 },
  { paises: ['argentina'], industrias: ['tech', 'logtech', 'log-tech', 'software', 'saas'], min: 30, max: 35 },
  { paises: ['peru'], industrias: ['inmobiliario', 'foodtech', 'real estate'], min: 35, max: 38 },
  { paises: ['chile'], industrias: ['fintech', 'retail'], min: 38, max: 40 },
  { paises: ['guatemala', 'honduras'], industrias: ['distribucion', 'agroindustria', 'agro'], min: 28, max: 28 },
  { paises: ['guatemala', 'honduras'], industrias: ['tech', 'gaming', 'multinacional'], min: 30, max: 45 },
  { paises: ['costa rica', 'el salvador'], industrias: ['operaciones', 'logistica'], min: 22, max: 32 },
  { paises: ['mexico'], industrias: ['multinacional', 'gaming'], min: 45, max: 55 },
  { paises: ['global', 'pe-backed'], industrias: ['c-level', 'internacional'], min: 45, max: 55 },
];
const RANGO_GLOBAL = { min: 22, max: 55 };

// ── Tabla de headcount de liderazgo estimado (SOLO fallback sin datos reales)
const TABLA_LIDERAZGO = [
  { hasta: 15, lideres: 3 },
  { hasta: 30, lideres: 4 },
  { hasta: 60, lideres: 6 },
  { hasta: 100, lideres: 8 },
  { hasta: 200, lideres: 12 },
  { hasta: Infinity, lideres: 15 },
];

// ── Helpers privados ────────────────────────────────────────────────────────
function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function _rangoCostoHora(pais, industria) {
  const p = _norm(pais);
  const i = _norm(industria);
  const candidatos = BENCHMARKS_COSTO_HORA.filter(b =>
    b.paises.some(bp => p.includes(bp)) &&
    b.industrias.some(bi => i.includes(bi))
  );
  if (candidatos.length) {
    return {
      min: Math.min(...candidatos.map(c => c.min)),
      max: Math.max(...candidatos.map(c => c.max)),
    };
  }
  // Solo país: unión de rangos de ese país
  const porPais = BENCHMARKS_COSTO_HORA.filter(b => b.paises.some(bp => p.includes(bp)));
  if (porPais.length) {
    return {
      min: Math.min(...porPais.map(c => c.min)),
      max: Math.max(...porPais.map(c => c.max)),
    };
  }
  return RANGO_GLOBAL;
}

// ── Guardas determinísticas sobre los supuestos que propone la IA ──────────
function clampCostoHora(valor, pais, industria) {
  const rango = _rangoCostoHora(pais, industria);
  const v = Number(valor);
  if (!Number.isFinite(v)) return rango.min;
  return Math.min(Math.max(v, rango.min), rango.max);
}

function clampHorasPerdidas(valor) {
  const v = Number(valor);
  if (!Number.isFinite(v)) return HORAS_MIN;
  return Math.min(Math.max(Math.round(v), HORAS_MIN), HORAS_MAX);
}

function liderazgoEstimado(headcountTotal) {
  const total = Number(headcountTotal) || 0;
  const fila = TABLA_LIDERAZGO.find(f => total <= f.hasta);
  return fila ? fila.lideres : 3;
}

// ── Formateo ────────────────────────────────────────────────────────────────
function formatearUSD(n) {
  return `$${Math.round(n).toLocaleString('en-US')} USD`;
}

// ── Cálculo principal (fórmulas exactas del skill) ─────────────────────────
function calcularROI({ headcountLeadership, costoHora, horasPerdidas }) {
  const semanal = headcountLeadership * costoHora * horasPerdidas;
  const mensual = semanal * 4;
  const anual = semanal * SEMANAS_ANIO;

  const ahorroConservadorMensual = mensual * FACTOR_CONSERVADOR;
  const ahorroConservadorAnual = ahorroConservadorMensual * 12;
  const ahorroOptimistaMensual = mensual * FACTOR_OPTIMISTA;
  const ahorroOptimistaAnual = ahorroOptimistaMensual * 12;

  return {
    semanal, mensual, anual,
    ahorroConservadorMensual, ahorroConservadorAnual,
    ahorroOptimistaMensual, ahorroOptimistaAnual,
  };
}

// Proyección a 3 años con crecimiento compuesto. Se redondea solo al mostrar;
// el acumulado suma los valores sin redondear (así cierran los totales del PDF).
function proyectar3Anios(baseAnual, crecimiento = CRECIMIENTO_ANUAL_DEFAULT) {
  const y1 = baseAnual;
  const y2 = y1 * (1 + crecimiento);
  const y3 = y2 * (1 + crecimiento);
  return { y1, y2, y3, total: y1 + y2 + y3 };
}

// ── Salida lista para el template ───────────────────────────────────────────
// Devuelve TODOS los placeholders numéricos del template-delta.html ya formateados.
function numerosParaTemplate({ headcountLeadership, costoHora, horasPerdidas, crecimiento = CRECIMIENTO_ANUAL_DEFAULT }) {
  const roi = calcularROI({ headcountLeadership, costoHora, horasPerdidas });
  const projSQ = proyectar3Anios(roi.anual, crecimiento);
  const projCons = proyectar3Anios(roi.ahorroConservadorAnual, crecimiento);
  const projOpt = proyectar3Anios(roi.ahorroOptimistaAnual, crecimiento);

  return {
    INEFF_COST_ANNUAL: formatearUSD(roi.anual),
    INEFF_COST_MONTHLY: formatearUSD(roi.mensual),
    SAVINGS_CONSERVATIVE_ANNUAL: formatearUSD(roi.ahorroConservadorAnual),
    SAVINGS_CONSERVATIVE_MONTHLY: formatearUSD(roi.ahorroConservadorMensual),
    SAVINGS_OPTIMISTIC_ANNUAL: formatearUSD(roi.ahorroOptimistaAnual),
    SAVINGS_OPTIMISTIC_MONTHLY: formatearUSD(roi.ahorroOptimistaMensual),

    PROJ_SQ_Y1: formatearUSD(projSQ.y1),
    PROJ_SQ_Y2: formatearUSD(projSQ.y2),
    PROJ_SQ_Y3: formatearUSD(projSQ.y3),
    PROJ_SQ_TOTAL: formatearUSD(projSQ.total),

    PROJ_CONS_Y1: formatearUSD(projCons.y1),
    PROJ_CONS_Y2: formatearUSD(projCons.y2),
    PROJ_CONS_Y3: formatearUSD(projCons.y3),
    PROJ_CONS_TOTAL: formatearUSD(projCons.total),

    PROJ_OPT_Y1: formatearUSD(projOpt.y1),
    PROJ_OPT_Y2: formatearUSD(projOpt.y2),
    PROJ_OPT_Y3: formatearUSD(projOpt.y3),
    PROJ_OPT_TOTAL: formatearUSD(projOpt.total),
  };
}

module.exports = {
  calcularROI,
  proyectar3Anios,
  numerosParaTemplate,
  formatearUSD,
  clampCostoHora,
  clampHorasPerdidas,
  liderazgoEstimado,
  BENCHMARKS_COSTO_HORA,
  _norm,
  _rangoCostoHora,
};
