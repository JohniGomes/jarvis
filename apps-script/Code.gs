// ============================================================================
// Este painel é aberto (sem chave de acesso) — qualquer pessoa com o link do
// GitHub Pages consegue ver os dados. Não implantar isso pra dados que
// precisam ficar restritos.
// ============================================================================

// Nome, telefone e CPF dos entregadores vêm de duas abas combinadas (nome é
// a chave de match):
//   - "Entregadores": lista completa dos aprovados (Nome/CPF/Telefone), na
//     MESMA planilha oficial do D-1 — é a fonte principal.
//   - "Pós-vendas (Messias)": contato manual de pós-venda, numa planilha
//     EXTERNA separada (POS_VENDAS_SPREADSHEET_ID abaixo). Usada só como
//     reforço pra quem não estiver na lista de aprovados ou tiver CPF/
//     telefone em branco lá.
var POS_VENDAS_SPREADSHEET_ID = '169jmX5N4m8icBi0MA0kiMyCF-J9irtXVUGkI7Q3ene0';
var ENTREGADORES_SHEET_NAME = 'Entregadores';
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

// Combina as duas abas de contato (ver comentário acima das constantes),
// casando por nome. "Entregadores" (planilha oficial do D-1) entra primeiro
// como fonte principal; "Pós-vendas" (planilha externa) só completa quem
// não apareceu lá ou ficou com CPF/telefone vazio.
function getPosVendasRows() {
  var byName = {};

  var mainSs = SpreadsheetApp.getActiveSpreadsheet();
  var aprovadosSheet = mainSs.getSheetByName(ENTREGADORES_SHEET_NAME);
  if (aprovadosSheet) {
    readEntregadoresAprovados(aprovadosSheet).forEach(function (r) {
      byName[normNomeParaMatch(r.pessoa_entregadora)] = r;
    });
  }

  var contatosSs = SpreadsheetApp.openById(POS_VENDAS_SPREADSHEET_ID);
  var posVendasSheet = contatosSs.getSheetByName(POS_VENDAS_SHEET_NAME);
  if (posVendasSheet) {
    readPosVendasSheet(posVendasSheet).forEach(function (r) {
      var key = normNomeParaMatch(r.pessoa_entregadora);
      var existing = byName[key];
      if (!existing) {
        byName[key] = r;
      } else {
        if (!existing.cpf && r.cpf) existing.cpf = r.cpf;
        if (!existing.telefone && r.telefone) existing.telefone = r.telefone;
      }
    });
  }

  return Object.keys(byName).map(function (k) { return byName[k]; });
}

function normNomeParaMatch(nome) {
  return String(nome || '').trim().toUpperCase();
}

// CPF/telefone vêm como número na planilha (ex: 07346548558 perde o zero à
// esquerda e vira 7346548558) — reconstrói como texto de 11 dígitos.
function padDigits11(val) {
  if (val === '' || val === null || val === undefined) return '';
  var digits = String(val).replace(/\D/g, '');
  if (!digits) return '';
  while (digits.length < 11) digits = '0' + digits;
  return digits;
}

// Lê a aba "Entregadores" (lista completa dos aprovados) pelo nome do
// cabeçalho — essa planilha tem cabeçalho legível (Nome/CPF/Telefone), não
// precisa ler por posição de coluna.
function readEntregadoresAprovados(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var nomeIdx = headers.indexOf('Nome');
  var cpfIdx = headers.indexOf('CPF');
  var telIdx = headers.indexOf('Telefone');
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var nome = values[i][nomeIdx];
    if (!nome) continue;
    rows.push({
      pessoa_entregadora: String(nome).trim(),
      cpf: cpfIdx === -1 ? '' : padDigits11(values[i][cpfIdx]),
      telefone: telIdx === -1 ? '' : padDigits11(values[i][telIdx]),
    });
  }
  return rows;
}

// Lê nome (B), telefone (E) e CPF (F) da aba de Pós-vendas. Usa índice de
// coluna fixo em vez de nome de cabeçalho porque essa aba não é nossa — o
// cabeçalho é em linguagem natural, não combinado com o painel.
function readPosVendasSheet(sheet) {
  var values = sheet.getDataRange().getValues();
  var tz = Session.getScriptTimeZone();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var nome = row[1]; // B
    if (!nome) continue;
    var telefone = row[4]; // E
    var cpf = row[5]; // F
    rows.push({
      pessoa_entregadora: String(nome).trim(),
      telefone: isDateValue(telefone) ? formatSheetDate(telefone, tz) : telefone,
      cpf: isDateValue(cpf) ? formatSheetDate(cpf, tz) : padDigits11(cpf),
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
