// Dev helper (throwaway, NO commitear): renderiza una muestra real a preview-cards.html
const fs = require('fs');
const { renderReport } = require('./render.js');
const cards = [
  { empresa:'Hush Puppies Argentina', nombre:'Daniela Pampillón', cargo:'Marketing Manager', slug:'daniela-pampillon', urn:'ACwAAAksmdwB', ubicacion:'Argentina', grado:'1er grado',
    angulo:'Gestiona la identidad de marca de Hush Puppies en sus tiendas en Argentina, donde la experiencia sonora puede marcar la diferencia en el punto de venta y subir el ticket promedio.',
    hook:'"Daniela, ¿ya tienen una estrategia sonora definida para las tiendas o lo manejan local por local?"' },
  { empresa:'Prüne', nombre:'María Constanza Katabian', cargo:'Líder de Marketing y Comunicación', slug:'maria-constanza-katabian', urn:'ACwAAExx2', ubicacion:'Argentina', grado:'2do grado',
    angulo:'Lidera marketing de Prüne, una marca con decenas de tiendas donde la coherencia de marca va mucho más allá del visual y la música es parte de esa experiencia.',
    hook:'"María Constanza, la música en tienda, ¿está alineada a la identidad de Prüne o queda en manos de cada local?"' },
  { empresa:'Sportline', nombre:'Samanta Melaj', cargo:'Jefa de marketing', slug:'samanta-melaj', urn:'ACwAAEzz3', ubicacion:'Argentina', grado:'2do grado',
    angulo:'Lidera marketing en Sportline, una cadena con más de 600 empleados donde la experiencia en tienda es clave para fidelizar al cliente y diferenciarse.',
    hook:'"Samanta, con la cantidad de tiendas que tiene Sportline, ¿unifican la experiencia sonora o cada local lo maneja por su cuenta?"' },
];
const data = {
  empresa:'Brandtrack', fecha:'Junio 2026', eyebrow:'Análisis de mercado · Música ambiental', h1_pre:'', h1_company:'Brandtrack',
  h1_post:'3 clientes potenciales en Argentina',
  lead:'Brandtrack es una plataforma SaaS de musicalización para espacios comerciales, con operación en más de 35 países.',
  proof:'Trabaja con marcas de retail, hotelería y gastronomía, con un modelo de suscripción mensual por local.',
  ribbon:[{label:'Vertical',value:'Música ambiental B2B'},{label:'País',value:'Argentina'},{label:'Modelo',value:'SaaS por sede'}],
  stats:[{num:'35+',label:'Países de operación'},{num:'3',label:'Cuentas priorizadas'},{num:'B2B',label:'Modelo'},{num:'SaaS',label:'Tipo de producto'}],
  icp:[{title:'Rol del decisor',desc:'Gerente de Marketing o Experiencia de Cliente en cadenas con múltiples sucursales.'},{title:'Tamaño',desc:'Cadenas con al menos 5 locales propios o franquiciados.'},{title:'Geografía',desc:'Argentina (prioritario), Chile y México.'},{title:'Vertical',desc:'Retail de moda, gastronomía, hotelería.'}],
  context:['El mercado de música ambiental B2B crece de forma sostenida en la región.','Las cadenas con múltiples locales enfrentan el reto de sincronizar la experiencia sonora.','La música licenciada evita el riesgo legal de usar plataformas de consumo.'],
  prioridades:['Alta: cadenas de retail de moda con red de tiendas','Alta: cadenas de gastronomía con varias sucursales','Media: hoteles y resorts de cadena','Media: operadores de centros comerciales'],
  senales:[
    {label:'Empresas del sector retail en Argentina', value:'≈8.400'},
    {label:'Con crecimiento de plantilla', value:'62'},
    {label:'Decisores de Marketing identificados', value:'310'},
    {label:'A un contacto de distancia (2do grado)', value:'48'},
  ],
  cards,
};
fs.writeFileSync('preview-cards.html', renderReport(data));
console.log('preview-cards.html regenerado con ' + cards.length + ' cards.');
