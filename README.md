# Desempenho Histórico D-1 — EntreGÔ

Painel com o desempenho histórico dos entregadores (D-1), com filtro por
turno e período.

A página (`index.html`) é 100% estática — os dados vêm direto do
**Supabase** (Postgres) via a API REST pública (PostgREST) e duas Edge
Functions. **O painel é aberto (sem senha)**: qualquer pessoa com o link do
GitHub Pages vê os dados, incluindo nome, CPF e telefone dos entregadores.
Nenhum dado fica gravado no repositório.

## Arquitetura

- **Supabase (Postgres)** é a fonte de dados: tabelas `d1_rows`,
  `entregadores`, `sem_corridas` (`supabase/schema.sql`). RLS liga leitura
  pública (`SELECT`) pra todo mundo — só a `service_role` key (usada pelos
  robôs e nunca enviada ao navegador) consegue escrever.
- **Dois robôs diários** populam essas tabelas sozinhos, sem precisar pedir
  manualmente (detalhes na seção seguinte).
- **Duas Edge Functions** (`supabase/functions/`) cobrem as duas ações que
  precisam de segredo ou validação no servidor: `analyze` (resumo com IA) e
  `send-chatwoot` (envio de WhatsApp Business, validando o CPF contra
  `sem_corridas` antes de mandar qualquer coisa).
- **`index.html`** lê `d1_rows`/`entregadores`/`sem_corridas` direto via
  REST (com paginação — o Postgres devolve no máximo 1000 linhas por
  chamada, então o painel pagina via cabeçalho `Range` até pegar tudo) e
  chama as duas Edge Functions quando precisa.

## Robôs diários (coleta automática)

- **`robots/sem_corridas.py`** (Praça de São Paulo,
  sistema.entregoaguasclaras.com.br) roda via **GitHub Actions**
  (`.github/workflows/sync-sem-corridas.yml`, cron diário +
  `workflow_dispatch` manual). Sobrescreve a tabela `sem_corridas` por
  completo a cada rodada — não fica uma visão congelada, sempre reflete a
  última coleta.
- **`robots/entregadores_sync.py`** (Praça de São Paulo,
  sistema.entregoaguasclaras.com.br → tela `/registrations`) roda via
  **GitHub Actions** (`.github/workflows/sync-entregadores.yml`, cron diário
  + `workflow_dispatch`). Baixa o CSV de exportação da seção "Aprovado"
  (o export ignora os filtros da tela e sempre traz todo mundo, então o
  filtro de praça é feito em Python depois de baixar), e faz **upsert por
  CPF** na tabela `entregadores` — diferente do Sem Corridas, aqui é
  merge/upsert, não substituição total, porque `entregadores` é o roster
  completo (histórico), não um snapshot do dia. É o que alimenta a
  `data_aprovacao` usada pelas campanhas da aba Campanhas.
- **`robots/d1_sync.py`** (relatório Performance,
  franqueado.entregolog.com) **não pode** rodar no GitHub Actions: esse
  site fica atrás de um WAF (Akamai) que bloqueia IPs de datacenter/nuvem
  com "Access Denied", incluindo os runners do GitHub. Por isso ele roda
  como uma **Tarefa Agendada do Windows** (`EntreGO-Sync-D1`) direto numa
  máquina real, via `run_d1_sync.bat` (faz `git pull` + roda o script +
  loga em `logs/d1_sync.log`). Precisa dessa máquina ligada e conectada no
  horário agendado (07:00).
- Esse mesmo site exige um código de verificação por e-mail a cada login
  (2FA) — `robots/email_otp.py` lê esse código direto da caixa IMAP
  (Titan), sem precisar de intervenção manual.
- Credenciais dos dois robôs: veja `.env.example` na raiz do repo. Local,
  use um `.env` (nunca commitado); no GitHub Actions, cadastre os mesmos
  nomes em **Settings → Secrets and variables → Actions** do repositório.

## Publicar/atualizar o Supabase

1. **Schema**: `supabase/schema.sql` no SQL Editor do Supabase (uma vez —
   já rodado neste projeto).
2. **Edge Functions** (`supabase/functions/analyze` e
   `supabase/functions/send-chatwoot`): Dashboard → Edge Functions →
   criar/editar cada uma com o nome exato, colar o conteúdo do
   `index.ts` correspondente, Deploy.
   - Em cada função, **Settings → desligue "Verify JWT with legacy
     secret"** (as duas já fazem a própria validação — o `send-chatwoot`
     confere o CPF contra `sem_corridas`, e nenhuma das duas usa
     autenticação de usuário do Supabase).
   - Secrets da função (mesma aba Settings, ou Edge Functions → Secrets no
     nível do projeto): `CHATWOOT_TOKEN` (função `send-chatwoot`) e
     `CLAUDE_API_KEY` (função `analyze`). `SUPABASE_URL` e
     `SUPABASE_SERVICE_ROLE_KEY` **não precisam** ser cadastrados — o
     Supabase já injeta os dois automaticamente em toda função.
3. **Chave pública no front-end**: `index.html` usa a chave `publishable`
   (Project Settings → API → "Publishable key", ou "anon key" em projetos
   mais antigos) nas constantes `SUPABASE_URL`/`SUPABASE_ANON_KEY` perto do
   topo do `<script>`. Ela é pública por design (protegida pelas regras de
   RLS, não por sigilo) — se o projeto girar essa chave, atualize aqui.

## Publicar a página no GitHub Pages

Este repositório já está pronto: **Settings → Pages → Branch: `main` /
root**. Depois de alguns minutos a página fica em
`https://johnigomes.github.io/jarvis/`.

## Aba "Campanhas" (quem são os ganhadores dos bônus promocionais)

A aba **Campanhas** do painel principal mostra quem bate os critérios das
duas campanhas de agosto/2026 (Start EntreGô e R$100 por semana). As datas e
regras estão fixas no `index.html` (constantes `CAMP_*`, logo antes de
`renderTable`) — se surgir uma campanha nova ou os critérios mudarem, é lá
que se ajusta.

- **Start EntreGô (R$200)**: cadastro aprovado entre 03/08 e 31/08, com 50
  entregas (coluna `Pedidos`) completadas em até 7 dias corridos após a
  **data de aprovação** (coluna `data_aprovacao` da tabela `entregadores`).
  Quem tem turno no D-1 a partir de 03/08 mas **não tem** essa data
  preenchida aparece num aviso separado, pra você saber quem falta
  cadastrar.
- **R$100 por semana**: semanas corridas de 7 dias a partir de 03/08
  (03–09/08, 10–16/08, 17–23/08, 24–30/08, 31/08 avulso). R$50 pros 30
  primeiros a completarem 40 entregas na semana com taxa de aceite ≥70%
  (ordem de quem bateu 40 primeiro, por data+turno) — dentro desses 30,
  +R$50 extra pra quem também ficou com Tempo Online ≥75% na semana (R$100
  no total). Um seletor deixa trocar de semana pra ver o ranking de cada
  uma.

Em ambas, "entregas" = `numero_de_pedidos_aceitos_e_concluidos` (coluna
`Pedidos`), não `Rotas` (corridas completadas).

## Aba "Sem Corridas" (envio via Chatwoot pra aprovados que não rodaram)

A aba **Sem Corridas** do painel principal lista entregadores aprovados que
ainda não fizeram nenhuma corrida (Praça de São Paulo, coletado
automaticamente todo dia — ver "Robôs diários" acima), com um botão que
manda uma mensagem de WhatsApp Business **de verdade** (via Chatwoot) na
hora do clique.

Conta, inbox e template do WhatsApp Business estão fixos no topo da Edge
Function `send-chatwoot` (`CHATWOOT_ACCOUNT_ID`, `CHATWOOT_INBOX_ID`,
`CHATWOOT_TEMPLATE_NAME` = `aprovado_com_promo`) — ajuste lá se a conta, a
inbox ou o template mudarem. Como é WhatsApp Business API, o primeiro
contato com quem nunca conversou antes **precisa** ser por um template já
aprovado pela Meta (não dá pra mandar texto livre).

### Segurança: por que o envio valida pelo CPF

O painel é público (sem senha) — sem alguma proteção, qualquer pessoa
poderia chamar a Edge Function na mão e mandar mensagem de WhatsApp
Business pra qualquer número, usando a conta da empresa. Por isso o botão
manda só o **CPF** (nunca telefone/nome) pro servidor; a função busca
telefone e nome direto na tabela `sem_corridas` (com a `service_role` key,
que ignora RLS) e só envia se achar o CPF lá.

## Como os números são calculados

- **Turnos**: quantidade de linhas (períodos) do entregador no D-1, no filtro
  de turno selecionado.
- **% Aceite**: corridas aceitas ÷ corridas ofertadas.
- **% Online**: tempo disponível absoluto ÷ duração escalada dos turnos.
- **Rotas**: corridas completadas.
