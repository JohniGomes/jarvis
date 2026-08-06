// Agente conversacional de troca de praça -- chamado a cada minuto pelo
// pg_cron (ver supabase/chatwoot_poll_cron.sql), só dentro do horário de
// operação (06:00-15:30, ver dentroDoHorarioDeOperacao). Não usamos webhook
// do Chatwoot porque o token disponível é de Agente, não Administrador.
//
// Fluxo (com estado por conversa em chatwoot_conversas_estado, pra suportar
// ida-e-volta em vez de exigir tudo numa mensagem só):
//   1. Pedido claro (praça + identidade resolvida por telefone) -> executa
//      e responde "Feito." (ou erro) direto.
//   2. Pedido de troca sem praça clara ("quero trocar", "me agenda aí") ->
//      pergunta "Qual praça?" e guarda estado aguardando_praca.
//   3. Praça identificada mas telefone não bate com nenhum entregador
//      cadastrado -> pergunta "Qual seu CPF?" e guarda estado aguardando_cpf.
//   4. Pergunta que bate com uma categoria de RESPOSTAS_PRONTAS (ex.:
//      repasse diário) -> manda a resposta padrão direto, sem estado.
//   5. Mensagem que não é nada disso -> ignora, sem responder.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const CHATWOOT_BASE_URL = 'https://chatwoot.rayo-ia.com.br';
const CHATWOOT_ACCOUNT_ID = 2;
const MENSAGENS_DE_CONTEXTO = 5;

// PRAÇAS precisa ficar em sincronia com as options do <select> em
// https://api-automaturno.rly9ea.easypanel.host/admin/<token> -- se o
// parceiro adicionar/renomear praça, atualiza aqui também.
const PRACAS: Record<string, string> = {
  PINHEIROS: 'Pinheiros',
  PERDIZES: 'Perdizes',
  ACLIMACAO: 'Aclimação',
  MOOCA: 'Mooca',
  ITAIM_BROOKLIN_INDIANOPOLIS: 'Itaim / Brooklin / Indianópolis',
  TATUAPE: 'Tatuapé',
  LIVRE: 'Livre',
  CACHOEIRINHA: 'Cachoeirinha',
  CIDADE_DAS_FLORES: 'Cidade das Flores',
  JABAQUARA_SANTO_AMARO: 'Jabaquara / Santo Amaro',
  MANDAQUI: 'Mandaqui',
  VILA_JAGUARA: 'Vila Jaguara',
};

// Respostas prontas por categoria (fora troca de praça) -- pedidos do
// usuário 06/08/2026: dúvidas recorrentes que sempre recebem a mesma
// resposta, sem precisar de ida-e-volta nem executar nada no parceiro.
// Pra adicionar uma nova categoria: 1) chave nova aqui com o texto exato,
// 2) descrever quando usar em CATEGORIAS_RESPOSTA_PRONTA logo abaixo.
const RESPOSTAS_PRONTAS: Record<string, string> = {
  repasse_diario: [
    '*Temos repasse diário!*',
    '',
    'Caso tenha interesse no repasse diário faça seu cadastro no número abaixo:',
    'XAMA/ZAPCASH: +55 11 3136-2074',
    '',
    '*franquia* : rayosp',
  ].join('\n'),
};

// Descrição de cada categoria de resposta pronta, usada no prompt de
// classificação -- a Claude escolhe entre essas categorias (uma delas) ou
// "troca_praca" ou "outro".
const CATEGORIAS_RESPOSTA_PRONTA: Record<string, string> = {
  repasse_diario: 'pergunta se tem/pede repasse diário (receber o dinheiro das corridas todo dia, em vez do ciclo normal) -- ex.: "da pra fazer diário", "tem repasse diário", "posso receber por dia", "quero repasse diário"',
};

// Só fica ativo no horário do operador atual -- depois desse horário outra
// pessoa assume o atendimento manualmente. Ajuste aqui se o horário mudar.
const HORARIO_INICIO = 6 * 60; // 06:00 em minutos desde meia-noite
const HORARIO_FIM = 15 * 60 + 30; // 15:30

function dentroDoHorarioDeOperacao(): boolean {
  const agora = new Date().toLocaleString('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [h, m] = agora.split(':').map(Number);
  const minutosDoDia = h * 60 + m;
  return minutosDoDia >= HORARIO_INICIO && minutosDoDia < HORARIO_FIM;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    if (!dentroDoHorarioDeOperacao()) {
      return jsonResponse({ ok: true, fora_do_horario: true });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const chatwootToken = Deno.env.get('CHATWOOT_TOKEN')!;

    const conversas = await listarConversasAbertas(chatwootToken);
    const processados: any[] = [];

    // Cursor de performance: só busca mensagens completas de conversas que
    // tiveram atividade nova desde o último ciclo (last_activity_at mudou).
    const { data: cursores } = await supabase
      .from('chatwoot_conversas_cursor')
      .select('conversation_id, last_activity_at');
    const cursorPorConversa = new Map<number, number>(
      (cursores || []).map((c: any) => [c.conversation_id, c.last_activity_at]),
    );

    for (const conv of conversas) {
      const cursorAnterior = cursorPorConversa.get(conv.id);
      if (cursorAnterior !== undefined && cursorAnterior === conv.last_activity_at) {
        continue; // nada mudou nessa conversa desde a última checagem
      }

      // Não confia no resumo "last_non_activity_message" da listagem -- se
      // alguém (humano ou não) responder entre um ciclo e outro, ele deixa
      // de ser a mensagem do entregador e o pedido original fica invisível.
      // Busca as mensagens de verdade e acha a última do entregador.
      const mensagensCru = await mensagensCruas(chatwootToken, conv.id);

      await supabase.from('chatwoot_conversas_cursor').upsert({
        conversation_id: conv.id,
        last_activity_at: conv.last_activity_at,
        checado_em: new Date().toISOString(),
      });
      const ultimaDoContato = [...mensagensCru].reverse().find(
        (m: any) => (m.sender_type === 'Contact' || m.sender?.type === 'contact') && m.content?.trim(),
      );
      if (!ultimaDoContato) continue;

      const { data: jaProcessada } = await supabase
        .from('chatwoot_mensagens_processadas')
        .select('message_id')
        .eq('message_id', ultimaDoContato.id)
        .maybeSingle();
      if (jaProcessada) continue;

      const contexto = paraContexto(mensagensCru, MENSAGENS_DE_CONTEXTO);
      const resultado = await processarMensagem(supabase, chatwootToken, conv.id, ultimaDoContato, contexto);
      processados.push({ conversation_id: conv.id, message_id: ultimaDoContato.id, ...resultado });

      await supabase.from('chatwoot_mensagens_processadas').insert({
        message_id: ultimaDoContato.id,
        conversation_id: conv.id,
        acao: resultado.acao,
      });
    }

    return jsonResponse({ ok: true, conversas_verificadas: conversas.length, processados });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

async function listarConversasAbertas(token: string) {
  const base = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`;
  const headers = { api_access_token: token };
  const conversas: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const resp = await fetch(`${base}/conversations?status=open&page=${page}`, { headers });
    if (!resp.ok) throw new Error(`Chatwoot (listar conversas) respondeu ${resp.status}: ${await resp.text()}`);
    const json = await resp.json();
    const payload = json.data?.payload || [];
    if (payload.length === 0) break;
    conversas.push(...payload);
  }
  return conversas;
}

async function mensagensCruas(token: string, conversationId: number) {
  const base = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`;
  const resp = await fetch(`${base}/conversations/${conversationId}/messages`, {
    headers: { api_access_token: token },
  });
  if (!resp.ok) throw new Error(`Chatwoot (mensagens) respondeu ${resp.status}: ${await resp.text()}`);
  const payload = (await resp.json()).payload || [];
  return payload.filter((m: any) => m.content?.trim() && !m.private);
}

function paraContexto(mensagens: any[], limite: number): string[] {
  return mensagens.slice(-limite).map((m: any) => {
    const tipo = (m.sender?.type === 'contact' || m.sender_type === 'Contact') ? 'entregador' : 'atendente';
    return `${tipo}: ${m.content.trim()}`;
  });
}

async function entregadorPorTelefone(supabase: any, telefone: string | undefined | null) {
  if (!telefone) return null;
  const telefoneDigits = String(telefone).replace(/\D/g, '');
  const { data } = await supabase
    .from('entregadores')
    .select('cpf, nome')
    .eq('telefone', telefoneDigits)
    .maybeSingle();
  return data;
}

async function entregadorPorCpf(supabase: any, cpfTexto: string) {
  const cpfDigits = cpfTexto.replace(/\D/g, '');
  if (cpfDigits.length !== 11) return null;
  const { data } = await supabase
    .from('entregadores')
    .select('cpf, nome')
    .eq('cpf', cpfDigits)
    .maybeSingle();
  return data;
}

async function processarMensagem(supabase: any, chatwootToken: string, conversationId: number, msg: any, contexto: string[]) {
  const { data: estado } = await supabase
    .from('chatwoot_conversas_estado')
    .select('*')
    .eq('conversation_id', conversationId)
    .maybeSingle();

  const telefone = msg?.sender?.phone_number || msg?.conversation?.contact_inbox?.source_id;

  // --- 1. Já estávamos esperando o CPF (praça já sabida, telefone não bateu) ---
  if (estado?.estado === 'aguardando_cpf') {
    const entregador = await entregadorPorCpf(supabase, msg.content);
    if (!entregador) {
      await responder(chatwootToken, conversationId, 'Não consegui identificar esse CPF. Pode conferir e mandar só os números?');
      return { acao: 'aguardando_cpf_invalido' };
    }
    await limparEstado(supabase, conversationId);
    return await executarEResponder(supabase, chatwootToken, conversationId, entregador.cpf, estado.praca_codigo);
  }

  // --- 2. Já estávamos esperando a praça ---
  if (estado?.estado === 'aguardando_praca') {
    const classificacao = await classificarPraca(msg.content);
    if (!classificacao?.praca_codigo) {
      await responder(chatwootToken, conversationId, 'Não entendi -- pra qual praça você quer ir? (ex: Pinheiros, Mooca, Livre...)');
      return { acao: 'aguardando_praca_nao_identificada' };
    }
    const entregador = await entregadorPorTelefone(supabase, telefone);
    if (entregador) {
      await limparEstado(supabase, conversationId);
      return await executarEResponder(supabase, chatwootToken, conversationId, entregador.cpf, classificacao.praca_codigo);
    }
    await definirEstado(supabase, conversationId, 'aguardando_cpf', classificacao.praca_codigo);
    await responder(chatwootToken, conversationId, 'Qual seu CPF?');
    return { acao: 'aguardando_cpf_iniciado', praca: classificacao.praca_codigo };
  }

  // --- 3. Mensagem nova, sem estado -- classifica do zero com contexto ---
  const classificacao = await classificarPedidoCompleto(contexto);

  if (classificacao?.categoria && classificacao.categoria in RESPOSTAS_PRONTAS) {
    await responder(chatwootToken, conversationId, RESPOSTAS_PRONTAS[classificacao.categoria]);
    return { acao: `resposta_pronta_${classificacao.categoria}` };
  }

  if (!classificacao?.eh_pedido_troca) {
    return { acao: 'ignorado_nao_e_troca_praca' };
  }

  if (!classificacao.praca_codigo) {
    await definirEstado(supabase, conversationId, 'aguardando_praca', null);
    await responder(chatwootToken, conversationId, 'Qual praça?');
    return { acao: 'aguardando_praca_iniciado' };
  }

  const entregador = await entregadorPorTelefone(supabase, telefone);
  if (!entregador) {
    await definirEstado(supabase, conversationId, 'aguardando_cpf', classificacao.praca_codigo);
    await responder(chatwootToken, conversationId, 'Qual seu CPF?');
    return { acao: 'aguardando_cpf_iniciado', praca: classificacao.praca_codigo };
  }

  return await executarEResponder(supabase, chatwootToken, conversationId, entregador.cpf, classificacao.praca_codigo);
}

async function definirEstado(supabase: any, conversationId: number, estado: string, pracaCodigo: string | null) {
  await supabase.from('chatwoot_conversas_estado').upsert({
    conversation_id: conversationId,
    estado,
    praca_codigo: pracaCodigo,
    updated_at: new Date().toISOString(),
  });
}

async function limparEstado(supabase: any, conversationId: number) {
  await supabase.from('chatwoot_conversas_estado').delete().eq('conversation_id', conversationId);
}

async function executarEResponder(supabase: any, chatwootToken: string, conversationId: number, cpf: string, pracaCodigo: string) {
  const resultado = await executarTroca(cpf, pracaCodigo);
  const mensagemResposta = formatarResposta(resultado);
  await responder(chatwootToken, conversationId, mensagemResposta);
  return { acao: 'troca_executada', praca: pracaCodigo, resultado };
}

// classificarPedidoCompleto: primeira mensagem da conversa (sem estado ainda)
// -- decide entre 3 caminhos: troca de praça (com ou sem praça definida),
// uma categoria de resposta pronta (RESPOSTAS_PRONTAS), ou nenhum dos dois.
async function classificarPedidoCompleto(mensagens: string[]): Promise<{ eh_pedido_troca: boolean; praca_codigo: string | null; categoria: string | null } | null> {
  const listaPracas = Object.entries(PRACAS).map(([cod, nome]) => `${cod} = "${nome}"`).join('\n');
  const listaCategorias = Object.entries(CATEGORIAS_RESPOSTA_PRONTA).map(([cat, desc]) => `${cat} = ${desc}`).join('\n');
  const prompt = [
    'Você classifica mensagens de entregadores em UM destes 3 tipos:',
    '',
    '1) TROCA/ALOCAÇÃO DE PRAÇA (eh_pedido_troca: true) -- mudar ou definir a região/área onde vai',
    '   trabalhar. Trate como isso QUALQUER mensagem pedindo pra ser colocado/alocado/disponibilizado',
    '   pra trabalhar numa região agora, mesmo sem citar a palavra "praça". Exemplos:',
    '     "quero trocar de praça" -> praca_codigo: null (não disse qual)',
    '     "me agenda aí" -> praca_codigo: null',
    '     "pode me alocar em pinheiros?" -> praca_codigo: "PINHEIROS"',
    '     "será q consegue me colocar disponível agora na praça?" -> praca_codigo: null',
    '     "consegue me colocar na mooca?" -> praca_codigo: "MOOCA"',
    '',
    '2) Uma das categorias de resposta pronta abaixo (campo categoria):',
    listaCategorias,
    '',
    '3) Nenhum dos dois (pagamento fora do listado acima, nota fiscal, reclamação, "bom dia"/',
    '   agradecimento sozinho, dúvida geral) -- eh_pedido_troca: false, categoria: null.',
    '',
    'Praças válidas (só usadas se eh_pedido_troca for true):',
    listaPracas,
    '',
    'Você recebe as últimas mensagens da conversa (mais recente por último). Responda APENAS um JSON',
    'válido, sem markdown, no formato:',
    '{"eh_pedido_troca": true|false, "praca_codigo": "CODIGO_EXATO_DA_LISTA" ou null, "categoria": "NOME_DA_CATEGORIA" ou null}',
    '',
    'praca_codigo só deve vir preenchido se uma praça específica da lista foi mencionada com clareza.',
    'categoria e eh_pedido_troca nunca vêm preenchidos ao mesmo tempo.',
    '',
    'Conversa:',
    mensagens.join('\n'),
  ].join('\n');

  return await chamarClaude(prompt);
}

// classificarPraca: já sabemos que é pedido de troca (estado aguardando_praca)
// e essa mensagem é a resposta à pergunta "qual praça?" -- só extrai a praça.
async function classificarPraca(mensagem: string): Promise<{ praca_codigo: string | null } | null> {
  const listaPracas = Object.entries(PRACAS).map(([cod, nome]) => `${cod} = "${nome}"`).join('\n');
  const prompt = [
    'Um entregador pediu troca de praça e foi perguntado "Qual praça?". Ele respondeu a mensagem',
    'abaixo. Praças válidas:',
    listaPracas,
    '',
    'Responda APENAS um JSON válido, sem markdown: {"praca_codigo": "CODIGO_EXATO_DA_LISTA" ou null}',
    '(null se a resposta não identificar nenhuma praça da lista com clareza).',
    '',
    `Resposta do entregador: "${mensagem}"`,
  ].join('\n');

  return await chamarClaude(prompt);
}

async function chamarClaude(prompt: string): Promise<any> {
  const apiKey = Deno.env.get('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY não configurada.');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const json = await response.json();
  if (!response.ok) throw new Error(`Claude API (${response.status}): ${json.error?.message || JSON.stringify(json)}`);

  // Apesar da instrução "sem markdown", o modelo às vezes envolve a
  // resposta em ```json ... ``` -- isso quebrava o JSON.parse silenciosamente
  // (caía no catch, virava null, e a mensagem era ignorada por engano).
  // Tira a cerca de código antes de tentar parsear.
  let texto = json.content?.[0]?.text?.trim() || '{}';
  const match = texto.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) texto = match[1].trim();

  try {
    return JSON.parse(texto);
  } catch (e) {
    console.error('Falha ao parsear resposta da Claude:', texto, e);
    return null;
  }
}

async function executarTroca(cpf: string, pracaCodigo: string) {
  const url = 'https://api-automaturno.rly9ea.easypanel.host/admin/f1c488c58cbd6cea2ac17df3f5d5b5be/trocar';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cpf, subpraca_id: pracaCodigo }),
  });
  const dados = await response.json();
  return dados; // { status_parceiro, corpo_parceiro: { success, action, subPraca, ... } }
}

function formatarResposta(resultado: any): string {
  const corpo = resultado?.corpo_parceiro;
  const statusOk = resultado?.status_parceiro >= 200 && resultado?.status_parceiro < 300 && corpo?.success !== false;

  if (statusOk && corpo?.action === 'noop') {
    return 'Não consegui confirmar a troca agora -- o sistema não fez nenhuma alteração. Pode tentar de novo em instantes ou aguardar que alguém da equipe confira.';
  }
  if (statusOk) {
    return 'Feito.';
  }
  return 'Não consegui fazer a troca agora -- vou pedir pra alguém da equipe verificar e te retornar.';
}

async function responder(token: string, conversationId: number, content: string) {
  const base = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`;
  const response = await fetch(`${base}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_access_token: token },
    body: JSON.stringify({ content, message_type: 'outgoing' }),
  });
  if (!response.ok) {
    throw new Error(`Chatwoot (enviar mensagem) respondeu ${response.status}: ${await response.text()}`);
  }
}
