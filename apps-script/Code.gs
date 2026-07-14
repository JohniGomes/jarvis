function doGet(e) {
  try {
    var providedKey = e.parameter.key || '';
    var expectedKey = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
    if (!expectedKey) {
      throw new Error(
        'ACCESS_KEY não configurada. Vá em Configurações do projeto (engrenagem) ' +
        '> Propriedades do script > Adicionar propriedade do script, nome ACCESS_KEY.'
      );
    }
    if (providedKey !== expectedKey) {
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

    // colunas que o Sheets costuma converter pra Date/hora internamente
    var TIME_COLUMNS = ['duracao_do_periodo', 'tempo_disponivel_absoluto'];
    var DATE_COLUMNS = ['data_do_periodo'];

    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        var h = headers[j];
        var val = values[i][j];
        if (val instanceof Date) {
          if (TIME_COLUMNS.indexOf(h) !== -1) {
            val = Utilities.formatDate(val, tz, 'HH:mm:ss');
          } else if (DATE_COLUMNS.indexOf(h) !== -1) {
            val = Utilities.formatDate(val, tz, 'dd/MM/yyyy');
          } else {
            val = Utilities.formatDate(val, tz, 'dd/MM/yyyy HH:mm:ss');
          }
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

function jsonOutput(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
