// Poller de troca de praça -- chamado a cada minuto pelo pg_cron (ver
// supabase/chatwoot_poll_cron.sql). Não usamos webhook do Chatwoot porque
// o token que temos é de Agente, não Administrador (só admin consegue
// configurar webhooks pela UI/API do Chatwoot).
//
// Em vez disso: varre as conversas abertas, acha mensagens novas de
// contato (entregador) que ainda não estão em chatwoot_mensagens_processadas,
// usa a Claude API pra identificar se é um pedido de troca de praça e qual
// praça, e se tiver confiança executa a troca direto na API do parceiro
// (via o painel automaturno) e responde na conversa sozinho. Sem confiança
// (CPF não encontrado, praça ambígua, não é pedido de troca), marca como
// processada sem agir -- fica pro atendimento humano normal.
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const chatwootToken = Deno.env.get('CHATWOOT_TOKEN')!;

    const conversas = await listarConversasAbertas(chatwootToken);
    const processados: any[] = [];

    for (const conv of conversas) {
      const msg = conv.last_non_activity_message;
      if (!msg || msg.sender_type !== 'Contact' && msg?.sender?.type !== 'contact') continue;
      if (!msg.content?.trim()) continue;

      const { data: jaProcessada } = await supabase
        .from('chatwoot_mensagens_processadas')
        .select('message_id')
        .eq('message_id', msg.id)
        .maybeSingle();
      if (jaProcessada) continue;

      const resultado = await processarMensagem(supabase, chatwootToken, conv.id, msg);
      processados.push({ conversation_id: conv.id, message_id: msg.id, ...resultado });

      await supabase.from('chatwoot_mensagens_processadas').insert({
        message_id: msg.id,
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

async function processarMensagem(supabase: any, chatwootToken: string, conversationId: number, msg: any) {
  const telefone = msg?.sender?.phone_number || msg?.conversation?.contact_inbox?.source_id;
  if (!telefone) return { acao: 'ignorado_sem_telefone' };

  const telefoneDigits = String(telefone).replace(/\D/g, '');
  const { data: entregador } = await supabase
    .from('entregadores')
    .select('cpf, nome')
    .eq('telefone', telefoneDigits)
    .maybeSingle();

  if (!entregador) return { acao: 'ignorado_cpf_nao_encontrado' };

  const classificacao = await classificarPedido(msg.content);
  if (!classificacao || !classificacao.praca_codigo || !(classificacao.praca_codigo in PRACAS)) {
    return { acao: 'ignorado_nao_e_troca_praca' };
  }

  const resultado = await executarTroca(entregador.cpf, classificacao.praca_codigo);
  const mensagemResposta = formatarResposta(resultado, classificacao.praca_codigo);
  await enviarMensagemChatwoot(chatwootToken, conversationId, mensagemResposta);

  return { acao: 'troca_executada', praca: classificacao.praca_codigo, resultado };
}

async function classificarPedido(mensagem: string): Promise<{ praca_codigo: string | null } | null> {
  const apiKey = Deno.env.get('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY não configurada.');

  const listaPracas = Object.entries(PRACAS).map(([cod, nome]) => `${cod} = "${nome}"`).join('\n');
  const prompt = [
    'Você identifica se uma mensagem de WhatsApp de um entregador é um pedido claro de TROCA DE PRAÇA',
    '(mudar a região/área onde ele trabalha). Praças válidas:',
    listaPracas,
    '',
    'Responda APENAS um JSON válido, sem markdown, no formato:',
    '{"praca_codigo": "CODIGO_EXATO_DA_LISTA"}',
    'Se a mensagem não for um pedido de troca de praça, ou a praça desejada não estiver clara/não',
    'bater com nenhuma da lista, responda {"praca_codigo": null}.',
    '',
    `Mensagem do entregador: "${mensagem}"`,
  ].join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const json = await response.json();
  if (!response.ok) throw new Error(`Claude API (${response.status}): ${json.error?.message || JSON.stringify(json)}`);

  const texto = json.content?.[0]?.text?.trim() || '{}';
  try {
    return JSON.parse(texto);
  } catch {
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

function formatarResposta(resultado: any, pracaCodigo: string): string {
  const nomePraca = PRACAS[pracaCodigo];
  const corpo = resultado?.corpo_parceiro;
  const statusOk = resultado?.status_parceiro >= 200 && resultado?.status_parceiro < 300 && corpo?.success !== false;

  if (statusOk && corpo?.action === 'noop') {
    return 'Não consegui confirmar a troca agora -- o sistema não fez nenhuma alteração. Pode tentar de novo em instantes ou aguardar que alguém da equipe confira.';
  }
  if (statusOk) {
    return `Pronto! Troca pra ${nomePraca} feita com sucesso. ✅`;
  }
  return `Não consegui fazer a troca pra ${nomePraca} agora -- vou pedir pra alguém da equipe verificar e te retornar.`;
}

async function enviarMensagemChatwoot(token: string, conversationId: number, content: string) {
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
