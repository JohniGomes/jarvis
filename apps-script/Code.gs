// ============================================================================
// IMPORTANTE: troque o valor abaixo SÓ AQUI, direto no editor do Apps Script
// (script.google.com) — NUNCA suba o valor real desse arquivo pro GitHub.
// A cópia deste arquivo no repositório deve continuar com o placeholder
// 'TROQUE_AQUI', senão a chave de acesso fica pública pra qualquer pessoa
// que ver o repositório.
// ============================================================================
var ACCESS_KEY = 'TROQUE_AQUI';

function doGet(e) {
  try {
    var providedKey = e.parameter.key || '';
    if (ACCESS_KEY === 'TROQUE_AQUI') {
      throw new Error(
        'ACCESS_KEY ainda não foi definida. Edite a constante ACCESS_KEY no topo ' +
        'deste arquivo, direto no editor do Apps Script (script.google.com).'
      );
    }
    if (providedKey !== ACCESS_KEY) {
      return jsonOutput({ error: 'unauthorized' });
    }

    var tab = (e.parameter.tab || 'D0').trim();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(tab);
    if (!sheet) {
      throw new Error('Aba não encontrada: ' + tab);
    }

    var values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      return jsonOutput([]);
    }

    var headers = values[0].map(function (h) { return String(h).trim(); });
    var tz = Session.getScriptTimeZone();

    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        var h = headers[j];
        var val = values[i][j];
        if (val instanceof Date) {
          val = formatSheetDate(val, tz);
        }
        obj[h] = val;
      }
      rows.push(obj);
    }

    return jsonOutput(rows);
  } catch (err) {
    return jsonOutput({ error: String(err) });
  }
}

// O Sheets guarda valores "só hora" (duração, tempo disponível) como uma
// data-hora no dia 30/12/1899 (o epoch interno dele). Datas de verdade caem
// em outro dia. Detectando pelo VALOR em vez do nome da coluna, isso funciona
// não importa como a coluna acabou sendo nomeada na planilha.
function formatSheetDate(val, tz) {
  var isTimeOfDay = val.getFullYear() === 1899 && val.getMonth() === 11 && val.getDate() === 30;
  if (isTimeOfDay) {
    return Utilities.formatDate(val, tz, 'HH:mm:ss');
  }
  var hasTime = val.getHours() !== 0 || val.getMinutes() !== 0 || val.getSeconds() !== 0;
  return Utilities.formatDate(val, tz, hasTime ? 'dd/MM/yyyy HH:mm:ss' : 'dd/MM/yyyy');
}

function jsonOutput(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
