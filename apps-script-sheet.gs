/**
 * REGISTRO DE ANÁLISIS EN GOOGLE SHEET — Web App para el IBT GTM Report Service.
 *
 * Recibe una fila por cada análisis (el server la manda a SHEET_WEBHOOK_URL) y la agrega a la hoja.
 * El server manda: fecha, empresa, dominio, estado, veredicto, score, apto_envio, cards, paginas,
 * motivo, costo_usd, jobId, usuario (quién lo generó, del login con Google). Incluye TODOS los análisis
 * (aprobados, rechazados y errores) con su costo. El script agrega 'repetido' (SI/NO): misma persona +
 * misma empresa que una fila anterior. Para CONTAR diagnósticos: filtrar repetido = NO y estado = ok.
 *
 * ─── SI YA ESTABA INSTALADO Y CAMBIÓ ESTE ARCHIVO (ej. columna nueva) ─────────
 * Pegá el archivo entero de nuevo y después: Deploy → Administrar implementaciones → lápiz (editar) →
 * Versión: "Nueva versión" → Implementar. La URL /exec NO cambia (no hay que tocar Railway). Un Web App
 * sigue corriendo la versión vieja hasta que se publica una nueva; con solo guardar el código no alcanza.
 * El encabezado de la hoja se actualiza solo en la próxima fila que llegue.
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

var SHEET_ID = '19c8FYt0cDcIQoBRhKCK5WzEW6QXUg4u6PdVA806Ln90';  // Sheet "Diagnosticos GTM IBT Gastos". Vacío ('') = usa la hoja donde pegaste el script.
var HOJA  = 'Analisis';   // nombre de la pestaña; se crea sola si no existe
var TOKEN = '';           // opcional: si lo llenás, el server tiene que mandar el mismo token

// 'usuario' = quién generó el diagnóstico (nombre <email> del login con Google). El server lo manda desde el
// commit 9b2613b; sin esta columna acá, el dato llegaba y se descartaba.
// 'repetido' = SI cuando la MISMA persona ya tenía una fila con la MISMA empresa (misma regla que el
// leaderboard: "/about" y "/home" son la misma empresa). La fila NO se borra (es el registro de gastos,
// el costo se pagó igual): se marca, y para contar diagnósticos se filtra repetido = NO.
var COLUMNAS = ['fecha','empresa','dominio','estado','veredicto','score','apto_envio','cards','paginas','motivo','costo_usd','jobId','usuario','repetido'];

// Misma normalización que _leadKeyDiag en server.js: profileId > dominio > empresa, sin protocolo/www,
// sin "/about", "/home", "/posts"..., sin barra final. Todo en minúsculas.
function _claveEmpresa(d) {
  var k = String(d.profileId || d.dominio || d.empresa || '').trim().toLowerCase();
  k = k.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '');
  k = k.replace(/\/(about|home|posts|people|jobs|mycompany)(\/.*)?$/, '').replace(/\/+$/, '');
  return k;
}
function _emailDe(usuario) {
  var m = String(usuario || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(usuario || '')).trim().toLowerCase();
}
// ¿Ya hay una fila de este usuario con esta empresa? Lee las columnas dominio/usuario de la hoja (una lectura).
function _yaExiste(sh, d) {
  var n = sh.getLastRow();
  if (n < 2) return false;
  var iDom = COLUMNAS.indexOf('dominio') + 1, iUsr = COLUMNAS.indexOf('usuario') + 1, iEmp = COLUMNAS.indexOf('empresa') + 1;
  var clave = _claveEmpresa(d), email = _emailDe(d.usuario);
  if (!clave || !email) return false;
  var dom = sh.getRange(2, iDom, n - 1, 1).getValues(), usr = sh.getRange(2, iUsr, n - 1, 1).getValues(), emp = sh.getRange(2, iEmp, n - 1, 1).getValues();
  for (var i = 0; i < dom.length; i++) {
    if (_emailDe(usr[i][0]) === email && _claveEmpresa({ dominio: dom[i][0], empresa: emp[i][0] }) === clave) return true;
  }
  return false;
}

// UNA SOLA VEZ, a mano: Apps Script → elegí "marcarRepetidos" arriba → Ejecutar. Recorre las filas que ya
// están y llena la columna 'repetido' (SI/NO) con la misma regla. Las filas viejas sin usuario quedan en NO.
function marcarRepetidos() {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(HOJA);
  var n = sh.getLastRow();
  if (n < 2) return;
  sh.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS]);
  var iDom = COLUMNAS.indexOf('dominio') + 1, iUsr = COLUMNAS.indexOf('usuario') + 1, iEmp = COLUMNAS.indexOf('empresa') + 1, iRep = COLUMNAS.indexOf('repetido') + 1;
  var dom = sh.getRange(2, iDom, n - 1, 1).getValues(), usr = sh.getRange(2, iUsr, n - 1, 1).getValues(), emp = sh.getRange(2, iEmp, n - 1, 1).getValues();
  var vistos = {}, out = [];
  for (var i = 0; i < dom.length; i++) {
    var email = _emailDe(usr[i][0]), clave = _claveEmpresa({ dominio: dom[i][0], empresa: emp[i][0] });
    if (!email || !clave) { out.push(['NO']); continue; }
    var k = email + '|' + clave;
    out.push([vistos[k] ? 'SI' : 'NO']);
    vistos[k] = true;
  }
  sh.getRange(2, iRep, out.length, 1).setValues(out);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return _out('busy'); }   // evita choques con 2 análisis en paralelo
  try {
    var d = JSON.parse(e.postData.contents || '{}');
    if (TOKEN && d.token !== TOKEN) return _out('unauthorized');
    var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(HOJA) || ss.insertSheet(HOJA);
    // Encabezado: se escribe la primera vez y se ACTUALIZA si cambió COLUMNAS (ej. se agregó 'usuario'),
    // sin tocar las filas viejas (quedan con la celda nueva vacía).
    if (sh.getLastRow() === 0) sh.appendRow(COLUMNAS);
    else {
      var cab = sh.getRange(1, 1, 1, COLUMNAS.length).getValues()[0];
      if (cab.join('|') !== COLUMNAS.join('|')) sh.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS]);
    }
    d.repetido = _yaExiste(sh, d) ? 'SI' : 'NO';   // antes de agregar la fila, mirando las que ya están
    sh.appendRow(COLUMNAS.map(function (c) { return d[c] !== undefined && d[c] !== null ? d[c] : ''; }));
    return _out('ok');
  } catch (err) {
    return _out('error: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function _out(s) { return ContentService.createTextOutput(s); }
