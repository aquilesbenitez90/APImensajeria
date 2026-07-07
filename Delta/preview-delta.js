// preview-delta.js — Test local del template Delta SIN gastar Anthropic ni MCP.
// Rellena template-delta.html con la fixture Optimissa (fixture-optimissa.js), usa calculo.js
// para TODOS los números, renderiza con Puppeteer (mismas opciones que producción en server.js)
// y verifica: 0 placeholders sin reemplazar + PDF de 4 páginas + screenshots por página.
// Uso: node Delta/preview-delta.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { numerosParaTemplate } = require('./calculo.js');
const { renderDelta } = require('./render-delta.js');
const { supuestos, lookup, contenido } = require('./fixture-optimissa.js');

(async () => {
  const dir = __dirname;
  const data = { ...lookup, ...contenido, ...numerosParaTemplate(supuestos) };

  // Guarda 1: renderDelta tira error si queda algún placeholder vivo
  const html = renderDelta(data);
  console.log('[TEST] render OK: 0 placeholders sin reemplazar (' + Object.keys(data).length + ' claves aplicadas)');
  fs.writeFileSync(path.join(dir, 'PREVIEW-delta.html'), html);

  // PDF con las MISMAS opciones que producción (server.js renderizarPdf)
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Screenshots por página para inspección visual
    await page.setViewport({ width: 794, height: 1123 });
    const paginas = await page.$$('.page');
    for (let i = 0; i < paginas.length; i++) {
      await paginas[i].screenshot({ path: path.join(dir, `PREVIEW-delta-p${i + 1}.png`) });
    }
    console.log('[TEST] ' + paginas.length + ' screenshots guardados');

    const pdfBuffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    fs.writeFileSync(path.join(dir, 'PREVIEW-delta.pdf'), pdfBuffer);

    // Guarda 2: exactamente 4 páginas (DELTA_EXPECTED_PAGES)
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const n = pdfDoc.getPageCount();
    console.log('[TEST] PDF generado: ' + n + ' páginas (' + Math.round(pdfBuffer.length / 1024) + ' KB)');
    if (n !== 4) {
      console.error('FALLO: se esperaban 4 páginas, salieron ' + n + ' (¿desborde u hoja en blanco?)');
      process.exit(1);
    }
    console.log('TEST OK: PREVIEW-delta.pdf con 4 páginas exactas en ' + dir);
  } finally {
    await browser.close();
  }
})();
