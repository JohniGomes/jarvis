-- Roda a Edge Function chatwoot-troca-praca a cada minuto, via pg_cron +
-- pg_net (mesmo mecanismo do agendamento_webhook.sql). Precisa rodar uma
-- vez no SQL Editor do Supabase Dashboard.
--
-- Troque SEU_SUPABASE_ANON_KEY_AQUI pela SUPABASE_ANON_KEY (a chave anon,
-- não a service_role -- a função usa a service_role internamente via
-- Deno.env, só precisa de um token válido pra passar pela autenticação
-- padrão de Edge Functions).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'chatwoot-troca-praca-poll',
  '* * * * *',  -- a cada 1 minuto
  $$
  select net.http_post(
    url := 'https://dhwbypumhfzstbiatquw.supabase.co/functions/v1/chatwoot-troca-praca',
    headers := jsonb_build_object(
      'Authorization', 'Bearer SEU_SUPABASE_ANON_KEY_AQUI',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Pra conferir que o job foi criado:
-- select * from cron.job where jobname = 'chatwoot-troca-praca-poll';

-- Pra remover, se precisar:
-- select cron.unschedule('chatwoot-troca-praca-poll');
