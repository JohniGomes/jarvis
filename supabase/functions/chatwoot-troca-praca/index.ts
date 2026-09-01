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
const MENSAGENS_DE_CONTEXTO = 12; // pedidos reais vistos hoje (06/08) ficaram enterrados sob mensagens soltas ("Oii", "Porfavor") -- 5 era pouco

// Quanto tempo (minutos, a partir da mensagem original) o bot continua
// tentando de novo automaticamente uma troca de praça que falhou, antes
// de desistir de vez -- ver uso em Fase 2 do handler principal.
const RETRY_TROCA_MAX_MIN = 10;

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

// Resposta de sucesso pra troca de praça (pedido do usuário 27/08/2026) --
// fixa, sem variação aleatória.
function respostaSucesso(): string {
  return 'Beleza, feito!';
}

// Bug real reportado pelo usuário 22/08/2026: quando o parceiro retorna
// action "noop" (pedido de troca que já está satisfeito -- a pessoa já
// está na praça pedida), o bot ficava em silêncio total (mesma regra do
// silêncio-em-falha), e o entregador nunca sabia que o pedido dele já
// tinha sido atendido antes -- ficava mandando "??" de novo sem parar,
// achando que ninguém tinha visto. "noop" com success:true NÃO é uma
// falha (é o parceiro confirmando que já está tudo certo), então merece
// confirmação como as outras, só que deixando claro que já estava assim.
const RESPOSTAS_NOOP = ['Você já tá nessa praça!', 'Já tá certinho, você já tá nessa praça.', 'Opa, já tá aí, viu?', 'Já tava nessa praça mesmo -- tá tudo certo.'];
function respostaNoop(): string {
  return RESPOSTAS_NOOP[Math.floor(Math.random() * RESPOSTAS_NOOP.length)];
}

// Pedido do usuário 22/08/2026: gente que só manda "Bom dia" (ou "Boa
// tarde"/"Boa noite"), sem pedir mais nada, ficava sem resposta nenhuma
// (caía em "nenhum dos tipos" -> silêncio). Agora responde de volta com
// o mesmo período do dia + oferece ajuda.
const RESPOSTAS_SAUDACAO: Record<string, string> = {
  bom_dia: 'Bom dia! Em que posso ajudar?',
  boa_tarde: 'Boa tarde! Em que posso ajudar?',
  boa_noite: 'Boa noite! Em que posso ajudar?',
  generica: 'Oi! Em que posso ajudar?',
};

// Fluxo de boas-vindas pro novato (pedido do usuário 06/08/2026). O
// atendente manda manualmente a mensagem de aprovação ("Eu tenho uma boa
// notícia FULANO...") -- o bot só entra em ação DEPOIS disso, olhando pro
// histórico da conversa (não precisa de estado salvo -- as próprias
// respostas do bot já viram contexto no próximo ciclo):
//   "Não tenho dúvida" -> manda NOVATO_INSTRUCOES_COMPLETAS
//   "Tenho dúvida" (sem dizer qual) -> "Qual sua dúvida?"
//   Depois de perguntar "Qual sua dúvida?", a resposta que esclarece do
//   que se trata -> manda só o trecho relevante (mapa/horário/repasse/agendamento)
//   Qualquer coisa não clara -> silêncio total (regra do usuário: só
//   responde com certeza, senão o atendente humano assume)
const NOVATO_MAPA = 'Esse é nosso mapa: https://www.google.com/maps/d/u/0/viewer?mid=1UigqizFNH7bczw-W5vNI8UA_HjZxE8s&ll=-23.532492961326756%2C-46.625576675241355&z=11';
const NOVATO_HORARIOS = [
  'Temos esses turnos:',
  'Café da manhã - 06:00 às 08:00',
  'Manhã - 08:00 às 11:30',
  'Almoço - 11:30 às 15:30',
  'Tarde - 15:30 às 18:30',
  'Jantar - 18:30 às 21:30',
  'Noturno - 21:30 à 00:00',
  'Madrugada - 00:00 à 01:00',
].join('\n');
// Mensagem de repasse/pagamento DESATIVADA por pedido do usuário
// 10/08/2026 -- não deve mais mandar nada automaticamente sobre isso, nem
// no fluxo de boas-vindas do novato, nem como resposta pronta avulsa.
// Assunto financeiro fica só com atendimento humano a partir de agora.

const NOVATO_AGENDAMENTO = 'Para se agendar, só enviar um Oi aqui. 11 93618-9622. Ok?';
const NOVATO_INSTRUCOES_COMPLETAS = ['Show! Vou te mandar algumas instruções:', NOVATO_MAPA, '', NOVATO_HORARIOS, '', NOVATO_AGENDAMENTO].join('\n');

const NOVATO_RESPOSTAS: Record<string, string> = {
  sem_duvida: NOVATO_INSTRUCOES_COMPLETAS,
  duvida_generica: 'Qual sua dúvida?',
  duvida_mapa: NOVATO_MAPA,
  duvida_horario: NOVATO_HORARIOS,
  duvida_agendamento: NOVATO_AGENDAMENTO,
};

// Respostas prontas por categoria (fora troca de praça) -- pedidos do
// usuário 06/08/2026: dúvidas recorrentes que sempre recebem a mesma
// resposta, sem precisar de ida-e-volta nem executar nada no parceiro.
// Pra adicionar uma nova categoria: 1) chave nova aqui com o texto exato,
// 2) descrever quando usar em CATEGORIAS_RESPOSTA_PRONTA logo abaixo.
// (vazio -- categoria "repasse" removida 10/08/2026)
const RESPOSTAS_PRONTAS: Record<string, string> = {};

// Descrição de cada categoria de resposta pronta, usada no prompt de
// classificação -- a Claude escolhe entre essas categorias (uma delas) ou
// "troca_praca" ou "outro".
const CATEGORIAS_RESPOSTA_PRONTA: Record<string, string> = {};

// Só fica ativo no horário do operador atual -- depois desse horário outra
// pessoa assume o atendimento manualmente. Ajuste aqui se o horário mudar.
//
// Pedido do usuário 13/08/2026: 06:00-15:30 -> 06:00-01:00 (madrugada
// seguinte), full time por pelo menos uma semana -- avisa quando quiser
// voltar ao horário normal. Janela cruza a meia-noite, então HORARIO_FIM
// (01:00 = 60min) é NUMERICAMENTE MENOR que HORARIO_INICIO (06:00 =
// 360min) -- a comparação abaixo já trata esse caso (vira "ou" em vez de
// "e" quando FIM < INICIO).
const HORARIO_INICIO = 6 * 60; // 06:00 em minutos desde meia-noite
const HORARIO_FIM = 1 * 60; // 01:00 (do dia seguinte)

function dentroDoHorarioDeOperacao(): boolean {
  const agora = new Date().toLocaleString('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [h, m] = agora.split(':').map(Number);
  const minutosDoDia = h * 60 + m;
  if (HORARIO_FIM > HORARIO_INICIO) {
    return minutosDoDia >= HORARIO_INICIO && minutosDoDia < HORARIO_FIM;
  }
  // Janela cruza a meia-noite (ex.: 06:00-01:00) -- está dentro se for
  // depois do início OU antes do fim, não as duas coisas ao mesmo tempo.
  return minutosDoDia >= HORARIO_INICIO || minutosDoDia < HORARIO_FIM;
}

// Meia-noite de hoje em horário de Brasília, convertida pra ISO (UTC) --
// usada pra limitar buscas a "hoje" (ex.: resposta pronta já mandada hoje).
// Brasília é sempre UTC-3 (sem horário de verão), então meia-noite BRT é
// sempre 03:00 UTC do mesmo dia.
function inicioDoDiaBrasiliaISO(): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const ano = partes.find((p) => p.type === 'year')!.value;
  const mes = partes.find((p) => p.type === 'month')!.value;
  const dia = partes.find((p) => p.type === 'day')!.value;
  return `${ano}-${mes}-${dia}T03:00:00.000Z`;
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

    // Interruptor geral -- checado antes de qualquer outra coisa. Desligado
    // no painel (botão ON/OFF) = não faz nada, mesmo dentro do horário.
    const { data: config } = await supabase
      .from('automacao_config')
      .select('ativo')
      .eq('chave', 'chatwoot_bot')
      .maybeSingle();
    if (config && config.ativo === false) {
      return jsonResponse({ ok: true, desligado_manualmente: true });
    }

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

    // Fase 1: descobre quais conversas têm mensagem nova de entregador
    // ainda não processada. As que não precisam de Claude (sem mensagem de
    // contato, ou mensagem repetida) já são resolvidas aqui direto.
    const pendentes: { conv: any; msg: any; contexto: string[] }[] = [];
    for (const conv of conversas) {
      const cursorAnterior = cursorPorConversa.get(conv.id);
      if (cursorAnterior !== undefined && cursorAnterior === conv.last_activity_at) {
        continue; // nada mudou nessa conversa desde a última checagem
      }

      // Bug real visto em produção 12/08/2026: o cursor era gravado ANTES
      // do processamento terminar -- uma falha aqui (ex.: Chatwoot fora do
      // ar) marcava a conversa como "já vista" sem nunca ter sido
      // processada de verdade. Só marca o cursor depois de um caminho
      // concluído com sucesso (mesmo que o "sucesso" seja só "nada a fazer
      // aqui"), e uma conversa com erro não impede as outras.
      try {
        // Não confia no resumo "last_non_activity_message" da listagem -- se
        // alguém (humano ou não) responder entre um ciclo e outro, ele deixa
        // de ser a mensagem do entregador e o pedido original fica invisível.
        // Busca as mensagens de verdade e acha a última do entregador.
        const mensagensCru = await mensagensCruas(chatwootToken, conv.id);

        const ultimaDoContato = [...mensagensCru].reverse().find(
          (m: any) => (m.sender_type === 'Contact' || m.sender?.type === 'contact') && m.content?.trim(),
        );
        if (!ultimaDoContato) {
          await atualizarCursor(supabase, conv);
          continue;
        }

        const { data: jaProcessada } = await supabase
          .from('chatwoot_mensagens_processadas')
          .select('message_id')
          .eq('message_id', ultimaDoContato.id)
          .maybeSingle();
        if (jaProcessada) {
          await atualizarCursor(supabase, conv);
          continue;
        }

        // Bug real reportado pelo usuário 14/08/2026 (print de conversa
        // real): conversa parada tinha um pedido de praça de dias atrás
        // ("Livre por favor" em 09/08); quando a pessoa voltou a mandar
        // mensagem solta em 14/08 ("rafael", sem pedir nada), o contexto
        // (últimas 12 mensagens, sem filtro de data) ainda incluía aquele
        // pedido antigo, e a regra de "cutucão" (mensagem vaga depois de
        // uma praça já mencionada) fez a Claude tratar como se fosse
        // pedido de hoje -- executou a troca por engano. Só manda pro
        // contexto as mensagens do MESMO DIA (fuso Brasília) da última
        // mensagem do entregador -- pedidos de dias anteriores não value
        // mais como "cutucão" de hoje.
        const mensagensDeHoje = mensagensCru.filter((m: any) => mesmoDiaBrasilia(m.created_at, ultimaDoContato.created_at));
        const contexto = paraContexto(mensagensDeHoje, MENSAGENS_DE_CONTEXTO);
        pendentes.push({ conv, msg: ultimaDoContato, contexto });
      } catch (err) {
        console.error(`Falha buscando mensagens da conversa ${conv.id}:`, err);
        // Cursor de propósito NÃO atualizado -- tenta de novo no próximo ciclo.
      }
    }

    // Fase 2: classifica em lotes (poucas chamadas à Claude em vez de 1 por
    // conversa -- as instruções fixas do prompt são pagas 1x por lote, não
    // 1x por conversa) e executa a ação de cada uma.
    for (let inicio = 0; inicio < pendentes.length; inicio += CLASSIFICACAO_LOTE_TAMANHO) {
      const lote = pendentes.slice(inicio, inicio + CLASSIFICACAO_LOTE_TAMANHO);

      let classificacoes: (Classificacao | null)[];
      try {
        classificacoes = await classificarPedidosEmLote(lote.map((p) => p.contexto));
      } catch (err) {
        console.error(`Falha classificando lote de ${lote.length} conversa(s):`, err);
        continue; // nenhuma dessas teve o cursor atualizado -- tenta de novo no próximo ciclo
      }

      for (let i = 0; i < lote.length; i++) {
        const { conv, msg } = lote[i];
        try {
          const resultado = await executarClassificacao(supabase, chatwootToken, conv.id, msg, classificacoes[i]);
          processados.push({ conversation_id: conv.id, message_id: msg.id, ...resultado });

          // Casos reais 21-22/08/2026 (Caique, Wellington, Gustavo, Andreano):
          // "troca_falhou_sem_resposta" quase sempre é falha intermitente do
          // parceiro, não um problema de dado -- em todos os casos, tentar de
          // novo minutos depois resolvia sozinho, mas isso exigia alguém
          // notar a reclamação e reexecutar na mão. Em vez de marcar como
          // processada de vez, deixa tentar de novo automaticamente nos
          // próximos ciclos (1 min cada) enquanto a mensagem for "recente"
          // (RETRY_TROCA_MAX_MIN) -- depois disso desiste de vez, do jeito
          // que já era antes (silêncio, log pra revisão humana), pra não
          // ficar tentando pra sempre um caso genuinamente quebrado (CPF/
          // praça inválidos, por exemplo).
          const idadeMinutos = (Date.now() - msg.created_at * 1000) / 60000;
          const continuaTentando = resultado.acao === 'troca_falhou_sem_resposta' && idadeMinutos < RETRY_TROCA_MAX_MIN;
          if (continuaTentando) {
            console.log(`Troca falhou (conversa ${conv.id}, mensagem com ${idadeMinutos.toFixed(1)}min) -- tenta de novo no próximo ciclo, sem marcar como processada.`);
            continue;
          }

          await supabase.from('chatwoot_mensagens_processadas').insert({
            message_id: msg.id,
            conversation_id: conv.id,
            acao: resultado.acao,
          });

          await atualizarCursor(supabase, conv);
        } catch (err) {
          console.error(`Falha processando conversa ${conv.id}:`, err);
          // Cursor de propósito NÃO atualizado -- tenta de novo no próximo ciclo.
        }
      }
    }

    return jsonResponse({ ok: true, conversas_verificadas: conversas.length, pendentes: pendentes.length, processados });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

async function atualizarCursor(supabase: any, conv: any) {
  await supabase.from('chatwoot_conversas_cursor').upsert({
    conversation_id: conv.id,
    last_activity_at: conv.last_activity_at,
    checado_em: new Date().toISOString(),
  });
}

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

  // Mensagem de áudio chega com content null -- transcreve (Whisper) e usa
  // como se fosse o texto da mensagem, pra tudo mais (busca da última
  // mensagem do entregador, contexto pro classificador) funcionar igual.
  for (const m of payload) {
    if (!m.content?.trim() && !m.private) {
      const audio = (m.attachments || []).find((a: any) => a.file_type === 'audio');
      if (audio?.data_url) {
        try {
          const texto = await transcreverAudio(audio.data_url);
          if (texto?.trim()) m.content = texto.trim();
        } catch (e) {
          console.error(`Falha ao transcrever áudio (mensagem ${m.id}):`, e);
        }
      }
    }
  }

  return payload.filter((m: any) => m.content?.trim() && !m.private);
}

async function transcreverAudio(dataUrl: string): Promise<string> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada.');

  const audioResp = await fetch(dataUrl);
  if (!audioResp.ok) throw new Error(`Download do áudio falhou: ${audioResp.status}`);
  const audioBlob = await audioResp.blob();

  const form = new FormData();
  form.append('file', audioBlob, 'audio.ogg');
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Whisper API (${resp.status}): ${json.error?.message || JSON.stringify(json)}`);
  return json.text || '';
}

// Compara a data (fuso Brasília) de dois timestamps Unix (segundos) --
// usado pra não deixar mensagens de dias anteriores contaminarem o
// contexto de classificação do dia atual. Ver comentário no loop
// principal (bug real 14/08/2026).
function mesmoDiaBrasilia(unixSegundosA: number, unixSegundosB: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
  return fmt.format(new Date(unixSegundosA * 1000)) === fmt.format(new Date(unixSegundosB * 1000));
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

// Muitos contatos no Chatwoot já têm o CPF gravado no próprio nome (ex.:
// "RODRIGO LIMA PINHEIRO 439.067.608-39", "😎 522.953.848-18" -- é assim
// que o painel salva quando cadastra pelo número avulso). Se o telefone
// não bateu com ninguém, tenta esse caminho antes de perguntar CPF.
async function entregadorPorNomeDoContato(supabase: any, nome: string | undefined | null) {
  if (!nome) return null;
  const match = nome.match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
  if (!match) return null;
  return await entregadorPorCpf(supabase, match[0]);
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

async function identificarEntregador(supabase: any, telefone: string | undefined | null, nomeContato: string | undefined | null) {
  return (await entregadorPorTelefone(supabase, telefone)) || (await entregadorPorNomeDoContato(supabase, nomeContato));
}

// Modo silencioso (pedido do usuário 06/08/2026 -- o robô estava
// "alucinando", ou seja, perguntando/respondendo coisa errada demais):
// SEM estado, SEM perguntas, SEM respostas prontas. Só age quando a
// mensagem já traz praça clara + entregador identificável (telefone ou
// CPF no nome do contato) de primeira -- e só responde no sucesso
// ("Feito."). Qualquer outra coisa (praça não clara, entregador não
// identificado, não é pedido de troca, falhou) fica em silêncio total,
// sem responder nada -- atendimento humano assume.
//
// Recebe a classificação já pronta (calculada em lote junto com outras
// conversas do mesmo ciclo, ver classificarPedidosEmLote) em vez de
// chamar a Claude aqui -- decisão do usuário 13/08/2026 pra reduzir
// custo depois de estender o horário do bot.
async function executarClassificacao(supabase: any, chatwootToken: string, conversationId: number, msg: any, classificacao: Classificacao | null) {
  const telefone = msg?.sender?.phone_number || msg?.conversation?.contact_inbox?.source_id;

  // Pedido do usuário 27/08/2026: o bot passa a responder SÓ troca de praça.
  // Deslogar, respostas prontas, boas-vindas de novato e saudação ficam
  // desativados (a classificação ainda calcula esses campos -- só não agimos
  // sobre eles aqui).

  if (!classificacao?.eh_pedido_troca || !classificacao.praca_codigo) {
    return { acao: 'ignorado_sem_resposta' };
  }

  const entregador = await identificarEntregador(supabase, telefone, msg?.sender?.name);
  if (!entregador) {
    return { acao: 'ignorado_entregador_nao_identificado' };
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
  if (mensagemResposta) {
    await responder(chatwootToken, conversationId, mensagemResposta);
  }
  // "troca_ja_estava" (noop confirmado) separado de "troca_executada"
  // (mudança real) -- distinção adicionada 22/08/2026 pra facilitar
  // investigar esse tipo de caso no futuro sem precisar reabrir o
  // resultado bruto de cada linha.
  const ehNoop = resultado?.corpo_parceiro?.action === 'noop';
  const sucesso = mensagemResposta !== null;
  const acao = !sucesso ? 'troca_falhou_sem_resposta' : (ehNoop ? 'troca_ja_estava' : 'troca_executada');
  return { acao, praca: pracaCodigo, resultado };
}

type Classificacao = {
  eh_pedido_troca: boolean;
  praca_codigo: string | null;
  categoria: string | null;
  eh_pedido_deslogar: boolean;
  novato_etapa: string | null;
  saudacao: string | null;
};

// Quantas conversas entram numa chamada só à Claude. Decisão do usuário
// 13/08/2026: depois de estender o horário do bot pra quase 24h (mais
// mensagens = mais gasto), testamos prompt caching mas o texto fixo de
// instruções (~1450 tokens) fica ABAIXO do mínimo cacheável da Haiku
// (2048 tokens) -- confirmado ao vivo (cache_read_input_tokens sempre 0).
// Em vez disso, processa várias conversas pendentes numa chamada só: as
// instruções fixas são pagas 1x por lote, não 1x por conversa. Lote
// grande demais arrisca estourar max_tokens da resposta (JSON truncado =
// lote inteiro perdido) -- 15 é uma margem confortável.
const CLASSIFICACAO_LOTE_TAMANHO = 15;

function promptClassificacaoBase(): string {
  const listaPracas = Object.entries(PRACAS).map(([cod, nome]) => `${cod} = "${nome}"`).join('\n');
  const listaCategorias = Object.entries(CATEGORIAS_RESPOSTA_PRONTA).map(([cat, desc]) => `${cat} = ${desc}`).join('\n');
  return [
    'Você classifica mensagens de entregadores em UM destes 6 tipos:',
    '',
    '1) TROCA/ALOCAÇÃO DE PRAÇA (eh_pedido_troca: true) -- mudar ou definir a região/área onde vai',
    '   trabalhar. Trate como isso QUALQUER mensagem pedindo pra ser colocado/alocado/disponibilizado',
    '   pra trabalhar numa região agora, mesmo sem citar a palavra "praça". Exemplos:',
    '     "quero trocar de praça" -> praca_codigo: null (não disse qual)',
    '     "me agenda aí" -> praca_codigo: null',
    '     "pode me alocar em pinheiros?" -> praca_codigo: "PINHEIROS"',
    '     "será q consegue me colocar disponível agora na praça?" -> praca_codigo: null',
    '     "consegue me colocar na mooca?" -> praca_codigo: "MOOCA"',
    '     "Livre" (mensagem que é só o nome de uma praça válida, sozinho, sem mais nada) ->',
    '       eh_pedido_troca: true, praca_codigo: "LIVRE" -- é assim que muita gente pede, direto',
    '     Se uma praça válida foi mencionada mais atrás na conversa e depois só vieram mensagens',
    '     tipo "Oii", "Porfavor", "?" (cutucando, sem resposta ainda) -- ainda conta como pedido',
    '     daquela praça, mesmo a última mensagem sendo só o cutucão.',
    '',
    '2) DESLOGAR DO TURNO ATUAL (eh_pedido_deslogar: true) -- pedido pra sair/ser removido/desligado',
    '   do turno em andamento agora. "Deslogar", "desligar" e "tirar do turno" são sempre a MESMA',
    '   coisa aqui -- remover do turno. Vale tanto em linguagem informal quanto educada/formal:',
    '     "me desloga", "me desliga", "desativa", "me tira do turno", "me desconecta",',
    '     "quero sair do turno", "desloga eu", "poderia me deslogar por favor?",',
    '     "pode me desligar?", "gostaria de ser deslogado", "consegue me tirar do turno?".',
    '   Não exige a palavra exata "turno" -- "poderia me deslogar" sozinho já conta.',
    '',
    '3) Uma das categorias de resposta pronta abaixo (campo categoria):',
    listaCategorias,
    '',
    '4) BOAS-VINDAS DO NOVATO (campo novato_etapa) -- só se aplica se a conversa TIVER, mais atrás,',
    '   uma mensagem do atendente com "boa notícia" + "cadastro foi aprovado" (mensagem fixa de',
    '   aprovação). Se essa mensagem de aprovação NÃO estiver na conversa, novato_etapa é sempre null,',
    '   mesmo que o resto pareça bater. Se estiver, veja a ÚLTIMA mensagem do entregador:',
    '     Diz que não tem dúvida ("não", "não tenho", "tudo certo", "nenhuma") E o atendente ainda',
    '       não mandou as instruções completas ("Show! Vou te mandar...") -> novato_etapa: "sem_duvida"',
    '     Diz que tem dúvida mas SEM dizer qual ("tenho dúvida", "tenho uma pergunta") -> novato_etapa: "duvida_generica"',
    '     Se o atendente JÁ perguntou "Qual sua dúvida?" e essa resposta esclarece do que se trata:',
    '       sobre o mapa/localização -> novato_etapa: "duvida_mapa"',
    '       sobre horário/turnos -> novato_etapa: "duvida_horario"',
    '       sobre como se agendar/começar a trabalhar -> novato_etapa: "duvida_agendamento"',
    '     Se a dúvida for sobre repasse/pagamento/receber dinheiro, OU não ficou claro do que se',
    '       trata -> novato_etapa: null (assunto financeiro fica só com atendimento humano; não',
    '       adivinhe o resto)',
    '',
    '5) SAUDAÇÃO SOZINHA (campo saudacao) -- a mensagem é SÓ um cumprimento, sem pedir mais nada',
    '   junto (nem antes na conversa sem resposta, nem na própria mensagem). "Bom dia", "Boa tarde",',
    '   "Boa noite", "Oi", "Olá" sozinhos (com ou sem pontuação/emoji) contam. Valores possíveis:',
    '     "bom dia" -> saudacao: "bom_dia"',
    '     "boa tarde" -> saudacao: "boa_tarde"',
    '     "boa noite" -> saudacao: "boa_noite"',
    '     "oi"/"olá"/cumprimento genérico sem período do dia -> saudacao: "generica"',
    '   NÃO use essa categoria se a mensagem tiver qualquer outro pedido junto (ex.: "Bom dia,',
    '   poderia me deslogar" é DESLOGAR, não saudação -- o pedido de verdade sempre tem prioridade).',
    '',
    '6) Nenhum dos cinco (pagamento fora do listado acima, nota fiscal, reclamação, agradecimento',
    '   sozinho, dúvida geral) -- todos os campos false/null.',
    '',
    'Praças válidas (só usadas se eh_pedido_troca for true):',
    listaPracas,
  ].join('\n');
}

// classificarPedidosEmLote: classifica N conversas numa chamada só à
// Claude (N pode ser 1). Cada conversa recebe um índice (0..N-1) no
// prompt, e a resposta é um array reordenado por esse mesmo índice --
// assim, mesmo que a Claude devolva os itens fora de ordem, o resultado
// [i] sempre corresponde a contextos[i].
async function classificarPedidosEmLote(contextos: string[][]): Promise<(Classificacao | null)[]> {
  const conversasTexto = contextos
    .map((ctx, i) => `Conversa ${i}:\n${ctx.join('\n')}`)
    .join('\n\n');

  const prompt = [
    promptClassificacaoBase(),
    '',
    contextos.length > 1
      ? `Você recebe ${contextos.length} conversas numeradas abaixo (cada uma rotulada "Conversa N:",`
      : 'Você recebe uma conversa (rotulada "Conversa 0:",',
    'mensagens mais recente por último, rotuladas "entregador" ou "atendente"). Classifique CADA',
    'conversa independentemente, aplicando as regras acima. Responda APENAS um JSON válido (um',
    'array), sem markdown, no formato:',
    '[{"id": 0, "eh_pedido_troca": true|false, "praca_codigo": "CODIGO_EXATO_DA_LISTA" ou null, "categoria": "NOME_DA_CATEGORIA" ou null, "eh_pedido_deslogar": true|false, "novato_etapa": "sem_duvida"|"duvida_generica"|"duvida_mapa"|"duvida_horario"|"duvida_agendamento" ou null, "saudacao": "bom_dia"|"boa_tarde"|"boa_noite"|"generica" ou null}, ...]',
    `Devolva exatamente ${contextos.length} objeto(s), um pra cada conversa numerada de 0 a ${contextos.length - 1},`,
    'com o campo "id" batendo com o número da conversa (a ordem dos objetos no array não importa,',
    'o "id" que importa).',
    '',
    'praca_codigo só deve vir preenchido se uma praça específica da lista foi mencionada com clareza.',
    'No máximo UM entre eh_pedido_troca, categoria, eh_pedido_deslogar, novato_etapa e saudacao deve',
    'indicar positivo por vez pra cada conversa -- se tiver qualquer dúvida sobre qual, prefira deixar',
    'tudo negativo/null pra aquela conversa.',
    '',
    conversasTexto,
  ].join('\n');

  // ~80 tokens de folga por item de resposta + margem fixa pro resto do JSON.
  const maxTokens = Math.min(4096, 80 * contextos.length + 150);
  const resultado = await chamarGemini(prompt, maxTokens);

  if (!Array.isArray(resultado)) {
    throw new Error(`Classificação em lote não veio como array: ${JSON.stringify(resultado)}`);
  }
  const porId = new Map(resultado.map((r: any) => [r?.id, r]));
  return contextos.map((_, i) => (porId.get(i) as Classificacao) ?? null);
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

  return await chamarGemini(prompt);
}

// Trocado de Claude pra Gemini 2.5 Flash em 20/08/2026 -- pedido do
// usuário depois que os créditos da Anthropic acabaram e a recarga
// mínima do proxy residencial (DataImpulse) ficou inviável no mesmo mês.
// Gemini tem tier gratuito (sem cartão) suficiente pro nosso volume, já
// que o processamento em lote (ver classificarPedidosEmLote) já reduz
// bastante o número de chamadas por ciclo.
//
// Modelo: gemini-3.5-flash-lite (trocado de gemini-2.5-flash em
// 20/08/2026) -- testado ao vivo com os mesmos casos usados pra validar
// o 2.5-flash (troca de praça, deslogar formal, "Livre" sozinho,
// pergunta financeira) e manteve a mesma qualidade de classificação,
// mas com cota gratuita de 15 req/min em vez de 5 req/min (confirmado
// contra o erro 429 real da API, não documentação de terceiros) -- mais
// folga pra absorver picos de mensagens/backlog depois de um período
// fora do ar. Esse modelo não aceita thinkingConfig (dá 400) -- já não
// gasta tokens de raciocínio por padrão, então nem precisa.
async function chamarGemini(prompt: string, maxTokens = 150): Promise<any> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          // Força saída JSON de verdade -- diferente do Claude, que às
          // vezes envolvia a resposta em ```json ... ``` apesar da
          // instrução, quebrando o JSON.parse silenciosamente.
          responseMimeType: 'application/json',
        },
      }),
    },
  );

  const json = await response.json();
  if (!response.ok) throw new Error(`Gemini API (${response.status}): ${json.error?.message || JSON.stringify(json)}`);

  var candidato = json.candidates?.[0];
  // finishReason "MAX_TOKENS" com response vazio = o maxTokens passado
  // era pequeno demais pro tamanho do lote -- melhor saber disso do que
  // silenciosamente devolver null.
  if (candidato?.finishReason === 'MAX_TOKENS' && !candidato?.content?.parts?.length) {
    throw new Error(`Gemini cortou a resposta por MAX_TOKENS (maxOutputTokens=${maxTokens}) antes de gerar qualquer conteúdo.`);
  }
  const texto = candidato?.content?.parts?.[0]?.text?.trim() || '{}';

  try {
    return JSON.parse(texto);
  } catch (e) {
    console.error('Falha ao parsear resposta do Gemini:', texto, e);
    return null;
  }
}

// Casos reais 21-22/08/2026: a mesma chamada que retornava
// "troca_falhou_sem_resposta" (silêncio, atendente tinha que
// investigar/reexecutar na mão) às vezes dava certo de cara ao tentar
// de novo, sem mudar CPF nem praça -- indica falha intermitente do lado
// do parceiro, não um problema de dado. Um retry de 3x/2s (~4s de
// cobertura) NÃO foi suficiente -- viu-se falha nas 3 tentativas mesmo
// assim, resolvida só minutos depois manualmente (22/08/2026, caso do
// Wellington). Backoff progressivo até ~14s de cobertura -- mais que
// antes, mas sem deixar UMA troca travada demorar tanto que arrisque o
// timeout do ciclo inteiro se várias falharem juntas no mesmo lote.
async function executarTroca(cpf: string, pracaCodigo: string) {
  const url = 'https://api-automaturno.rly9ea.easypanel.host/admin/f1c488c58cbd6cea2ac17df3f5d5b5be/trocar';
  const ESPERAS_MS = [2000, 4000, 8000]; // 4 tentativas, ~14s de cobertura total
  let ultimoResultado: any = null;
  for (let tentativa = 1; tentativa <= ESPERAS_MS.length + 1; tentativa++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf, subpraca_id: pracaCodigo }),
      });
      const dados = await response.json();
      ultimoResultado = dados; // { status_parceiro, corpo_parceiro: { success, action, subPraca, ... } }
      const statusOk = dados?.status_parceiro >= 200 && dados?.status_parceiro < 300 && dados?.corpo_parceiro?.success !== false;
      if (statusOk) return dados;
    } catch (err) {
      ultimoResultado = { status_parceiro: 0, corpo_parceiro: { success: false, error: String(err) } };
    }
    const espera = ESPERAS_MS[tentativa - 1];
    if (espera) await new Promise((r) => setTimeout(r, espera));
  }
  return ultimoResultado;
}

// Retorna null quando não deu certo (noop ou erro) -- nesse caso não
// responde nada pro entregador, fica só registrado (chatwoot_mensagens_processadas)
// pra quem está no atendimento revisar manualmente. Pedido do usuário
// 06/08/2026: falha silenciosa pro entregador, não silenciosa pro time.
function formatarResposta(resultado: any): string | null {
  const corpo = resultado?.corpo_parceiro;
  const statusOk = resultado?.status_parceiro >= 200 && resultado?.status_parceiro < 300 && corpo?.success !== false;

  if (statusOk && corpo?.action === 'noop') {
    return respostaNoop();
  }
  if (statusOk) {
    return respostaSucesso();
  }
  return null;
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
