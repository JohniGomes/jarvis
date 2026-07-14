# Desempenho D-1 × Status D0 — EntreGÔ

Painel que cruza o desempenho dos entregadores (aba **D-1** da planilha) com o
status ao vivo da frota (aba **D0**), com filtro por turno.

A página (`index.html`) é 100% estática — os dados vêm de um Google Apps
Script publicado como Web App, protegido por chave de acesso. Nenhum dado
fica gravado no repositório.

## 1. Publicar o Apps Script

1. Abra a planilha (abas `D0` e `D-1`) → **Extensões → Apps Script**.
2. Apague o conteúdo padrão e cole o código de [`apps-script/Code.gs`](apps-script/Code.gs).
3. Vá em **Configurações do projeto** (ícone de engrenagem) → **Propriedades do script**
   → **Adicionar propriedade do script**:
   - Propriedade: `ACCESS_KEY`
   - Valor: escolha uma chave forte (é a "senha" do painel — só quem tiver essa
     chave consegue ver os dados).
4. **Implantar → Nova implantação**:
   - Tipo: **App da Web**
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
   - Implantar e copie a URL que termina em `/exec`.

A chave de acesso nunca fica no código nem no GitHub — só existe nas
Propriedades do script (guardadas no Google, fora do repositório).

## 2. Publicar a página no GitHub Pages

Este repositório já está pronto: **Settings → Pages → Branch: `main` /
root**. Depois de alguns minutos a página fica em
`https://johnigomes.github.io/jarvis/`.

## 3. Usar o painel

1. Abra a URL do GitHub Pages.
2. Na tela de login, cole a **URL do Web App** (`.../exec`) e a **chave de
   acesso** que você definiu no passo 1.
3. A URL fica salva no navegador (não é secreta); a chave só fica na sessão
   da aba — feche o navegador e ela some.

## Como os números são calculados

- **Turnos**: quantidade de linhas (períodos) do entregador no D-1, no filtro
  de turno selecionado.
- **% Aceite**: corridas aceitas ÷ corridas ofertadas.
- **% Online**: tempo disponível absoluto ÷ duração escalada dos turnos.
- **Rotas**: corridas completadas.
- **Status hoje (D0)**: Online se qualquer linha do entregador na aba D0 tiver
  Conexão = Online; senão Offline; se o nome não aparecer no snapshot do D0,
  mostra "Sem dado hoje".

CPF é retornado pelo Apps Script e mostrado no painel — como o acesso exige
chave, ele não fica exposto publicamente sem credencial.
