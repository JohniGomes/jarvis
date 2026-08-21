// Resumo com IA (aba Análise) -- porta de generateAnalysisSummary/
// buildAnalysisPrompt do Code.gs. A chave da API nunca passa pelo
// navegador nem fica no código -- vive só nos Secrets da função.
// O painel (index.html) é público e roda num domínio diferente (GitHub
// Pages) do Supabase, então a função precisa liberar CORS explicitamente.
//
// Trocado de Claude pra Gemini 2.5 Flash em 20/08/2026 -- pedido do
// usuário depois que os créditos da Anthropic acabaram (ver mesma
// decisão em chatwoot-troca-praca/index.ts).
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

interface AnalysisData {
  periodo?: string;
  aderenciaPct?: number;
  tempoOnlinePct?: number;
  horasEsperadas?: number;
  totalDrivers?: number;
  noShowCount?: number;
  noShowPct?: number;
  lowOnlineCount?: number;
  lowOnlinePct?: number;
  rejectionNames?: string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const data: AnalysisData = await req.json();
    const text = await generateAnalysisSummary(data);
    return jsonResponse({ text });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

async function generateAnalysisSummary(data: AnalysisData): Promise<string> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada nos secrets da função (supabase secrets set GEMINI_API_KEY=...).');
  }

  // gemini-3.5-flash-lite (trocado de gemini-2.5-flash em 20/08/2026,
  // mesmo motivo de chatwoot-troca-praca/index.ts) -- cota gratuita de
  // 15 req/min em vez de 5. Não aceita thinkingConfig (400) mas também
  // não gasta tokens de raciocínio por padrão, então não precisa.
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildAnalysisPrompt(data) }] }],
        generationConfig: { maxOutputTokens: 700 },
      }),
    },
  );

  const json = await response.json();
  if (!response.ok) {
    const msg = json.error?.message || JSON.stringify(json);
    throw new Error(`Erro na API do Gemini (${response.status}): ${msg}`);
  }
  return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function buildAnalysisPrompt(data: AnalysisData): string {
  return [
    'Você é um analista de operações de logística de última milha (entregadores freelancers via app).',
    'Escreva um resumo executivo curto (no máximo 6 frases, em português do Brasil, tom direto e',
    'prático, sem markdown) sobre o desempenho do período abaixo, destacando os problemas mais',
    'acionáveis e terminando com uma recomendação objetiva do que priorizar primeiro.',
    '',
    `Período: ${data.periodo ?? 'não informado'}`,
    `Aderência: ${data.aderenciaPct != null ? data.aderenciaPct + '%' : 'n/d'}`,
    `Tempo Online do time: ${data.tempoOnlinePct != null ? data.tempoOnlinePct + '%' : 'n/d'}`,
    `Horas esperadas no período: ${data.horasEsperadas != null ? data.horasEsperadas + 'h' : 'n/d'}`,
    `Entregadores agendados: ${data.totalDrivers ?? 'n/d'}`,
    `Não compareceram nenhum turno: ${data.noShowCount ?? 'n/d'} (${data.noShowPct != null ? data.noShowPct + '%' : 'n/d'} dos agendados)`,
    `Compareceram mas ficaram menos da metade do turno online: ${data.lowOnlineCount ?? 'n/d'} (${data.lowOnlinePct != null ? data.lowOnlinePct + '%' : 'n/d'} de quem veio)`,
    `Entregadores que recusaram 90%+ das corridas ofertadas (com 5+ ofertadas): ${data.rejectionNames?.length ? data.rejectionNames.join(', ') : 'nenhum'}`,
  ].join('\n');
}
