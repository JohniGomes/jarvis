-- Schema inicial da migração pra Supabase (ver plano em
-- docs/migracao-supabase.md). Rode isso uma vez no SQL Editor do Supabase
-- (Dashboard > SQL Editor > New query > cole tudo > Run).
--
-- As três tabelas ficam com RLS ligado e uma policy de leitura pública
-- (SELECT), igual ao modelo de hoje (painel aberto, sem senha). Só a
-- service_role (usada pelos robôs do GitHub Actions e pelas Edge
-- Functions) consegue escrever -- ela ignora RLS por padrão no Supabase,
-- então não precisa de policy de INSERT/UPDATE pra ela.

-- ============================================================================
-- d1_rows: uma linha por turno/entregador/dia (histórico D-1)
-- ============================================================================
create table if not exists d1_rows (
  id bigint generated always as identity primary key,
  data_do_periodo date not null,
  periodo text not null,
  duracao_do_periodo text,                       -- "HH:MM:SS", igual ao formato de hoje
  numero_minimo_de_entregadores_regulares_na_escala numeric,
  id_da_pessoa_entregadora text,
  pessoa_entregadora text not null,
  sub_praca text,
  tempo_disponivel_escalado numeric,              -- % já pronto (0-100), igual ao formato de hoje
  tempo_disponivel_absoluto text,                 -- "HH:MM:SS"
  numero_de_corridas_ofertadas numeric default 0,
  numero_de_corridas_aceitas numeric default 0,
  numero_de_corridas_rejeitadas numeric default 0,
  numero_de_corridas_completadas numeric default 0,
  numero_de_corridas_canceladas_pela_pessoa_entregadora numeric default 0,
  numero_de_pedidos_aceitos_e_concluidos numeric default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT: sem isso, Postgres trata NULL != NULL e o upsert do
  -- d1_sync (ON CONFLICT nessa mesma chave) deixa de bloquear duplicatas
  -- toda vez que sub_praca ou id_da_pessoa_entregadora vem vazio no CSV --
  -- foi o que gerou 306 linhas repetidas em 03-04/08/2026 (corrigido).
  constraint d1_rows_natural_key unique nulls not distinct (data_do_periodo, periodo, id_da_pessoa_entregadora, sub_praca)
);
create index if not exists d1_rows_data_idx on d1_rows (data_do_periodo);
create index if not exists d1_rows_pessoa_idx on d1_rows (id_da_pessoa_entregadora);

alter table d1_rows enable row level security;
drop policy if exists "d1_rows leitura publica" on d1_rows;
create policy "d1_rows leitura publica" on d1_rows for select using (true);

-- ============================================================================
-- entregadores: roster (substitui as abas Entregadores + Pós-vendas)
-- ============================================================================
create table if not exists entregadores (
  cpf text primary key,                           -- 11 dígitos, com zero à esquerda
  nome text not null,
  telefone text,                                   -- dígitos com 55 na frente
  data_aprovacao date,
  ifood_id text,                                   -- UUID interno do franqueado.entregolog.com (campo "ifood_id" do CSV de /registrations) -- é o mesmo ID usado como DRIVER_ID na elegibilidade de agendamento
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table entregadores enable row level security;
drop policy if exists "entregadores leitura publica" on entregadores;
create policy "entregadores leitura publica" on entregadores for select using (true);

-- ============================================================================
-- sem_corridas: aprovados sem nenhuma corrida (sobrescrita diária pelo robô)
-- ============================================================================
create table if not exists sem_corridas (
  cpf text primary key,
  nome text not null,
  telefone text,
  praca text,
  aprovado_em date,
  corridas integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table sem_corridas enable row level security;
drop policy if exists "sem_corridas leitura publica" on sem_corridas;
create policy "sem_corridas leitura publica" on sem_corridas for select using (true);

-- ============================================================================
-- chatwoot_envios: quem já recebeu a mensagem do template via o botão
-- "Enviar" da aba Sem Corridas -- existe pra não deixar mandar a mesma
-- mensagem de novo (a aba Sem Corridas é sobrescrita todo dia pelo robô,
-- então esse controle não pode viver lá, senão reseta junto).
-- ============================================================================
create table if not exists chatwoot_envios (
  cpf text primary key,
  enviado_em timestamptz not null default now()
);

alter table chatwoot_envios enable row level security;
drop policy if exists "chatwoot_envios leitura publica" on chatwoot_envios;
create policy "chatwoot_envios leitura publica" on chatwoot_envios for select using (true);

-- ============================================================================
-- super_mais_envios: mesma ideia do chatwoot_envios, só que pro botão
-- "Enviar" da campanha Super Mais (aba Campanhas). tipo diz se foi mensagem
-- livre (pessoa já tinha janela de conversa aberta) ou template
-- aprovado_com_promo (nunca conversou).
-- ============================================================================
create table if not exists super_mais_envios (
  cpf text primary key,
  tipo text not null check (tipo in ('personalizada', 'template')),
  enviado_em timestamptz not null default now()
);

alter table super_mais_envios enable row level security;
drop policy if exists "super_mais_envios leitura publica" on super_mais_envios;
create policy "super_mais_envios leitura publica" on super_mais_envios for select using (true);

-- ============================================================================
-- agendamento_elegibilidade: espelho 1:1 da planilha de elegibilidade do
-- booking (franqueado.entregolog.com/supply/driver-booking-import). Cada
-- upload SUBSTITUI a lista inteira no site deles, então guardamos aqui o
-- estado completo (todo mundo, não só quem a gente mexeu) pra sempre poder
-- reconstruir o CSV inteiro sem apagar configuração de quem não foi tocado.
-- Só o robô (service_role) lê/escreve aqui -- não é exposta ao painel.
-- ============================================================================
create table if not exists agendamento_elegibilidade (
  id bigint generated always as identity primary key,
  ifood_id text not null,
  reference_id text not null,
  tipo text not null check (tipo in ('REGION', 'SUB_REGION')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint agendamento_elegibilidade_natural_key unique (ifood_id, reference_id, tipo)
);
create index if not exists agendamento_elegibilidade_ifood_id_idx on agendamento_elegibilidade (ifood_id);

alter table agendamento_elegibilidade enable row level security;
-- Sem policy de leitura pública de propósito -- só service_role acessa.

-- ============================================================================
-- agendamento_status: status atual (liberado/bloqueado) por CPF pro painel
-- mostrar, mais a fila de pedidos pendentes que o botão Liberar/Bloquear
-- cria. O vigia local (robots/agendamento_watcher.py) fica escutando essa
-- tabela via Supabase Realtime e processa quem tem "pendente" preenchido.
-- ============================================================================
create table if not exists agendamento_status (
  cpf text primary key,
  ifood_id text,
  nome text,
  status text not null default 'bloqueado' check (status in ('liberado', 'bloqueado')),
  pendente text check (pendente in ('liberar', 'bloquear')),
  erro_msg text,
  updated_at timestamptz not null default now()
);

alter table agendamento_status enable row level security;
drop policy if exists "agendamento_status leitura publica" on agendamento_status;
create policy "agendamento_status leitura publica" on agendamento_status for select using (true);

-- ============================================================================
-- chatwoot_mensagens_processadas: dedupe do poller de troca de praça (não
-- temos webhook -- a função chatwoot-poll-troca-praca roda a cada minuto
-- via pg_cron e usa essa tabela pra nunca reprocessar a mesma mensagem
-- duas vezes). Sem RLS pública -- só service_role mexe aqui.
-- ============================================================================
create table if not exists chatwoot_mensagens_processadas (
  message_id bigint primary key,
  conversation_id bigint not null,
  acao text,
  processado_em timestamptz not null default now()
);

-- ============================================================================
-- chatwoot_conversas_estado: estado da conversa do agente de troca de praça
-- (ex.: "perguntei qual praça, esperando resposta"). Sem isso o agente não
-- consegue ter ida-e-volta -- cada mensagem seria tratada isolada.
-- ============================================================================
create table if not exists chatwoot_conversas_estado (
  conversation_id bigint primary key,
  estado text not null check (estado in ('aguardando_praca', 'aguardando_cpf')),
  praca_codigo text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- chatwoot_conversas_cursor: performance -- evita buscar as mensagens
-- completas de TODAS as conversas abertas a cada ciclo do poller. Só busca
-- de novo se last_activity_at (do resumo da listagem, bem mais barato)
-- mudou desde a última checagem.
-- ============================================================================
create table if not exists chatwoot_conversas_cursor (
  conversation_id bigint primary key,
  last_activity_at bigint not null,
  checado_em timestamptz not null default now()
);

-- ============================================================================
-- deslogar_status: fila de pedidos "me desloga do turno" vindos do
-- chatwoot-troca-praca -- robots/deslogar_processar.py (Playwright, GitHub
-- Actions) processa e responde no Chatwoot quando terminar. Só 1 pedido
-- pendente por vez por CPF (upsert por cpf).
-- ============================================================================
create table if not exists deslogar_status (
  cpf text primary key,
  nome text,
  conversation_id bigint not null,
  pendente boolean not null default true,
  status text,
  erro_msg text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- automacao_config: liga/desliga geral do agente do Chatwoot (pedido do
-- usuário 08/08/2026 -- "botão ON/OFF que eu consiga apertar pelo
-- celular"). chatwoot-troca-praca checa isso logo no início e não faz
-- nada se estiver desligado. Leitura E escrita públicas (mesmo modelo já
-- usado no resto do painel -- sem senha, confiado por quem tem o link),
-- pra dar pra ligar/desligar direto do painel sem precisar de function
-- nova ou SQL Editor.
-- ============================================================================
create table if not exists automacao_config (
  chave text primary key,
  ativo boolean not null default true,
  atualizado_em timestamptz not null default now()
);
insert into automacao_config (chave, ativo)
  values ('chatwoot_bot', true)
  on conflict (chave) do nothing;

alter table automacao_config enable row level security;
drop policy if exists "automacao_config leitura publica" on automacao_config;
create policy "automacao_config leitura publica" on automacao_config for select using (true);
drop policy if exists "automacao_config escrita publica" on automacao_config;
create policy "automacao_config escrita publica" on automacao_config for update using (true);
