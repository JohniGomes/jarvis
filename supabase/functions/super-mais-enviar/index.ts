// Botão "Enviar" da campanha Super Mais (aba Campanhas) -- o navegador
// manda só o CPF (mesmo padrão de segurança do send-chatwoot: nunca
// telefone/nome direto), essa função busca a pessoa e decide como mandar:
//
//   - Se já existe conversa com ela E a janela de 24h do WhatsApp está
//     aberta (can_reply true) -> manda a mensagem personalizada da
//     campanha, texto livre.
//   - Senão (nunca conversou, ou janela fechada) -> manda o template já
//     aprovado "aprovado_com_promo" (mesmo usado no Sem Corridas) --
//     texto fixo dele, não dá pra personalizar fora de template aprovado
//     pelo WhatsApp. Decisão do usuário 10/08/2026: aceitar essa
//     diferença em vez de esperar aprovação de um template novo.
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
const CHATWOOT_INBOX_ID = 22;
const CHATWOOT_TEMPLATE_NAME = 'aprovado_com_promo';
const CHATWOOT_TEMPLATE_CATEGORY = 'MARKETING';
const CHATWOOT_TEMPLATE_LANGUAGE = 'pt_BR';

const CAMP_PRAZO_DIAS = 20; // precisa ficar igual ao CAMP_PRAZO_DIAS do index.html

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { cpf } = await req.json();
    const cpfDigits = String(cpf || '').replace(/\D/g, '').padStart(11, '0');
    if (!cpfDigits || cpfDigits === '00000000000') {
      return jsonResponse({ error: 'Informe um CPF válido.' }, 400);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: jaEnviado } = await supabase
      .from('super_mais_envios')
      .select('cpf')
      .eq('cpf', cpfDigits)
      .maybeSingle();
    if (jaEnviado) {
      return jsonResponse({ error: 'Mensagem já enviada pra esse CPF antes.' }, 409);
    }

    const { data: pessoa, error: dbError } = await supabase
      .from('entregadores')
      .select('nome, telefone, data_aprovacao')
      .eq('cpf', cpfDigits)
      .maybeSingle();

    if (dbError) return jsonResponse({ error: 'Erro ao consultar entregadores: ' + dbError.message }, 500);
    if (!pessoa) return jsonResponse({ error: 'CPF não encontrado no roster de entregadores.' }, 404);
    if (!pessoa.telefone) return jsonResponse({ error: 'Telefone em branco pra esse CPF.' }, 400);
    if (!pessoa.data_aprovacao) return jsonResponse({ error: 'Sem data de aprovação pra esse CPF.' }, 400);

    const token = Deno.env.get('CHATWOOT_TOKEN');
    if (!token) return jsonResponse({ error: 'CHATWOOT_TOKEN não configurado nos secrets da função.' }, 500);

    const primeiroNome = (pessoa.nome || '').trim().split(/\s+/)[0] || pessoa.nome;
    const prazo = calcularPrazo(pessoa.data_aprovacao);
    const mensagemPersonalizada =
      `Faala ${primeiroNome}, você está elegível a promo SUPER MAIS e tem até o dia ${prazo} ` +
      `para concluir 200 entregas e colocar +R$1.800 extra no bolso. Bora rodar?`;

    const headers = { api_access_token: token, 'Content-Type': 'application/json' };
    const base = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`;

    const conversaAberta = await conversaComJanelaAberta(pessoa.telefone, headers, base);

    let resultado;
    let tipo: string;
    if (conversaAberta) {
      await enviarMensagemLivre(conversaAberta, mensagemPersonalizada, headers, base);
      resultado = { ok: true, tipo: 'personalizada', conversationId: conversaAberta };
      tipo = 'personalizada';
    } else {
      resultado = await enviarTemplate(pessoa.telefone, pessoa.nome, cpfDigits, headers, base);
      tipo = 'template';
    }

    await supabase.from('super_mais_envios').upsert({ cpf: cpfDigits, tipo, enviado_em: new Date().toISOString() });

    return jsonResponse(resultado);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

function calcularPrazo(dataAprovacaoISO: string): string {
  const aprovacao = new Date(dataAprovacaoISO + 'T00:00:00');
  const prazo = new Date(aprovacao);
  prazo.setDate(prazo.getDate() + CAMP_PRAZO_DIAS);
  const dia = String(prazo.getDate()).padStart(2, '0');
  const mes = String(prazo.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}`;
}

async function conversaComJanelaAberta(telefoneDigits: string, headers: Record<string, string>, base: string): Promise<number | null> {
  const respContato = await fetch(`${base}/contacts/search?q=${encodeURIComponent(telefoneDigits)}`, { headers });
  if (!respContato.ok) return null;
  const contatoJson = await respContato.json();
  const contactId = contatoJson.payload?.[0]?.id;
  if (!contactId) return null;

  const respConv = await fetch(`${base}/contacts/${contactId}/conversations`, { headers });
  if (!respConv.ok) return null;
  const convJson = await respConv.json();
  const aberta = (convJson.payload || []).find((c: any) => c.can_reply === true);
  return aberta ? aberta.id : null;
}

async function enviarMensagemLivre(conversationId: number, content: string, headers: Record<string, string>, base: string) {
  const response = await fetch(`${base}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, message_type: 'outgoing' }),
  });
  if (!response.ok) {
    throw new Error(`Chatwoot (enviar mensagem) respondeu ${response.status}: ${await response.text()}`);
  }
}

function formatCpf(cpfDigits: string): string {
  if (cpfDigits.length !== 11) return cpfDigits;
  return `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`;
}

async function enviarTemplate(telefoneDigits: string, nomeCompleto: string, cpfDigits: string, headers: Record<string, string>, base: string) {
  const nomeComCpf = `${nomeCompleto} - ${formatCpf(cpfDigits)}`;

  let contactId = await findChatwootContactId(telefoneDigits, headers, base);
  if (!contactId) {
    contactId = await createChatwootContact(telefoneDigits, nomeComCpf, headers, base);
  } else {
    await updateChatwootContactName(contactId, nomeComCpf, headers, base);
  }

  const primeiroNome = (nomeCompleto || '').trim().split(/\s+/)[0] || nomeCompleto;
  const payload = {
    inbox_id: CHATWOOT_INBOX_ID,
    contact_id: contactId,
    message: {
      template_params: {
        name: CHATWOOT_TEMPLATE_NAME,
        category: CHATWOOT_TEMPLATE_CATEGORY,
        language: CHATWOOT_TEMPLATE_LANGUAGE,
        processed_params: { '1': primeiroNome },
      },
    },
  };

  const response = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Chatwoot respondeu ${response.status}: ${await response.text()}`);
  }
  const json = await response.json();
  return { ok: true, tipo: 'template', conversationId: json.id };
}

async function findChatwootContactId(telefoneDigits: string, headers: Record<string, string>, base: string) {
  const response = await fetch(`${base}/contacts/search?q=${encodeURIComponent(telefoneDigits)}`, { headers });
  if (!response.ok) return null;
  const json = await response.json();
  return json.payload?.[0]?.id ?? null;
}

async function createChatwootContact(telefoneDigits: string, nomeComCpf: string, headers: Record<string, string>, base: string) {
  const response = await fetch(`${base}/contacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ inbox_id: CHATWOOT_INBOX_ID, name: nomeComCpf, phone_number: `+${telefoneDigits}` }),
  });
  if (!response.ok) {
    throw new Error(`Chatwoot (criar contato) respondeu ${response.status}: ${await response.text()}`);
  }
  const json = await response.json();
  return json.payload.contact.id;
}

async function updateChatwootContactName(contactId: number, nomeComCpf: string, headers: Record<string, string>, base: string) {
  try {
    await fetch(`${base}/contacts/${contactId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: nomeComCpf }),
    });
  } catch (_err) {
    // ignora -- best-effort
  }
}
