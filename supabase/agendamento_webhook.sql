-- Dispara o workflow "Agendamento (dispatch)" no GitHub Actions sempre que
-- alguém grava um pendente em agendamento_status (via o botão
-- Liberar/Bloquear Agendamento do painel, ou o CPF avulso) -- substitui o
-- polling local a cada 2s por um gatilho real de evento.
--
-- PRECISA rodar uma vez no SQL Editor do Supabase Dashboard (REST API não
-- executa DDL/trigger). Antes de rodar, troque SEU_GITHUB_TOKEN_AQUI por um
-- Personal Access Token do GitHub:
--   1. https://github.com/settings/tokens?type=beta (fine-grained)
--   2. "Generate new token" -> Repository access: só o repo "jarvis"
--   3. Permissions -> Contents: Read and write (necessário pro endpoint de dispatch)
--   4. Gerar e colar aqui embaixo

create extension if not exists pg_net;

create or replace function notificar_agendamento_pendente()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.pendente is not null then
    perform net.http_post(
      url := 'https://api.github.com/repos/JohniGomes/jarvis/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer SEU_GITHUB_TOKEN_AQUI',
        'Accept', 'application/vnd.github+json',
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('event_type', 'agendamento-pendente')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists agendamento_pendente_webhook on agendamento_status;
create trigger agendamento_pendente_webhook
  after insert or update on agendamento_status
  for each row
  when (new.pendente is not null)
  execute function notificar_agendamento_pendente();
