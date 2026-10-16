# PRD — Instalar e rodar o "Gestor ML — Sistema Operação Lucrativa" (Henrique Niada)

> **Aluno:** copie este arquivo inteiro e cole no Claude Code, numa pasta vazia.
>
> **Claude Code:** este documento é a sua tarefa. Execute do início ao fim, sem pedir
> confirmação a cada passo. Converse com o aluno em **português do Brasil**, em linguagem
> simples: ele pode nunca ter usado terminal.

---

## Objetivo

Deixar o projeto rodando no computador do aluno, com o painel aberto no navegador, e
acompanhar o aluno até a conta do Mercado Livre estar conectada.

Repositório: `https://github.com/HN-devs-mentoria/Operacao-lucrativa-Sistema-ML-Henrique-Niada` (branch `main`)

## Regras (valem para a sessão inteira)

1. **Nunca peça ao aluno para colar App ID ou chave secreta aqui no chat.** Eles são
   digitados **no painel** (`http://localhost:3100`). Se o aluno colar mesmo assim, avise
   que a chave deve ser trocada no DevCenter e não repita o valor em nenhuma resposta.
2. **Não use Docker**, nem proponha usar.
3. **Não edite `.env`, `dados.sqlite` ou arquivos do projeto** para "resolver" instalação.
   O `npm run setup` e o `npm start` cuidam de tudo; se algo falhar, leia a mensagem deles.
4. **Nunca faça commit** de `.env`, `dados.sqlite*`, `logs/` ou `scraper/.sessao_ml/`.
5. O `npm start` é um processo que **fica rodando**: rode em segundo plano e não o encerre
   ao terminar a tarefa.

## Passo 1 — Descobrir o sistema

Identifique se é macOS, Windows ou Linux. Os comandos abaixo mudam conforme o sistema.

## Passo 2 — Pré-requisitos

| Ferramenta | Conferir | Instalar se faltar |
|---|---|---|
| Git | `git --version` | macOS: `xcode-select --install` · Windows: `winget install --id Git.Git -e` · Linux: `sudo apt install git` |
| Node.js **22.13 ou maior** | `node -v` | macOS: `brew install node` (sem Homebrew: instalador LTS de https://nodejs.org) · Windows: `winget install OpenJS.NodeJS.LTS` · Linux: https://nodejs.org |

- No Windows, depois de instalar pelo `winget`, o terminal atual não enxerga o programa
  novo: abra um terminal novo (ou atualize o `PATH` da sessão) antes de seguir.
- **Não instale Python, uv nem Chromium à mão**: o `npm run setup` faz isso.

**Pronto quando:** `node -v` mostra `v22.13` ou maior e `git --version` responde.

## Passo 3 — Baixar o projeto

```bash
git clone https://github.com/HN-devs-mentoria/Operacao-lucrativa-Sistema-ML-Henrique-Niada.git
cd Operacao-lucrativa-Sistema-ML-Henrique-Niada
```

Se a pasta já existir de uma instalação anterior, não clone de novo: entre nela e rode

```bash
git fetch origin
git switch -C main origin/main
```

O histórico do repositório foi refeito, então `git pull` numa instalação antiga falha.
Esses dois comandos põem a pasta na versão atual sem tocar em `.env`, `dados.sqlite` nem
na sessão do scraper (as contas continuam conectadas). Se o `git switch` recusar por
arquivo do projeto alterado à mão, mostre ao aluno quais são e pergunte antes de descartar.

## Passo 4 — Instalar

```bash
npm run setup
```

O `setup` instala o `uv`, o Python 3.12, as dependências do scraper e o Chromium, cria o
`.env` com uma chave de cifra e roda os testes. Se o aluno já usa o **plugin hn-anuncio-ml**,
ele avisa `app do plugin hn-anuncio-ml encontrado`: a tela de Configuração já vem com o
mesmo aplicativo do Mercado Livre preenchido e o aluno pula a criação do app. No fim ele imprime um **Resumo** com
`[ok]` ou `[x]` em cada item.

- Se algum item vier `[x]`, leia a dica impressa logo abaixo dele, resolva e rode
  `npm run setup` de novo (ele pode rodar quantas vezes precisar).
- Linux: se o Chromium falhar, rode o comando `install-deps` que a própria dica mostra.

**Pronto quando:** a última linha é `Tudo pronto. Agora rode:  npm start`.

## Passo 5 — Subir tudo

Rode **em segundo plano**, guardando a saída:

```bash
npm start
```

Ele sobe duas coisas juntas: o painel e o scraper Python. Em até ~1 minuto aparecem no
terminal:

- `painel no ar: http://localhost:3100` (a porta pode ser outra se a 3100 estiver ocupada:
  use a que aparecer);
- `scraper pronto: http://127.0.0.1:8100`;
- o próximo passo da configuração, se faltar algum (cadastrar o app, a URI de redirect ou
  conectar a conta).

O navegador abre sozinho no painel. Se não abrir, passe o link ao aluno. O painel só existe
neste computador: não há senha nem endereço público.

**Pronto quando:** `curl -s http://127.0.0.1:3100/api/ping` devolve `{"ok":true,"app":"aula-ml"}`
(troque a porta se for outra).

Se aparecer `O painel já está rodando`, ele já estava de pé: só abra o link.

## Passo 6 — Acompanhar o aluno no painel

Até uma conta estar conectada, o painel só mostra a tela **Configurações**: as outras
(Início, Publicar, Meus anúncios, Navegador) ficam travadas e voltam para ela. Guie, uma
etapa por vez:

1. **Aplicativo no Mercado Livre.** Se o setup encontrou o app do plugin hn-anuncio-ml, o
   passo 2 já vem com App ID e chave preenchidos: o aluno só clica em **Salvar e validar**
   e vai para o item 3. Se não, ele cria o app no DevCenter
   (https://developers.mercadolivre.com.br/devcenter) assim:
   - URIs de redirect → a **URI de redirect** do passo 1, com botão de copiar
     (`https://httpbin.org/get`, a mesma do plugin; ela nunca muda);
   - URL de notificações → pode ficar em branco;
   - Fluxos OAuth → **Authorization Code**, **Client Credentials** e **Refresh Token**;
   - Permissões → leitura e escrita em *Publicação e sincronização*;
   - salvar.
2. **Colar App ID e chave secreta no painel** (passo 2 da tela — não no chat) e clicar em
   **Salvar e validar**. O painel confere com o Mercado Livre e diz se está certo.
3. **Conectar a conta** — botão no passo 3. Abre o Mercado Livre numa aba nova; o aluno
   autoriza e cai numa página com um texto técnico. Ele **copia o endereço inteiro da barra
   do navegador** (começa com `https://httpbin.org/get?code=`) e cola no campo que apareceu
   no painel. Se a conta já estava no plugin, a tela sugere qual conectar. Conectada a
   conta, as outras telas liberam.
4. **Login do scraper** — aba **Navegador** → **Fazer login**. O aluno digita a senha do
   Mercado Livre na própria tela.

**Pronto quando:** a tela Configurações mostra o passo 3 concluído (conta listada) e o
scraper como **rodando**.

**Perguntar em vez de procurar:** ainda na tela Configurações, o bloco **Claude Code** mostra a
pasta do projeto e uma linha pronta para colar no Terminal. Com ela o aluno abre o Claude Code
já ligado aos anúncios dele e pergunta em português ("quais meus melhores produtos dos últimos
30 dias?"). Aponte o bloco ao aluno; o passo a passo está lá.

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| Passo 1 diz que o app **não tem a URI de redirect** | Aluno acrescenta a URI do passo 1 em "URIs de redirect" no DevCenter (exatamente igual, sem barra no final), salva e recarrega a tela Configurações (ela confere de novo ao abrir). |
| "Não salvei: App ID ou chave secreta incorretos" | A chave foi trocada no DevCenter (ou a do plugin está velha). Aluno copia App ID e chave atuais do DevCenter para o passo 2. |
| "Esse login expirou" ao colar o endereço | O code vale poucos minutos e uma vez só: clicar em **Conectar conta** de novo e colar o endereço novo. |
| Tela do ML: "não foi possível conectar o aplicativo" | Conferir se o app foi **salvo** no DevCenter; conta de colaborador não autoriza; pendência de cadastro no ML bloqueia. |
| Scraper "reiniciando" sem parar | Ler `logs/scraper.log`; normalmente é o Chromium: `npm run setup`. |
| "Node … é antigo demais" | Atualizar o Node (Passo 2) e repetir `npm run setup`. |
| Erro que o professor diz já ter corrigido (ex.: "Parece que esta página no existe" ao fazer login no scraper) | `git pull`, depois `npm run setup` e reinicie: `Ctrl+C` no `npm start` e `npm start` de novo. |

Para reiniciar depois de mudar código: `Ctrl+C` no `npm start` (ou `npm run parar`) e rode
`npm start` de novo. Para voltar outro dia: entrar na pasta e rodar `npm start` de novo.

Mais detalhes: `README.md` do repositório.
