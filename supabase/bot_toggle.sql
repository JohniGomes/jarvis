-- Funções pra ligar/desligar o bot de troca de praça direto pelo painel
-- (sem precisar mexer em SQL Editor toda vez). Rode isso uma vez no SQL
-- Editor do Supabase Dashboard, DEPOIS de já ter rodado
-- chatwoot_poll_cron.sql pelo menos uma vez (o job 'chatwoot-troca-praca-poll'
-- precisa já ter existido em algum momento).
--
-- Já vem com a anon key publicável (a mesma usada em index.html,
-- SUPABASE_ANON_KEY -- pública por design, é isso que "publishable" quer
-- dizer) embutida no job criado por bot_troca_praca_ligar().
--
-- security definer: essas funções rodam com o dono (postgres), que tem
-- acesso ao schema cron -- sem isso, chamar via RPC com a anon key (que
-- não tem esse acesso) falharia. O grant execute abaixo é o que expõe
-- essas 3 funções (só elas, não o schema cron inteiro) pro painel sem
-- senha, no mesmo modelo "aberto, mas com escopo limitado" que já usamos
-- pras Edge Functions.

create or replace function public.bot_troca_praca_status()
returns boolean
language sql
security definer
set search_path = public, cron
as $$
  select coalesce(bool_or(active), false)
  from cron.job
  where jobname = 'chatwoot-troca-praca-poll';
$$;

create or replace function public.bot_troca_praca_ligar()
returns void
language sql
security definer
set search_path = public, cron
as $$
  select cron.schedule(
    'chatwoot-troca-praca-poll',
    '* * * * *',
    $job$
    select net.http_post(
      url := 'https://dhwbypumhfzstbiatquw.supabase.co/functions/v1/chatwoot-troca-praca',
      headers := jsonb_build_object(
        'Authorization', 'Bearer sb_publishable_0ww1Pl1fMSXZU9D68Kkp_w_bFxpW_0E',
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
    $job$
  );
$$;

create or replace function public.bot_troca_praca_desligar()
returns void
language sql
security definer
set search_path = public, cron
as $$
  select cron.unschedule('chatwoot-troca-praca-poll')
  where exists (select 1 from cron.job where jobname = 'chatwoot-troca-praca-poll');
$$;

grant execute on function public.bot_troca_praca_status() to anon, authenticated;
grant execute on function public.bot_troca_praca_ligar() to anon, authenticated;
grant execute on function public.bot_troca_praca_desligar() to anon, authenticated;

-- Pra conferir manualmente:
-- select bot_troca_praca_status();
