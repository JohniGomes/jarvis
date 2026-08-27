// Importa a planilha semanal de "Sem NF" (Acompanhamento de Repasse do
// financeiro) -- o painel faz o parse do .xlsx no navegador (SheetJS) e
// manda as linhas já estruturadas aqui. Essa função só valida e grava,
// sempre substituindo o snapshot das datas de repasse presentes no upload
// (não é incremental -- se reenviar a mesma semana, substitui, não duplica).
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

type LinhaSemNf = {
  cpf: string;
  data_repasse_previsto: string; // YYYY-MM-DD
  id_entregador?: string | null;
  nome: string;
  cidade?: string | null;
  matriz?: string | null;
  valor_a_emitir_nf?: number | null;
  telefone?: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { linhas } = (await req.json()) as { linhas: LinhaSemNf[] };
    if (!Array.isArray(linhas) || linhas.length === 0) {
      return jsonResponse({ error: 'Nenhuma linha pra importar.' }, 400);
    }

    const linhasValidas: LinhaSemNf[] = [];
    const invalidas: any[] = [];
    for (const l of linhas) {
      const cpfDigits = String(l.cpf || '').replace(/\D/g, '').padStart(11, '0');
      const dataOk = /^\d{4}-\d{2}-\d{2}$/.test(String(l.data_repasse_previsto || ''));
      if (cpfDigits.length !== 11 || cpfDigits === '00000000000' || !l.nome?.trim() || !dataOk) {
        invalidas.push(l);
        continue;
      }
      linhasValidas.push({
        cpf: cpfDigits,
        data_repasse_previsto: l.data_repasse_previsto,
        id_entregador: l.id_entregador || null,
        nome: l.nome.trim(),
        cidade: l.cidade || null,
        matriz: l.matriz || null,
        valor_a_emitir_nf: l.valor_a_emitir_nf ?? null,
        telefone: l.telefone ? String(l.telefone).replace(/\D/g, '') : null,
      });
    }

    if (linhasValidas.length === 0) {
      return jsonResponse({ error: 'Nenhuma linha válida (confira CPF, nome e data).', invalidas: invalidas.length }, 400);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Substitui inteiro o snapshot das datas de repasse presentes nesse
    // upload -- reenviar a mesma planilha (ex.: financeiro corrigiu algo)
    // não duplica linha, só atualiza.
    const datasUnicas = Array.from(new Set(linhasValidas.map((l) => l.data_repasse_previsto)));
    const { error: delError } = await supabase.from('sem_nf').delete().in('data_repasse_previsto', datasUnicas);
    if (delError) return jsonResponse({ error: 'Erro ao limpar dados antigos: ' + delError.message }, 500);

    const { error: insError } = await supabase.from('sem_nf').insert(linhasValidas);
    if (insError) return jsonResponse({ error: 'Erro ao gravar: ' + insError.message }, 500);

    return jsonResponse({ ok: true, importadas: linhasValidas.length, invalidas: invalidas.length, datas: datasUnicas });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
