// Envio do lembrete de nota fiscal pendente (aba "Sem NF") via WhatsApp
// Business (Chatwoot), template "sem_nf" com o primeiro nome como variável.
// Mesmo padrão de segurança do send-chatwoot: o navegador manda só CPF +
// data de repasse, nunca telefone/nome direto -- essa função resolve tudo
// server-side (service_role, ignora RLS).
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
const CHATWOOT_TEMPLATE_NAME = 'sem_nf';
// "UTILITY" (lembrete transacional/administrativo) em vez de "MARKETING" --
// ajustar aqui se o template tiver sido aprovado sob outra categoria no
// WhatsApp Business Manager (a chamada falha com erro claro se a
// categoria não bater com a registrada, dá pra corrigir na hora).
const CHATWOOT_TEMPLATE_CATEGORY = 'UTILITY';
const CHATWOOT_TEMPLATE_LANGUAGE = 'pt_BR';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { cpf, data_repasse_previsto } = await req.json();
    const cpfDigits = String(cpf || '').replace(/\D/g, '').padStart(11, '0');
    const dataOk = /^\d{4}-\d{2}-\d{2}$/.test(String(data_repasse_previsto || ''));
    if (!cpfDigits || cpfDigits === '00000000000' || !dataOk) {
      return jsonResponse({ error: 'Informe um CPF e data_repasse_previsto válidos.' }, 400);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Trava servidor-side contra reenvio -- por (cpf, semana), não só cpf:
    // a mesma pessoa deve poder receber o lembrete de novo numa semana
    // seguinte se continuar sem emitir.
    const { data: jaEnviado } = await supabase
      .from('chatwoot_envios_sem_nf')
      .select('cpf')
      .eq('cpf', cpfDigits)
      .eq('data_repasse_previsto', data_repasse_previsto)
      .maybeSingle();
    if (jaEnviado) {
      return jsonResponse({ error: 'Mensagem já enviada pra esse CPF nessa semana.' }, 409);
    }

    const { data: pessoa, error: dbError } = await supabase
      .from('sem_nf')
      .select('nome, telefone')
      .eq('cpf', cpfDigits)
      .eq('data_repasse_previsto', data_repasse_previsto)
      .maybeSingle();

    if (dbError) return jsonResponse({ error: 'Erro ao consultar sem_nf: ' + dbError.message }, 500);
    if (!pessoa) return jsonResponse({ error: 'CPF não encontrado na lista de Sem NF pra essa semana.' }, 404);
    if (!pessoa.telefone) return jsonResponse({ error: 'Telefone em branco pra esse CPF.' }, 400);

    const token = Deno.env.get('CHATWOOT_TOKEN');
    if (!token) return jsonResponse({ error: 'CHATWOOT_TOKEN não configurado nos secrets da função.' }, 500);

    const result = await sendChatwootTemplate(pessoa.telefone, pessoa.nome, cpfDigits, token);

    // Só grava como enviado depois do Chatwoot confirmar -- se o envio
    // falhar, o botão continua disponível pra tentar de novo.
    await supabase.from('chatwoot_envios_sem_nf').upsert({
      cpf: cpfDigits,
      data_repasse_previsto,
      enviado_em: new Date().toISOString(),
    });

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

function formatCpf(cpfDigits: string): string {
  if (cpfDigits.length !== 11) return cpfDigits;
  return `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`;
}

async function sendChatwootTemplate(telefoneRaw: string, nomeCompleto: string, cpfDigits: string, token: string) {
  const headers = { api_access_token: token, 'Content-Type': 'application/json' };
  const base = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}`;
  let telefoneDigits = String(telefoneRaw || '').replace(/\D/g, '');
  if (telefoneDigits.length === 10 || telefoneDigits.length === 11) telefoneDigits = '55' + telefoneDigits;

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
  return { ok: true, conversationId: json.id };
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
