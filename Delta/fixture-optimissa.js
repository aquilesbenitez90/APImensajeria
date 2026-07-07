// fixture-optimissa.js — Caso de referencia CONOCIDO (Optimissa México, el PDF de ejemplo del skill).
// Lo usan: preview-delta.js (test visual local) y el modo TEST del pipeline (plumbing n8n sin gastar).
// Las claves son EXACTAMENTE los placeholders del template; los montos NO están acá: salen de calculo.js
// con estos supuestos (8 líderes × $40/h × 6h), que reproducen las 16 cifras del PDF original.

const supuestos = { headcountLeadership: 8, costoHora: 40, horasPerdidas: 6 };

const lookup = {
  COMPANY_NAME: 'Optimissa México',
  COMPANY_INDUSTRY: 'IT Consulting / Capital Markets',
  COMPANY_HEADCOUNT_TOTAL: '100',
  COMPANY_HEADCOUNT_LEADERSHIP: '8',
  COMPANY_LOCATION: 'México',
  COMPANY_COUNTRY: 'México',
  REPORT_DATE: 'Junio 2026',
};

const contenido = {
  HEADLINE: 'Optimissa México: el costo de crecer sin infraestructura de ejecución',
  SUBHEADLINE: 'Cada semana, 8 líderes en Optimissa México absorben fricción operativa que no genera valor. Este diagnóstico cuantifica lo que eso cuesta, y lo que se recupera con Delta.',
  DIAGNOSIS_HEADING: 'El patrón del sector',
  DIAGNOSIS_BODY: 'Las consultoras IT en fase de escalamiento enfrentan una paradoja: cuanto más crece el portfolio de proyectos, más tiempo absorben los líderes en coordinación informal. Sin una capa común de ejecución, el Country Manager se convierte en el único punto de visibilidad, con un precio directo sobre la capacidad de venta, retención de clientes y expansión de cuentas. Optimissa México tiene el modelo y el mandato de ser el hub LATAM de Alten Group. El cuello de botella no es comercial ni técnico: es operativo.',
  BENCHMARK_NOTA: 'Estimación basada en benchmark operativo para consultoras IT Capital Markets en fase de escalamiento en México.',

  INEFF_1_TITLE: 'CEO como único punto de coordinación',
  INEFF_1_DESC: 'El Country Manager centraliza decisiones de entrega, cliente y equipo que deberían resolverse en la capa siguiente. Cada escalada consume tiempo que debería ir a expansión de cuentas y relación con Alten Group.',
  INEFF_2_TITLE: 'Proyectos sin seguimiento estructurado',
  INEFF_2_DESC: 'Con un portfolio multicliente y multitecnología (SAP, Murex, Calypso, desarrollo a medida), el avance de iniciativas se gestiona por reuniones reactivas y actualizaciones individuales, sin visibilidad centralizada.',
  INEFF_3_TITLE: 'Objetivos sin dueño claro ni revisión semanal',
  INEFF_3_DESC: 'La meta de escalar a 500 personas y consolidar el hub LATAM requiere OKRs con dueños y cadencia. Sin esa estructura, los líderes de área operan con agendas desconectadas de la estrategia de crecimiento.',
  INEFF_4_TITLE: 'Estrategia global sin traducción a ejecución local',
  INEFF_4_DESC: 'Optimissa forma parte de Alten Group desde 2018. Alinear la estrategia del grupo con la operación diaria en México exige mecanismos de ejecución que hoy se resuelven con reuniones manuales y reportes ad hoc.',

  TIMEBARS_HEADING: 'Distribución del tiempo redirigible en líderes IT Consulting',
  BAR_1_LABEL: 'Coordinación entre proyectos y clientes', BAR_1_PCT: '38',
  BAR_2_LABEL: 'Reuniones sin decisión documentada', BAR_2_PCT: '27',
  BAR_3_LABEL: 'Re-trabajo por falta de visibilidad común', BAR_3_PCT: '21',
  BAR_4_LABEL: 'Aprobaciones que escalan al Country Manager', BAR_4_PCT: '14',

  REF_NAME: 'Softtek',
  REF_DESC: 'Líder IT Consulting de origen mexicano · +14,000 personas · 20+ países · fundada en Monterrey en 1982',
  REF_METRIC_1_LABEL: 'Escala global', REF_METRIC_1_VALUE: '14,000+',
  REF_METRIC_2_LABEL: 'Revenue estimado', REF_METRIC_2_VALUE: '$500M+ USD',
  REF_METRIC_3_LABEL: 'Países de operación', REF_METRIC_3_VALUE: '20+',
  REF_METRIC_4_LABEL: 'Años en mercado', REF_METRIC_4_VALUE: '43 años',
  REF_NARRATIVA: 'Softtek no llegó a los 14,000 profesionales por tener mejor tecnología que sus competidores. Lo hizo construyendo una capa de ejecución que permitió escalar cuentas, replicar modelos de entrega y crecer de forma previsible. Optimissa México tiene el mandato de ser el hub LATAM de Alten Group: la misma ambición que tuvo Softtek en sus primeras dos décadas. La diferencia entre ambas no es de tamaño: es de infraestructura operativa para sostener el crecimiento.',
  REF_FUENTE: '',

  GAP_1_DIM: 'Personas en operación', GAP_1_PROSPECT: '~100 en México', GAP_1_REF: '14,000+ global',
  GAP_2_DIM: 'Cobertura geográfica', GAP_2_PROSPECT: 'México + Europa (vía Alten)', GAP_2_REF: '20+ países independientes',
  GAP_3_DIM: 'Visibilidad de objetivos', GAP_3_PROSPECT: 'Gestionada por reuniones reactivas', GAP_3_REF: 'OKRs con dashboards por unidad',
  GAP_4_DIM: 'Velocidad de decisión', GAP_4_PROSPECT: 'Centralizada en Country Manager', GAP_4_REF: 'Delegada por capa y región',
  GAP_5_DIM: 'Escalabilidad de delivery', GAP_5_PROSPECT: 'Modelo proyecto a proyecto', GAP_5_REF: 'Modelo de entrega replicable',
  GAP_6_DIM: 'Retención de talento lider', GAP_6_PROSPECT: 'Sin métricas de performance por rol', GAP_6_REF: '81.7% retención con estructura definida',
  GAP_CLOSING_BODY: 'Softtek tiene 140 veces más personas que Optimissa México, pero eso no explica la diferencia operativa. Softtek construyó sus primeros 500 empleados con una metodología de ejecución clara antes de escalar. Optimissa México está en ese punto de inflexión hoy: el momento en que la coordinación informal deja de funcionar y cada semana sin estructura de ejecución tiene un costo directo sobre la velocidad de crecimiento.',

  PLAN_INTRO: 'Dos OKRs diseñados para cerrar las brechas operativas identificadas. Cada KR incluye el estado actual de Optimissa México, la meta a 90 días y el benchmark del referente sectorial.',
  OKR_1_OBJETIVO: 'Instalar visibilidad operativa y liberar capacidad del Country Manager',
  OKR_1_KR_1: '% de proyectos con avance visible en dashboard centralizado', OKR_1_HOY_1: '0%', OKR_1_META_1: '80%', OKR_1_REF_1: '95%+',
  OKR_1_KR_2: 'Decisiones que escalan al Country Manager por semana', OKR_1_HOY_2: '15-20', OKR_1_META_2: '6 o menos', OKR_1_REF_2: '2-3',
  OKR_1_KR_3: 'Líderes con OKRs asignados y revisión semanal activa', OKR_1_HOY_3: '0 de 8', OKR_1_META_3: '8 de 8', OKR_1_REF_3: '100%',
  OKR_2_OBJETIVO: 'Acelerar ejecución y preparar el modelo para escala LATAM',
  OKR_2_KR_1: 'Avance promedio en objetivos estratégicos del trimestre', OKR_2_HOY_1: '<40%', OKR_2_META_1: '65%+', OKR_2_REF_1: '61.4% (IBT)',
  OKR_2_KR_2: 'Reducción en horas de reuniones sin decisión documentada', OKR_2_HOY_2: 'Línea base', OKR_2_META_2: '-30%', OKR_2_REF_2: '-40%',
  OKR_2_KR_3: 'Modelo de delivery documentado y replicable para nuevas cuentas', OKR_2_HOY_3: 'Informal', OKR_2_META_3: 'V1 activo', OKR_2_REF_3: 'Estandarizado',

  BENEFIT_1_TITLE: 'Reuniones con decisiones documentadas',
  BENEFIT_1_DESC: 'Cada sesión genera acuerdos trazables. El Country Manager deja de ser el repositorio de contexto y pasa a ser el validador de dirección.',
  BENEFIT_2_TITLE: 'Dashboard unificado de objetivos en tiempo real',
  BENEFIT_2_DESC: 'Visibilidad del avance por proyecto, por líder y por cuenta, sin entrar a la operación ni multiplicar reportes manuales.',

  PROJ_NOTA: 'Supuesto: crecimiento del 12% anual en el costo de ineficiencia, en línea con el crecimiento del sector IT Consulting en México 2024-2025 y el plan de escalamiento de Optimissa México hacia las 500 personas. No incluye el costo de oportunidad por velocidad de ejecución perdida.',
  QUOTE: 'En IT consulting, el riesgo no está en perder un proyecto. Está en llegar al doble de personas sin haber construido la capa que convierte la coordinación en resultados predecibles, porque a esa escala, el costo de la fricción deja de ser invisible.',
  CTA_HEADING: 'Cada semana sin visibilidad tiene un costo en Optimissa México. Veamos cómo cerrarlo.',
  CTA_BODY: 'Revisa el diagnóstico con Camila en 20 minutos y explora qué dimensión de la operación tiene más urgencia para Optimissa México.',
};

module.exports = { supuestos, lookup, contenido };
