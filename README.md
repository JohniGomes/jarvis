# Desempenho Histórico D-1 — EntreGÔ

Painel com o desempenho histórico dos entregadores (aba **D-1** da planilha),
com filtro por turno e período.

A página (`index.html`) é 100% estática — os dados vêm de um Google Apps
Script publicado como Web App, protegido por chave de acesso. Nenhum dado
fica gravado no repositório.

## 1. Publicar o Apps Script

1. Abra a planilha (aba `D-1`) → **Extensões → Apps Script**.
2. Apague o conteúdo padrão e cole o código de [`apps-script/Code.gs`](apps-script/Code.gs).
3. No topo do arquivo, troque `var ACCESS_KEY = 'TROQUE_AQUI';` por uma chave
   forte de verdade — é a "senha" do painel, só quem tiver essa chave
   consegue ver os dados.
   ⚠️ **Faça essa troca só aqui, direto no editor do Apps Script**
   (script.google.com). Nunca copie essa versão com a chave real de volta
   pro GitHub — a cópia do repositório deve continuar com `TROQUE_AQUI`.
4. **Implantar → Nova implantação**:
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

### Opcional: bot&atilde;o de WhatsApp (aba Análise)

As listas de "Não compareceram", "Ficaram menos da metade do turno" e
"Recusaram quase tudo" mostram um botão de WhatsApp com mensagem
já preenchida, se houver telefone cadastrado. Pra ativar:

1. Crie uma aba chamada **`Contatos`** na mesma planilha, com duas colunas:
   `pessoa_entregadora` e `telefone` (mesmo nome usado no D-1; telefone com
   ou sem DDD/país, o painel completa sozinho).
2. Não precisa reimplantar nada — a aba já é lida automaticamente. Se ela
   ainda não existir, os botões simplesmente não aparecem.

## 2. Publicar a página no GitHub Pages

Este repositório já está pronto: **Settings → Pages → Branch: `main` /
root**. Depois de alguns minutos a página fica em
`https://johnigomes.github.io/jarvis/`.

Em [`index.html`](index.html), na constante `DEFAULT_APPS_SCRIPT_URL` (perto
do topo do `<script>`), cole a URL `.../exec` do passo 1 — é obrigatório,
já que a tela de login só pede a senha (a URL não é secreta, só fica fixa no
código pra simplificar).

## 3. Usar o painel

1. Abra a URL do GitHub Pages.
2. Na tela de login, digite a **senha** que você definiu no passo 1.
3. A senha fica só na sessão da aba — feche o navegador e ela some.

## Como os números são calculados

- **Turnos**: quantidade de linhas (períodos) do entregador no D-1, no filtro
  de turno selecionado.
- **% Aceite**: corridas aceitas ÷ corridas ofertadas.
- **% Online**: tempo disponível absoluto ÷ duração escalada dos turnos.
- **Rotas**: corridas completadas.
