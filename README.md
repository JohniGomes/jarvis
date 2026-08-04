# Desempenho Histórico D-1 — EntreGÔ

Painel com o desempenho histórico dos entregadores (aba **D-1** da planilha),
com filtro por turno e período.

A página (`index.html`) é 100% estática — os dados vêm de um Google Apps
Script publicado como Web App. **O painel é aberto (sem senha)**: qualquer
pessoa com o link do GitHub Pages vê os dados, incluindo nome, CPF e telefone
dos entregadores. Nenhum dado fica gravado no repositório.

## 1. Publicar o Apps Script

1. Abra a planilha (aba `D-1`) → **Extensões → Apps Script**.
2. Apague o conteúdo padrão e cole o código de [`apps-script/Code.gs`](apps-script/Code.gs).
3. **Implantar → Nova implantação**:
   - Tipo: **App da Web**
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
   - Implantar e copie a URL que termina em `/exec`.

### Opcional: resumo com IA (aba Análise)

O bot&atilde;o "Gerar resumo" da aba Análise chama a Claude API a partir do
próprio Apps Script (a chave nunca passa pelo navegador nem pelo GitHub):

1. No editor do Apps Script, clique no ícone de engrenagem (**Configurações
   do projeto**) → **Propriedades do script** → **Adicionar propriedade do
   script**.
2. Nome: `CLAUDE_API_KEY`. Valor: sua chave da Anthropic (gerada em
   [console.anthropic.com](https://console.anthropic.com)).
3. Salve e implante novamente (**Implantar → Gerenciar implantações → editar
   → Nova versão**) para o `doPost` novo entrar em vigor.

Sem essa propriedade configurada, o botão "Gerar resumo" mostra um erro
explicando o que falta — o resto do painel funciona normalmente sem ela.

### CPF, telefone e bot&atilde;o de WhatsApp

Nome, CPF e telefone vêm de duas abas combinadas por nome
(`getPosVendasRows` no `Code.gs`):

- **`Entregadores`**: lista completa dos aprovados, colunas `Nome` / `CPF` /
  `Telefone` / `Data de Aprovação` (cabeçalho lido pelo nome, não por
  posição — a coluna precisa se chamar **exatamente** `Data de Aprovação`,
  com acento e "ç", senão a aba Campanhas não encontra ela). Fonte
  principal. Fica na **mesma planilha oficial do D-1**. A coluna `Data de
  Aprovação` é opcional (o resto do painel funciona sem ela) e só é usada
  pela campanha "Start EntreGô" na aba Campanhas — preencha como data de
  verdade (não texto) pra ficar seguro.
- **`Pós-vendas (Messias)`**: contato manual de pós-venda (colunas fixas
  `B`=nome, `E`=telefone, `F`=CPF), numa **planilha externa separada** — usada
  só pra completar quem não está na lista de aprovados ou ficou com
  CPF/telefone em branco lá. O ID dessa planilha externa está fixo em
  `POS_VENDAS_SPREADSHEET_ID` no topo do `Code.gs` — troque lá se ela mudar.
  A conta que executa o Apps Script (**Executar como: Eu**) precisa ter
  acesso de leitura a ela.

O CPF aparece abaixo do nome em todas as abas. O botão de WhatsApp (ícone,
sem texto) aparece nas listas da aba Análise ("Não compareceram", "Ficaram
menos da metade do turno", "Recusaram quase tudo") e da aba Meta ("Maiores
oportunidades", "Mais cancelamentos"), com mensagem já preenchida (usando só
o primeiro nome da pessoa) — só quando o telefone for encontrado pelo nome.

## 2. Publicar a página no GitHub Pages

Este repositório já está pronto: **Settings → Pages → Branch: `main` /
root**. Depois de alguns minutos a página fica em
`https://johnigomes.github.io/jarvis/`.

Em [`index.html`](index.html), na constante `DEFAULT_APPS_SCRIPT_URL` (perto
do topo do `<script>`), cole a URL `.../exec` do passo 1.

## 3. Usar o painel

Abra a URL do GitHub Pages — os dados carregam direto, sem login.

## Aba "Campanhas" (quem são os ganhadores dos bônus promocionais)

A aba **Campanhas** do painel principal mostra quem bate os critérios das
duas campanhas de agosto/2026 (Start EntreGô e R$100 por semana). As datas e
regras estão fixas no `index.html` (constantes `CAMP_*`, logo antes de
`renderTable`) — se surgir uma campanha nova ou os critérios mudarem, é lá
que se ajusta.

- **Start EntreGô (R$200)**: cadastro aprovado entre 03/08 e 31/08, com 50
  entregas (coluna `Pedidos`) completadas em até 7 dias corridos após a
  **Data de Aprovação** (aba Entregadores — ver seção acima). Quem tem turno
  no D-1 a partir de 03/08 mas **não tem** essa data preenchida aparece num
  aviso separado, pra você saber quem falta cadastrar.
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
ainda não fizeram nenhuma corrida, com um botão que manda uma mensagem de
WhatsApp Business **de verdade** (via Chatwoot) na hora do clique.

### De onde vem a lista

O sistema `sistema.entregoaguasclaras.com.br/approved-follow-up` (tela
"Acompanhamento Aprovados") não tem API — a lista é coletada manualmente
(hoje: pedindo pro Claude acessar o sistema, com você logado no painel do
navegador, e colar o resultado). Cole os dados numa aba chamada **exatamente**
`Sem Corridas` na planilha oficial do D-1, com as colunas `Nome`, `Telefone`
(dígitos com 55 na frente, ex: `5511999998888`), `CPF` (11 dígitos) e
`Aprovado_em`. Peça pra recoletar sempre que quiser atualizar — não é
automático.

### Configurar o Chatwoot

1. No editor do Apps Script, **Configurações do projeto → Propriedades do
   script → Adicionar propriedade do script**: nome `CHATWOOT_TOKEN`, valor o
   token de acesso do Chatwoot (Perfil → Token de acesso). Nunca cole esse
   token em nenhum arquivo do repositório.
2. Conta, inbox e template do WhatsApp Business estão fixos no topo da seção
   Chatwoot do `Code.gs` (`CHATWOOT_ACCOUNT_ID`, `CHATWOOT_INBOX_ID`,
   `CHATWOOT_TEMPLATE_NAME` = `aprovado_com_promo`) — ajuste lá se a conta,
   a inbox ou o template mudarem. Como é WhatsApp Business API, o primeiro
   contato com quem nunca conversou antes **precisa** ser por um template
   já aprovado pela Meta (não dá pra mandar texto livre).

### Segurança: por que o envio valida pelo CPF

O painel é público (sem senha) — sem alguma proteção, qualquer pessoa
poderia montar a URL do Apps Script na mão e mandar mensagem de WhatsApp
Business pra qualquer número, usando a conta da empresa. Por isso o botão
manda só o **CPF** pro servidor (`action=sendChatwoot&cpf=...`); o Apps
Script busca telefone e nome direto na aba "Sem Corridas" e só envia se
achar o CPF lá — nunca aceita telefone/nome vindo do navegador.

## Página "Meu Desempenho" (pra compartilhar com os entregadores)

[`meu-desempenho.html`](meu-desempenho.html) é uma página separada, pensada
pra mandar pros próprios entregadores (WhatsApp, grupo, etc.):
`https://johnigomes.github.io/jarvis/meu-desempenho.html`.

O entregador digita o CPF dele e vê **só os números dele** (turnos, pedidos,
% aceite, tempo online, por turno) — sem acesso ao painel principal, às
outras abas ou aos KPIs gerais da região.

Isso é filtrado **no Apps Script, não no navegador**: a ação
`action=meuDesempenho&cpf=...` (em `Code.gs`, função `getMeuDesempenho`)
acha a pessoa pelo CPF nas abas de contato e devolve só as linhas do D-1
dela. O navegador do entregador nunca chega a baixar os dados de mais
ninguém — diferente do painel principal (`index.html`), que carrega a base
inteira pra quem já tem acesso a tudo. Usar o CPF como identificador é
consistente com a decisão já tomada de deixar o painel principal aberto e
mostrar o CPF publicamente ali: não há um segredo novo sendo exposto.

Se o entregador confirmar o CPF, ele fica salvo no navegador dele (só no
próprio aparelho, via `localStorage`) pra não precisar digitar de novo da
próxima vez — dá pra trocar clicando em "trocar CPF".

## Como os números são calculados

- **Turnos**: quantidade de linhas (períodos) do entregador no D-1, no filtro
  de turno selecionado.
- **% Aceite**: corridas aceitas ÷ corridas ofertadas.
- **% Online**: tempo disponível absoluto ÷ duração escalada dos turnos.
- **Rotas**: corridas completadas.
