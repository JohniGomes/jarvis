// Botão "Atualizar" da aba Análise (card de preenchimento de vagas) --
// aciona o workflow sync-escalas.yml no GitHub Actions via
// workflow_dispatch, que roda robots/escalas_vagas.py e grava o resultado
// em escalas_vagas. O token do GitHub (secret GITHUB_ACTIONS_TOKEN, escopo
// mínimo "actions: write" + "contents: read" no repo) nunca é exposto ao
// navegador -- mesmo padrão de segredo-só-no-servidor usado no resto do
// painel (ex.: CPF em vez de ifood_id direto no agendamento-toggle).
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

const REPO = 'JohniGomes/jarvis';
const WORKFLOW_FILE = 'sync-escalas.yml';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const token = Deno.env.get('GITHUB_ACTIONS_TOKEN');
    if (!token) return jsonResponse({ error: 'GITHUB_ACTIONS_TOKEN não configurado nos secrets da function.' }, 500);

    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'entrego-painel',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );

    if (resp.status !== 204) {
      const texto = await resp.text();
      return jsonResponse({ error: `GitHub API retornou ${resp.status}: ${texto}` }, 502);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
