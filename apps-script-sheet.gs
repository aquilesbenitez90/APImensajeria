/**
 * REGISTRO DE ANÁLISIS EN GOOGLE SHEET — Web App para el IBT GTM Report Service.
 *
 * Recibe una fila por cada análisis (el server la manda a SHEET_WEBHOOK_URL) y la agrega a la hoja.
 * El server manda: fecha, empresa, dominio, estado, veredicto, score, apto_envio, cards, paginas,
 * motivo, costo_usd, jobId. Incluye TODOS los análisis (aprobados, rechazados y errores) con su costo.
 *
 * ─── CÓMO INSTALARLO (una sola vez) ───────────────────────────────────────────
 * 1. Abrí (o creá) el Google Sheet donde querés el registro.
 * 2. Menú: Extensiones → Apps Script. Borrá lo que haya y pegá TODO este archivo.
 * 3. (opcional) Si querés una hoja puntual, cambiá HOJA abajo.
 * 4. Deploy → Nueva implementación → Tipo: "Aplicación web".
 *      - Ejecutar como: "Yo".
 *      - Quién tiene acceso: "Cualquier persona".
 *    → Implementar → copiá la URL (termina en /exec).
 * 5. En Railway (servicio de la WEB, apimensajeria-copy) agregá la variable:
 *      SHEET_WEBHOOK_URL = <esa URL /exec>
 *    Guardá (Railway reinicia). Desde ese momento, cada análisis agrega una fila.
 *
 * SEGURIDAD: la URL es larga e inadivinable, y los datos son solo metadatos del análisis (no PII pesada).
 * Si querés un candado extra: poné un TOKEN abajo y sumá "token":"loMismo" en el server (opcional).
 */

var HOJA  = 'Analisis';   // nombre de la pestaña; se crea sola si no existe
var TOKEN = '';           // opcional: si lo llenás, el server tiene que mandar el mismo token

var COLUMNAS = ['fecha','empresa','dominio','estado','veredicto','score','apto_envio','cards','paginas','motivo','costo_usd','jobId'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return _out('busy'); }   // evita choques con 2 análisis en paralelo
  try {
    var d = JSON.parse(e.postData.contents || '{}');
    if (TOKEN && d.token !== TOKEN) return _out('unauthorized');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(HOJA) || ss.insertSheet(HOJA);
    if (sh.getLastRow() === 0) sh.appendRow(COLUMNAS);   // encabezado la primera vez
    sh.appendRow(COLUMNAS.map(function (c) { return d[c] !== undefined && d[c] !== null ? d[c] : ''; }));
    return _out('ok');
  } catch (err) {
    return _out('error: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function _out(s) { return ContentService.createTextOutput(s); }
