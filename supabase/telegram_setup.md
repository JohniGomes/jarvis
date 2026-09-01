# Ativar o bot do Telegram

Depois de criar o bot no @BotFather e colar o `TELEGRAM_BOT_TOKEN` no `.env`:

## 1. Rodar o SQL novo (uma vez, no SQL Editor do Supabase Dashboard)

A tabela `telegram_vinculos` já está em `supabase/schema.sql` (rode o arquivo
inteiro de novo, ele usa `create table if not exists` -- não duplica nada).

## 2. Configurar os secrets da Edge Function

```bash
npx supabase secrets set TELEGRAM_BOT_TOKEN=<token do BotFather> --project-ref dhwbypumhfzstbiatquw
npx supabase secrets set TELEGRAM_WEBHOOK_SECRET=<o valor gerado no .env> --project-ref dhwbypumhfzstbiatquw
```

## 3. Deploy da função

```bash
npx supabase functions deploy telegram-bot --project-ref dhwbypumhfzstbiatquw
```

## 4. Registrar o webhook no Telegram (uma vez só)

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://dhwbypumhfzstbiatquw.supabase.co/functions/v1/telegram-bot",
    "secret_token": "<o mesmo TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Confirma que registrou certo:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## 5. Ligar o bot no painel

A tela `robo.html` (mesmo link de antes) já liga/desliga o novo bot --
o interruptor agora controla a chave `telegram_bot` em `automacao_config`
(criada com `ativo = true` por padrão na primeira mensagem que chegar; se
quiser garantir que já nasce ligado, rode no SQL Editor:

```sql
insert into automacao_config (chave, ativo) values ('telegram_bot', true)
on conflict (chave) do update set ativo = true;
```

## 6. Desligar de vez o bot antigo do Chatwoot (depois de confirmar que o Telegram funciona)

```sql
select bot_troca_praca_desligar();
```

## Testar

Fale com o bot no Telegram, mande seu CPF quando ele pedir, e depois peça
uma troca de praça (ex.: "pode me colocar em pinheiros?").
