-- Dispara o workflow "Deslogar (dispatch)" no GitHub Actions sempre que a
-- Edge Function chatwoot-troca-praca grava um pedido em deslogar_status
-- (mensagem tipo "me desloga" identificada pela Claude).
--
-- PRECISA rodar uma vez no SQL Editor do Supabase Dashboard. Antes de
-- rodar, troque SEU_GITHUB_TOKEN_AQUI pelo mesmo Personal Access Token já
-- usado em agendamento_webhook.sql (ou gere um novo em
-- https://github.com/settings/tokens?type=beta, Contents: Read and write).

create extension if not exists pg_net;

create or replace function notificar_deslogar_pendente()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.pendente then
    perform net.http_post(
      url := 'https://api.github.com/repos/JohniGomes/jarvis/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer SEU_GITHUB_TOKEN_AQUI',
        'Accept', 'application/vnd.github+json',
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('event_type', 'deslogar-pendente')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists deslogar_pendente_webhook on deslogar_status;
create trigger deslogar_pendente_webhook
  after insert or update on deslogar_status
  for each row
  when (new.pendente)
  execute function notificar_deslogar_pendente();
