// Recebe o clique de "Liberar Agendamento" / "Bloquear Agendamento" do
// painel (aba Desempenho por entregador) -- porta pro padrão já usado no
// send-chatwoot: o navegador manda só o CPF (nunca o ifood_id direto), essa
// função busca o ifood_id na tabela entregadores (service_role, ignora RLS)
// e grava um pedido pendente em agendamento_status. Quem executa de
// verdade é o robots/agendamento_watcher.py, rodando na máquina local (o
// site franqueado.entregolog.com bloqueia IP de nuvem/datacenter).
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { cpf, acao } = await req.json();
    if (acao !== 'liberar' && acao !== 'bloquear') {
      return jsonResponse({ error: 'Ação inválida -- use "liberar" ou "bloquear".' }, 400);
    }
    const cpfDigits = String(cpf || '').replace(/\D/g, '').padStart(11, '0');
    if (!cpfDigits || cpfDigits === '00000000000') {
      return jsonResponse({ error: 'Informe um CPF válido.' }, 400);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: entregador, error: dbError } = await supabase
      .from('entregadores')
      .select('nome, ifood_id')
      .eq('cpf', cpfDigits)
      .maybeSingle();

    if (dbError) return jsonResponse({ error: 'Erro ao consultar entregadores: ' + dbError.message }, 500);
    if (!entregador) return jsonResponse({ error: 'CPF não encontrado no roster de entregadores.' }, 404);
    if (!entregador.ifood_id) {
      return jsonResponse({ error: 'Esse entregador ainda não tem ifood_id cadastrado -- espere o próximo robô de sincronização (entregadores_sync) rodar.' }, 400);
    }

    const { error: upsertError } = await supabase
      .from('agendamento_status')
      .upsert(
        {
          cpf: cpfDigits,
          ifood_id: entregador.ifood_id,
          nome: entregador.nome,
          pendente: acao,
          erro_msg: null,
        },
        { onConflict: 'cpf' },
      );

    if (upsertError) return jsonResponse({ error: 'Erro ao gravar pedido: ' + upsertError.message }, 500);

    return jsonResponse({ ok: true, pendente: acao });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
