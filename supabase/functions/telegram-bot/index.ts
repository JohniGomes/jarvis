// Agente conversacional de troca de praça -- versão Telegram (migrado do
// Chatwoot em 27/08/2026, pedido do usuário). Diferente do Chatwoot, aqui
// não tem polling: o Telegram chama esse endpoint direto via webhook a
// cada mensagem nova (setWebhook, ver instruções em telegram_setup.md),
// então não precisa de cursor/estado de "última mensagem vista" como o
// chatwoot-troca-praca tinha.
//
// Identificação do entregador: o Telegram não dá telefone automático como
// o WhatsApp (Chatwoot). Na primeira mensagem de um chat_id novo, o bot
// pede o CPF, confere contra a tabela entregadores, e grava a ligação em
// telegram_vinculos -- daí em diante reconhece sozinho.
//
// Escopo (mesma decisão do bot antigo, pedido do usuário 27/08/2026): só
// responde troca de praça. Qualquer outra coisa fica em silêncio.
import { createClient } from 'jsr:@supabase/supabase-js@2';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// PRAÇAS precisa ficar em sincronia com as options do <select> em
// https://api-automaturno.rly9ea.easypanel.host/admin/<token> -- se o
// parceiro adicionar/renomear praça, atualiza aqui também (mesma lista do
// chatwoot-troca-praca).
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

function respostaSucesso(): string {
  return 'Beleza, feito!';
}

const RESPOSTAS_NOOP = ['Você já tá nessa praça!', 'Já tá certinho, você já tá nessa praça.', 'Opa, já tá aí, viu?', 'Já tava nessa praça mesmo -- tá tudo certo.'];
function respostaNoop(): string {
  return RESPOSTAS_NOOP[Math.floor(Math.random() * RESPOSTAS_NOOP.length)];
}

// Mesmo horário de operação do bot antigo (06:00 de um dia até 01:00 do
// dia seguinte) -- ajuste aqui se o horário mudar.
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
  return minutosDoDia >= HORARIO_INICIO || minutosDoDia < HORARIO_FIM;
}

Deno.serve(async (req: Request) => {
  // Telegram sempre espera 200 rápido -- qualquer coisa diferente disso ele
  // reenvia o update depois, então SEMPRE respondemos ok, mesmo em erro
  // interno (o erro já foi logado antes disso).
  try {
    const secretEsperado = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
    const secretRecebido = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secretEsperado && secretRecebido !== secretEsperado) {
      return jsonResponse({ ok: false, error: 'secret inválido' }, 401);
    }

    const update = await req.json();
    const message = update?.message;
    if (!message) return jsonResponse({ ok: true });

    const chatId: number = message.chat?.id;
    if (!chatId) return jsonResponse({ ok: true });

    if (!dentroDoHorarioDeOperacao()) return jsonResponse({ ok: true, fora_do_horario: true });

    const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Interruptor geral -- mesmo padrão do bot antigo (chave própria pra não
    // se confundir com o toggle do Chatwoot, que fica desativado agora).
    const { data: config } = await supabase
      .from('automacao_config')
      .select('ativo')
      .eq('chave', 'telegram_bot')
      .maybeSingle();
    if (config && config.ativo === false) return jsonResponse({ ok: true, desligado_manualmente: true });

    let texto: string = message.text?.trim() || '';
    if (!texto && message.voice) {
      try {
        texto = await transcreverAudioTelegram(token, message.voice.file_id);
      } catch (e) {
        console.error('Falha ao transcrever áudio do Telegram:', e);
      }
    }
    if (!texto) return jsonResponse({ ok: true });

    const vinculo = await buscarVinculo(supabase, chatId);
    if (!vinculo) {
      await tratarVinculo(supabase, token, chatId, texto);
      return jsonResponse({ ok: true });
    }

    const classificacao = await classificarTroca(texto);
    if (!classificacao?.eh_pedido_troca || !classificacao.praca_codigo) {
      return jsonResponse({ ok: true }); // silêncio -- só age em pedido claro
    }

    const resultado = await executarTroca(vinculo.cpf, classificacao.praca_codigo);
    const resposta = formatarResposta(resultado);
    if (resposta) await enviarMensagem(token, chatId, resposta);

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('Erro no telegram-bot:', err);
    return jsonResponse({ ok: true }); // não deixa o Telegram ficar reenviando
  }
});

async function buscarVinculo(supabase: any, chatId: number) {
  const { data } = await supabase
    .from('telegram_vinculos')
    .select('cpf, nome')
    .eq('chat_id', chatId)
    .maybeSingle();
  return data;
}

// Primeira mensagem de um chat_id novo (ou ainda sem vínculo): tenta ler um
// CPF na mensagem. Bate contra entregadores -- se achar, grava o vínculo de
// vez. Se não, pede o CPF (não revela se o CPF existe ou não em detalhe,
// só confirma ou pede de novo).
async function tratarVinculo(supabase: any, token: string, chatId: number, texto: string) {
  const cpfDigits = texto.replace(/\D/g, '');
  if (cpfDigits.length !== 11) {
    await enviarMensagem(token, chatId, 'Oi! Pra eu te reconhecer, manda seu CPF (só números, sem pontos).');
    return;
  }

  const { data: entregador } = await supabase
    .from('entregadores')
    .select('cpf, nome')
    .eq('cpf', cpfDigits)
    .maybeSingle();

  if (!entregador) {
    await enviarMensagem(token, chatId, 'Não achei esse CPF no nosso cadastro. Confere os números e manda de novo, por favor.');
    return;
  }

  await supabase.from('telegram_vinculos').upsert({
    chat_id: chatId,
    cpf: entregador.cpf,
    nome: entregador.nome,
    vinculado_em: new Date().toISOString(),
  });

  const primeiroNome = (entregador.nome || '').trim().split(/\s+/)[0] || '';
  await enviarMensagem(token, chatId, `Beleza, ${primeiroNome}! Já te reconheço agora. Pode pedir a troca de praça quando quiser.`);
}

async function classificarTroca(texto: string): Promise<{ eh_pedido_troca: boolean; praca_codigo: string | null } | null> {
  const listaPracas = Object.entries(PRACAS).map(([cod, nome]) => `${cod} = "${nome}"`).join('\n');
  const prompt = [
    'Classifique a mensagem de um entregador abaixo. Ele está pedindo pra TROCAR/SER ALOCADO numa',
    'praça (região/área de trabalho) agora? Trate como pedido de troca QUALQUER mensagem pedindo pra',
    'ser colocado/alocado/disponibilizado pra trabalhar numa região, mesmo sem citar a palavra "praça".',
    'Exemplos:',
    '  "quero trocar de praça" -> eh_pedido_troca: true, praca_codigo: null (não disse qual)',
    '  "pode me alocar em pinheiros?" -> eh_pedido_troca: true, praca_codigo: "PINHEIROS"',
    '  "Livre" (mensagem que é só o nome de uma praça válida, sozinho) -> eh_pedido_troca: true, praca_codigo: "LIVRE"',
    '  "bom dia" -> eh_pedido_troca: false, praca_codigo: null',
    '',
    'Praças válidas:',
    listaPracas,
    '',
    'Responda APENAS um JSON válido, sem markdown:',
    '{"eh_pedido_troca": true|false, "praca_codigo": "CODIGO_EXATO_DA_LISTA" ou null}',
    '',
    `Mensagem do entregador: "${texto}"`,
  ].join('\n');

  return await chamarGemini(prompt);
}

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
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }),
    },
  );

  const json = await response.json();
  if (!response.ok) throw new Error(`Gemini API (${response.status}): ${json.error?.message || JSON.stringify(json)}`);

  const candidato = json.candidates?.[0];
  const texto = candidato?.content?.parts?.[0]?.text?.trim() || '{}';
  try {
    return JSON.parse(texto);
  } catch (e) {
    console.error('Falha ao parsear resposta do Gemini:', texto, e);
    return null;
  }
}

// Mesmo endpoint e mesma lógica de retry do bot antigo (chatwoot-troca-praca).
async function executarTroca(cpf: string, pracaCodigo: string) {
  const url = 'https://api-automaturno.rly9ea.easypanel.host/admin/f1c488c58cbd6cea2ac17df3f5d5b5be/trocar';
  const ESPERAS_MS = [2000, 4000, 8000];
  let ultimoResultado: any = null;
  for (let tentativa = 1; tentativa <= ESPERAS_MS.length + 1; tentativa++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf, subpraca_id: pracaCodigo }),
      });
      const dados = await response.json();
      ultimoResultado = dados;
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

function formatarResposta(resultado: any): string | null {
  const corpo = resultado?.corpo_parceiro;
  const statusOk = resultado?.status_parceiro >= 200 && resultado?.status_parceiro < 300 && corpo?.success !== false;
  if (statusOk && corpo?.action === 'noop') return respostaNoop();
  if (statusOk) return respostaSucesso();
  return null; // falha -- silêncio pro entregador, mesma regra do bot antigo
}

async function enviarMensagem(token: string, chatId: number, texto: string) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto }),
  });
  if (!resp.ok) throw new Error(`Telegram (sendMessage) respondeu ${resp.status}: ${await resp.text()}`);
}

async function transcreverAudioTelegram(token: string, fileId: string): Promise<string> {
  const fileResp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileJson = await fileResp.json();
  if (!fileJson.ok) throw new Error(`Telegram (getFile) falhou: ${JSON.stringify(fileJson)}`);
  const filePath = fileJson.result.file_path;

  const audioResp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!audioResp.ok) throw new Error(`Download do áudio falhou: ${audioResp.status}`);
  const audioBlob = await audioResp.blob();

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada.');

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
