/**
 * REGISTRO DE ANÁLISIS EN GOOGLE SHEET — Web App para el IBT GTM Report Service + Delta Teams.
 *
 * Recibe una fila por cada análisis (el server la manda a SHEET_WEBHOOK_URL) y la agrega a la hoja.
 * MULTI-PESTAÑA: el server puede mandar "hoja":"Delta" y la fila va a esa pestaña con SUS columnas.
 * Sin "hoja" (el GTM de IBT no la manda) → pestaña 'Analisis', igual que siempre (retrocompatible).
 *
 * ─── CÓMO INSTALARLO / ACTUALIZARLO ───────────────────────────────────────────
 * 1. Abrí el Google Sheet del registro (o creá uno).
 * 2. Menú: Extensiones → Apps Script. Borrá lo que haya y pegá TODO este archivo.
 * 3. Deploy:
 *      - Primera vez: Implementar → Nueva implementación → "Aplicación web"
 *        (Ejecutar como: "Yo" · Acceso: "Cualquier persona") → copiá la URL /exec.
 *      - Actualización (ya tenías el script): Implementar → Administrar implementaciones →
 *        lápiz → Versión: "Nueva versión" → Implementar. LA URL NO CAMBIA.
 * 4. En Railway agregá/verificá: SHEET_WEBHOOK_URL = <esa URL /exec>.
 *    El MISMO webhook sirve para GTM y para Delta (Delta manda "hoja":"Delta").
 *
 * SEGURIDAD: la URL es larga e inadivinable, y los datos son metadatos del análisis (no PII pesada).
 * Si querés un candado extra: poné un TOKEN abajo y sumá "token":"loMismo" en el server (opcional).
 */

var SHEET_ID = '19c8FYt0cDcIQoBRhKCK5WzEW6QXUg4u6PdVA806Ln90';  // Sheet "Diagnosticos GTM IBT Gastos". Vacío ('') = usa la hoja donde pegaste el script.
var HOJA_DEFAULT = 'Analisis';   // pestaña cuando el server no manda "hoja" (GTM de IBT)
var TOKEN = '';                  // opcional: si lo llenás, el server tiene que mandar el mismo token

// Columnas POR PESTAÑA. Si llega una "hoja" que no está acá, se usa el layout GENERICO
// (las claves del payload en orden de llegada) para no perder datos.
var COLUMNAS_POR_HOJA = {
  'Analisis': ['fecha','empresa','dominio','estado','veredicto','score','apto_envio','cards','paginas','motivo','costo_usd','jobId'],
  'Delta':    ['fecha','empresa','dominio','estado','veredicto','score','apto_envio','lideres','costo_ineficiencia','paginas','motivo','costo_usd','jobId']
};

function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return _out('busy'); }   // evita choques con 2 análisis en paralelo
  try {
    var d = JSON.parse(e.postData.contents || '{}');
    if (TOKEN && d.token !== TOKEN) return _out('unauthorized');
    var hoja = String(d.hoja || HOJA_DEFAULT);
    var cols = COLUMNAS_POR_HOJA[hoja];
    if (!cols) {   // pestaña nueva sin layout definido: columnas = claves del payload (menos las de control)
      cols = Object.keys(d).filter(function (k) { return k !== 'hoja' && k !== 'token'; });
    }
    var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(hoja) || ss.insertSheet(hoja);
    if (sh.getLastRow() === 0) sh.appendRow(cols);   // encabezado la primera vez
    sh.appendRow(cols.map(function (c) { return d[c] !== undefined && d[c] !== null ? d[c] : ''; }));
    return _out('ok');
  } catch (err) {
    return _out('error: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function _out(s) { return ContentService.createTextOutput(s); }
