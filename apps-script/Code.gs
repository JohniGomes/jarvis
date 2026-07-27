// ============================================================================
// Este painel é aberto (sem chave de acesso) — qualquer pessoa com o link do
// GitHub Pages consegue ver os dados. Não implantar isso pra dados que
// precisam ficar restritos.
// ============================================================================

// Planilha externa "Pós-vendas" com nome, telefone e CPF dos entregadores
// aprovados (aba "Pós-vendas (Messias)"). Não é a mesma planilha do D-1.
var POS_VENDAS_SPREADSHEET_ID = '169jmX5N4m8icBi0MA0kiMyCF-J9irtXVUGkI7Q3ene0';
var POS_VENDAS_SHEET_NAME = 'Pós-vendas (Messias)';

function doGet(e) {
  try {
    // Resumo com IA (aba Análise) — usa GET (não POST) porque o Content
    // Service do Apps Script não devolve cabeçalhos CORS em respostas de
    // POST, então o navegador bloqueia a leitura mesmo com a chamada indo
    // certinho. GET com os dados no querystring evita esse problema (é o
    // mesmo caminho que já funciona pra aba D-1).
    if (e.parameter.action === 'analyze') {
      var data = JSON.parse(e.parameter.data || '{}');
      return jsonOutput({ text: generateAnalysisSummary(data) });
    }

    var tab = (e.parameter.tab || 'D-1').trim();

    if (tab === 'PosVendas') {
      return jsonOutput(getPosVendasRows());
    }

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
    var escaladoIdx = headers.indexOf('tempo_disponivel_escalado');

    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        var h = headers[j];
        var val = values[i][j];
        if (j === escaladoIdx && isDateValue(val)) {
          // O Sheets às vezes lê um percentual tipo "23.12" como se fosse uma
          // data (dia 23, mês 12) na hora de colar, porque bate com um
          // padrão dia.mês válido. Reconstrói o número original a partir do
          // dia/mês da data corrompida, em vez de formatar como data.
          val = val.getDate() + (val.getMonth() + 1) / 100;
        } else if (isDateValue(val)) {
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

// Lê nome (B), telefone (E), CPF (F), se já fizemos o primeiro contato (P) e
// a observação (Q) da planilha externa de Pós-vendas. Usa índice de coluna
// fixo em vez de nome de cabeçalho porque essa planilha não é nossa — o
// cabeçalho é em linguagem natural, não snake_case combinado com o painel.
function getPosVendasRows() {
  var ss = SpreadsheetApp.openById(POS_VENDAS_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(POS_VENDAS_SHEET_NAME);
  if (!sheet) {
    throw new Error('Aba não encontrada na planilha de Pós-vendas: ' + POS_VENDAS_SHEET_NAME);
  }
  var values = sheet.getDataRange().getValues();
  var tz = Session.getScriptTimeZone();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var nome = row[1]; // B
    if (!nome) continue;
    var telefone = row[4]; // E
    var cpf = row[5]; // F
    var contatoFeito = row[15]; // P
    var observacao = row[16]; // Q
    rows.push({
      pessoa_entregadora: String(nome).trim(),
      telefone: isDateValue(telefone) ? formatSheetDate(telefone, tz) : telefone,
      cpf: isDateValue(cpf) ? formatSheetDate(cpf, tz) : cpf,
      contato_feito: contatoFeito,
      observacao: observacao,
    });
  }
  return rows;
}

// O SpreadsheetApp às vezes devolve Date criado em outro "contexto" do V8,
// e "val instanceof Date" retorna false mesmo sendo uma data de verdade
// (dá pra confirmar pelo toString(), que só um Date de verdade produz).
// Object.prototype.toString.call funciona entre contextos diferentes,
// então é a checagem confiável aqui.
function isDateValue(val) {
  return Object.prototype.toString.call(val) === '[object Date]';
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

// ============================================================================
// Resumo com IA (aba Análise). A chave da Claude API NUNCA fica neste arquivo
// — ela vive em "Propriedades do script" (ícone de engrenagem no editor do
// Apps Script > Configurações do projeto > Propriedades do script), com o
// nome CLAUDE_API_KEY. Assim ela nunca é commitada no GitHub nem aparece pro
// navegador do usuário.
// ============================================================================
function generateAnalysisSummary(data) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) {
    throw new Error(
      'CLAUDE_API_KEY não configurada. No editor do Apps Script, vá em Configurações do projeto ' +
      '(ícone de engrenagem) > Propriedades do script > Adicionar propriedade do script, com nome ' +
      'CLAUDE_API_KEY e o valor da sua chave da Anthropic (console.anthropic.com).'
    );
  }

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: buildAnalysisPrompt(data) }],
    }),
    muteHttpExceptions: true,
  });

  var status = response.getResponseCode();
  var json = JSON.parse(response.getContentText());
  if (status !== 200) {
    var msg = (json.error && json.error.message) || response.getContentText();
    throw new Error('Erro na API da Anthropic (' + status + '): ' + msg);
  }
  return (json.content && json.content[0] && json.content[0].text) || '';
}

function buildAnalysisPrompt(data) {
  return [
    'Você é um analista de operações de logística de última milha (entregadores freelancers via app).',
    'Escreva um resumo executivo curto (no máximo 6 frases, em português do Brasil, tom direto e',
    'prático, sem markdown) sobre o desempenho do período abaixo, destacando os problemas mais',
    'acionáveis e terminando com uma recomendação objetiva do que priorizar primeiro.',
    '',
    'Período: ' + (data.periodo || 'não informado'),
    'Aderência: ' + (data.aderenciaPct != null ? data.aderenciaPct + '%' : 'n/d'),
    'Tempo Online do time: ' + (data.tempoOnlinePct != null ? data.tempoOnlinePct + '%' : 'n/d'),
    'Horas esperadas no período: ' + (data.horasEsperadas != null ? data.horasEsperadas + 'h' : 'n/d'),
    'Entregadores agendados: ' + (data.totalDrivers != null ? data.totalDrivers : 'n/d'),
    'Não compareceram nenhum turno: ' + (data.noShowCount != null ? data.noShowCount : 'n/d') +
      ' (' + (data.noShowPct != null ? data.noShowPct + '%' : 'n/d') + ' dos agendados)',
    'Compareceram mas ficaram menos da metade do turno online: ' + (data.lowOnlineCount != null ? data.lowOnlineCount : 'n/d') +
      ' (' + (data.lowOnlinePct != null ? data.lowOnlinePct + '%' : 'n/d') + ' de quem veio)',
    'Entregadores que recusaram 90%+ das corridas ofertadas (com 5+ ofertadas): ' +
      (data.rejectionNames && data.rejectionNames.length ? data.rejectionNames.join(', ') : 'nenhum'),
  ].join('\n');
}
