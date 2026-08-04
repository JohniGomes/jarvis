// Envio de mensagem via Chatwoot (WhatsApp Business API) -- porta de
// sendChatwootParaSemCorridas/sendChatwootTemplate do Code.gs.
//
// O navegador manda só o CPF (nunca telefone/nome): essa função busca a
// pessoa direto na tabela sem_corridas (usando a service_role key, que
// ignora RLS) e só envia se achar -- o painel é público, sem essa
// validação servidor-side qualquer um poderia montar a chamada na mão e
// mandar mensagem de WhatsApp Business pra um número qualquer, usando a
// conta da empresa.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// O painel (index.html) é público e roda num domínio diferente (GitHub
// Pages) do Supabase, então a função precisa liberar CORS explicitamente.
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

    const { data: pessoa, error: dbError } = await supabase
      .from('sem_corridas')
      .select('nome, telefone')
      .eq('cpf', cpfDigits)
      .maybeSingle();

    if (dbError) return jsonResponse({ error: 'Erro ao consultar sem_corridas: ' + dbError.message }, 500);
    if (!pessoa) return jsonResponse({ error: 'CPF não encontrado na lista de Sem Corridas.' }, 404);
    if (!pessoa.telefone) return jsonResponse({ error: 'Telefone em branco pra esse CPF.' }, 400);

    const token = Deno.env.get('CHATWOOT_TOKEN');
    if (!token) return jsonResponse({ error: 'CHATWOOT_TOKEN não configurado nos secrets da função.' }, 500);

    const result = await sendChatwootTemplate(pessoa.telefone, pessoa.nome, token);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

async function sendChatwootTemplate(telefoneDigits: string, nomeCompleto: string, token: string) {
  const headers = { api_access_token: token, 'Content-Type': 'application/json' };
  const base = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`;

  let contactId = await findChatwootContactId(telefoneDigits, headers, base);
  if (!contactId) {
    contactId = await createChatwootContact(telefoneDigits, nomeCompleto, headers, base);
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
  return { ok: true, conversationId: json.id };
}

async function findChatwootContactId(telefoneDigits: string, headers: Record<string, string>, base: string) {
  const response = await fetch(`${base}/contacts/search?q=${encodeURIComponent(telefoneDigits)}`, { headers });
  if (!response.ok) return null;
  const json = await response.json();
  return json.payload?.[0]?.id ?? null;
}

async function createChatwootContact(telefoneDigits: string, nomeCompleto: string, headers: Record<string, string>, base: string) {
  const response = await fetch(`${base}/contacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ inbox_id: CHATWOOT_INBOX_ID, name: nomeCompleto, phone_number: `+${telefoneDigits}` }),
  });
  if (!response.ok) {
    throw new Error(`Chatwoot (criar contato) respondeu ${response.status}: ${await response.text()}`);
  }
  const json = await response.json();
  return json.payload.contact.id;
}
