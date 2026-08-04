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
  constraint d1_rows_natural_key unique (data_do_periodo, periodo, id_da_pessoa_entregadora, sub_praca)
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
