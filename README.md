# Aula Mercado Livre - Henrique Niada

Dois programas que trabalham na mesma conta do Mercado Livre por caminhos opostos, e sobem juntos com **um comando só**, no seu computador, sem Docker:

| | **Painel** (raiz do repo) | **Scraper** (`scraper/`) |
|---|---|---|
| Como fala com o ML | API oficial + OAuth | navegador logado (Playwright) |
| Linguagem | Node.js | Python 3.12+ |
| Serve para | publicar, listar e editar **os seus** anúncios | ler dados **de qualquer** anúncio (ex.: posição na busca) |
| Endereço | `http://localhost:3100` | `127.0.0.1:8100` (só o painel usa) |
| Precisa de app no DevCenter | sim | não |

O `npm start` sobe o painel e o scraper. **Nada fica exposto à internet**: o painel só abre neste computador, sem túnel e sem senha. Quem já usa o **plugin hn-anuncio-ml** encontra o mesmo aplicativo do Mercado Livre já preenchido.

---

## Comece aqui

### Opção A — com o Claude Code (a da aula)

1. Faça um **fork** deste repositório na sua conta do GitHub.
2. Abra o Claude Code numa pasta vazia e cole o conteúdo de [`PRD-INSTALACAO.md`](PRD-INSTALACAO.md), trocando `SEU_USUARIO` pelo seu usuário do GitHub.
3. Ele instala o que faltar, sobe tudo e abre o painel no navegador. Siga a tela.

### Opção B — no terminal

```bash
git clone https://github.com/SEU_USUARIO/Aula-Mercado-Livre-Henrique-Niada.git
cd Aula-Mercado-Livre-Henrique-Niada
npm run setup
npm start
```

O navegador abre sozinho em `http://localhost:3100`. **Não existe arquivo para editar**: App ID e chave secreta são cadastrados na própria tela — e, se o plugin hn-anuncio-ml já estiver instalado, eles já vêm preenchidos.

**Sempre com as correções mais novas:** `npm run atualizar` busca a versão mais nova do repositório da aula (fork não recebe atualizações sozinho) e só avança a sua cópia — nunca apaga mudança sua.

Mudou o código? `Ctrl+C` e `npm start` de novo. Para fechar tudo, mesmo sem o terminal: `npm run parar`.

---

# Sumário

1. [Pré-requisitos](#1-pré-requisitos)
2. [Como funciona](#2-como-funciona)
3. [Primeiro acesso](#3-primeiro-acesso)
4. [Login sem túnel e o app do plugin](#4-login-sem-túnel-e-o-app-do-plugin)
5. [Scraper](#5-scraper)
6. [Estrutura do repositório](#6-estrutura-do-repositório)
7. [Referência de endpoints](#7-referência-de-endpoints)
8. [O que a API do ML deixa editar](#8-o-que-a-api-do-ml-deixa-editar)
9. [Análise por anúncio](#9-análise-por-anúncio)
10. [Banco de dados](#10-banco-de-dados)
11. [Testes](#11-testes)
12. [Quando der errado](#12-quando-der-errado)
13. [Segurança](#13-segurança)
14. [MCP: o painel dentro do Claude Code](#14-mcp-o-painel-dentro-do-claude-code)
15. [Créditos e licença](#15-créditos-e-licença)

---

## 1. Pré-requisitos

| Ferramenta | Versão | Quem instala |
|---|---|---|
| Node.js | **≥ 22.13** | você (ou o Claude Code, pelo PRD) — o painel usa `node:sqlite` nativo |
| Git | qualquer | você |
| uv | qualquer | `npm run setup` (instalador oficial da Astral) |
| Python 3.12 | — | `npm run setup` (o uv baixa sozinho) |
| Chromium | — | `npm run setup` (Playwright) |

```bash
node -v    # precisa mostrar v22.13 ou maior
```

Instalar o Node: macOS `brew install node` · Windows `winget install OpenJS.NodeJS.LTS` · ou [nodejs.org](https://nodejs.org).

O `npm run setup` pode ser rodado quantas vezes quiser: cada passo confere antes de fazer, e no fim roda os testes.

---

## 2. Como funciona

```
  seu computador

  navegador ──► localhost:3100   PAINEL (só este computador)
                     │
                     ▼
             127.0.0.1:8100   SCRAPER (Python)
             Chromium com a sua conta logada

  Login da conta: o painel abre o Mercado Livre numa aba; o ML devolve para
  https://httpbin.org/get?code=…  e você cola esse endereço de volta no painel.
```

- **Só neste computador, sem senha.** O painel escuta em `127.0.0.1`, recusa `Host` que não seja local e `POST` vindo de outro site. Não existe endereço público para alguém achar — por isso não há senha (ver [Segurança](#13-segurança)).
- **O scraper sobe junto e volta sozinho.** Se o processo Python cair ou travar, o `npm start` reinicia com espera crescente (2 s, 5 s, 15 s…). O estado aparece em **Configurações**.
- **Portas ocupadas não travam.** Se a 3100 já estiver em uso por outro programa, o painel usa a próxima livre e avisa. Se o próprio painel já estiver rodando, um segundo `npm start` só abre o navegador nele.
- **Nada fica para trás.** `npm run parar` encerra painel e scraper. Se o terminal morrer sem encerrar, o próximo `npm start` acha os processos órfãos (conferindo a linha de comando antes) e os encerra.

---

## 3. Primeiro acesso

O painel guia pelos três passos numa tela só (**Configurações**, no menu do topo), com o progresso no topo.

Até conectar uma conta, só a tela **Configurações** fica disponível: Início, Publicar, Meus anúncios e Navegador dependem da conta e voltam para ela.

**Já usa o plugin hn-anuncio-ml?** O `npm run setup` avisa `app do plugin hn-anuncio-ml encontrado` e o passo 2 já vem com o App ID e a chave dele: clique em **Salvar e validar** e vá ao 3 (ver [seção 4](#4-login-sem-túnel-e-o-app-do-plugin)).

**1. URI de redirect.** A tela mostra a URI, com botão de copiar. Ela é fixa — `https://httpbin.org/get`, a mesma do plugin — e nunca muda.

**2. Criar o aplicativo no Mercado Livre.** No [DevCenter](https://developers.mercadolivre.com.br/devcenter):

1. **Criar aplicação**, e cole a URI de redirect em **URIs de redirect** — exatamente como está, sem barra no final. A URL de notificações pode ficar em branco: o painel não usa.
2. Em **Fluxos OAuth**, marque **Authorization Code**, **Client Credentials** e **Refresh Token**.
3. Em **Permissões**, dê leitura e escrita ao menos em *Publicação e sincronização*.
4. Aceite os termos, resolva o reCAPTCHA e **salve**. Sem salvar, nada é gravado.

Depois cole o **App ID** e a **Chave secreta** na tela. Antes de gravar, o painel **confere com o Mercado Livre**: par errado é recusado na hora (`invalid_client`), e não na hora de conectar a conta. A chave secreta vai cifrada para o banco.

Com as credenciais salvas, o painel **lê o cadastro do seu aplicativo no próprio ML** e confere se a URI de redirect está lá. Se faltar um fluxo OAuth ou sobrar uma barra no fim da URI, ele diz qual.

**3. Conectar a conta.** O botão abre a autorização do Mercado Livre numa aba nova. Depois de aceitar, o ML leva a uma página com um texto técnico: copie o **endereço inteiro da barra do navegador** (começa com `https://httpbin.org/get?code=`) e cole no campo que aparece no painel. Cada passagem conecta **mais uma** conta; o seletor no topo das telas troca a conta ativa. Se a URI de redirect não estiver no cadastro do app, o botão fica bloqueado com a explicação — em vez de mandar você para a tela de erro genérica do ML.

**Scraper.** Para medir posição na busca, o scraper precisa da sua conta logada no Chromium dele: aba **Navegador** → **Fazer login**. Você digita a senha e o código de verificação na própria tela do navegador; o programa só repassa cliques e teclas.

**Roupas e calçados: tabela de medidas.** Nessas categorias o ML exige uma tabela de medidas e o tamanho do anúncio (`SIZE_GRID_ID` e `SIZE_GRID_ROW_ID`). Na tela Publicar, depois de escolher Marca e Gênero, aparece o bloco **Tabela de medidas**: escolha uma tabela sua e o tamanho, ou crie a tabela ali mesmo (uma vez por marca e gênero), com tamanho, equivalência (P, M, G… — o painel sugere) e as medidas que o ML pede. Medido: o ML não oferece tabela pronta para as marcas testadas, e a busca devolve as tabelas da própria conta. As medidas aparecem para o comprador; tabela sem uso pode ser apagada, mas a exclusão leva até 24 h.

**Cada categoria tem regras próprias — e a tela se adapta.** A ficha técnica mostra os campos obrigatórios e também os "obrigatórios em alguns casos". O código de barras (GTIN/EAN) aceita só dígitos, confere o dígito verificador e tem a opção "Este produto não tem código de barras" com os motivos que o ML aceita (medido: sem código nem motivo, o ML recusa; com o motivo, aceita). Se mesmo assim o ML recusar por falta de campo, em qualquer categoria, o painel lê quais campos ele pediu, acrescenta-os à ficha em destaque e explica em português — em vez de mostrar o erro em inglês.

**Contas "User Products".** Contas com a marca `user_product_seller` publicam com `family_name` no lugar de `title` (o ML recusa os dois juntos); o painel lê isso da conta e monta o anúncio certo.

> Para testar sem sujar a conta real, crie um usuário de teste: `node criar-usuario-teste.js` (usa o App ID e a chave cadastrados no painel). A senha aparece **uma única vez**.

---

## 4. Login sem túnel e o app do plugin

O OAuth do Mercado Livre exige uma redirect URI **HTTPS**, e `localhost` não serve. Em vez de abrir um túnel até o seu computador, o painel usa o mesmo truque do plugin hn-anuncio-ml: a URI é uma página pública fixa (`https://httpbin.org/get`) que só **mostra** o endereço com o `code`. Você cola esse endereço no painel, e o painel troca o `code` pelo token direto com o ML.

- **O `code` só serve para este painel.** Ele vale poucos minutos, uma vez só, e a troca exige a chave secreta e o PKCE (`code_verifier`) que só o painel tem. O painel também confere o `state` quando você cola o endereço inteiro.
- **A URI nunca muda.** Não há URL de túnel para atualizar no DevCenter a cada reinício.
- **Outra URI?** `ML_REDIRECT_URI` no `.env` troca a página de retorno (tem de estar cadastrada no app).

**O app do plugin hn-anuncio-ml.** Se o plugin estiver instalado neste computador, o painel lê o aplicativo dele (`~/.hn-anuncio-ml/config.json`, ou o caminho de `ANUNCIO_OS_CONFIG`) e **pré-preenche** o passo 2 com o App ID e a chave. Ele só passa a valer quando você clica em **Salvar e validar** — a chave é testada no ML antes. A URI de redirect do plugin também vale aqui.

- **Só o aplicativo, nunca o token das contas.** O `refresh_token` do Mercado Livre é de uso único: se o painel e o plugin dividissem o mesmo, quem renovasse primeiro derrubaria o outro. Por isso cada um faz o próprio login — as contas que o plugin já conectou aparecem no passo 3 como sugestão, e com o app já autorizado é um clique.
- **Chave do plugin desatualizada?** Se ela foi trocada no DevCenter, o ML recusa o par (`invalid_client`) ao salvar e o passo 2 avisa. Copie a chave atual do DevCenter e salve de novo.

---

## 5. Scraper

O `npm start` sobe o scraper sozinho (`uv run python -m uvicorn api:app --host 127.0.0.1 --port 8100`) e o reinicia se cair. Logs em `logs/scraper.log`.

### 5.1 Login da conta no scraper

Pela aba **Navegador** do painel (`/navegador.html`): o Chromium abre no seu computador e a tela dele aparece na aba (~5 quadros/s). Seus cliques, o que você digita, colagens e rolagem vão para o navegador. Ao terminar, **Terminei — verificar** mede listagem e produto. Se liberou, o navegador fecha; se ainda estiver bloqueado, ele fica aberto na página do bloqueio para você continuar.

- Enquanto o navegador está aberto, as rotas de raspagem respondem `423` na hora (não ficam presas no lock do perfil).
- Ele fecha sozinho após 10 min sem clique ou tecla, ou 30 min no total.
- O painel não digita senha nem resolve captcha: só repassa o que você faz.

A sessão fica em `scraper/.sessao_ml/`. **São cookies de sessão logada**: equivalem à sua senha. Não versione, não copie para outra máquina.

### 5.2 Linha de comando (opcional)

```bash
cd scraper && uv run python scrape_cli.py status
```

| Comando | O que faz |
|---|---|
| `login` | abre o navegador para você logar; salva a sessão |
| `status` | a sessão ainda passa? |
| `desbloquear` | abre o navegador para você resolver o reCAPTCHA |
| `url <url> ...` | raspa um ou mais produtos |
| `busca "termo" [--paginas N] [--max N]` | busca por termo e raspa os resultados |
| `posicao MLB123 "termo"` | onde o anúncio aparece na busca |
| `--html pagina.html` | parse offline, sem rede |
| `--self-check` | checagem interna |

A saída vai para `scraper/saida/`. Contrato completo da API HTTP, com latências medidas e o formato dos erros: [`scraper/API.md`](scraper/API.md). Exemplo de cliente: [`scraper/cliente_exemplo.py`](scraper/cliente_exemplo.py).

A API escuta **só em 127.0.0.1**, de propósito. Um perfil de navegador aceita um acesso por vez, então os pedidos são serializados — chamadas paralelas não aceleram nada.

---

## 6. Estrutura do repositório

```
.
├── iniciar.js               npm start: sobe painel + scraper
├── instalar.js              npm run setup: uv, Python, Chromium, .env, app do plugin, testes
├── parar.js                 npm run parar: fecha painel e scraper
├── atualizar.js             npm run atualizar: traz as correções do repositório da aula
├── server.js                painel (só localhost) e login do ML com code colado
├── mcp.js                   servidor MCP local: as rotas do painel como ferramentas do Claude Code
├── .mcp.json                registra o servidor MCP para quem abrir o Claude Code nesta pasta
├── db.js                    SQLite: contas (tokens cifrados), credenciais do app, produtos, vendas
├── app-ml.js                valida App ID/chave, lê o cadastro do app no DevCenter e o app do plugin
├── scraper-processo.js      supervisor do scraper Python (sobe, vigia, reinicia)
├── processos.js             portas livres e encerramento de árvore de processos (macOS/Linux/Windows)
├── ambiente.js              cria o .env na primeira vez, com chave de cifra aleatória
├── criar-usuario-teste.js   cria um usuário de teste do ML
├── test*.js                 testes (npm test)
├── PRD-INSTALACAO.md        o que colar no Claude Code para instalar tudo
├── public/
│   ├── inicio.html          tela inicial: vendas do dia (é o que abre em "/")
│   ├── publicar.html        publicar anúncio
│   ├── anuncios.html        listar, editar e analisar anúncios
│   ├── navegador.html       tela remota do Chromium do scraper (login, reCAPTCHA)
│   ├── configuracao.html    primeiro acesso: URI de redirect, credenciais, conta, scraper
│   ├── layout.css           menu lateral e barra de título, iguais em todas as telas
│   └── aviso.js             aviso no topo das telas (falta configurar)
└── scraper/
    ├── scrape_cli.py        scraper e CLI (Playwright + BeautifulSoup)
    ├── api.py               API HTTP local (FastAPI)
    ├── navegador.py         sessão interativa (login, 2FA, reCAPTCHA pelo painel)
    ├── cliente_exemplo.py   como consumir a API do scraper
    ├── test_api.py          testes da API sem tocar a rede
    └── API.md               contrato da API do scraper
```

Nunca entram no git (já no `.gitignore`): `.env`, `dados.sqlite*`, `logs/`, `node_modules/`, `scraper/.sessao_ml/`, `scraper/.venv/`, `scraper/saida/`.

---

## 7. Referência de endpoints

### 7.1 Painel (`localhost:3100`)

Só atende pedidos com `Host` local, e `POST` só com `Origin` do próprio painel. Não há sessão nem senha.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/auth` | começa o OAuth (conecta mais uma conta): leva ao ML com a URI fixa e PKCE |
| GET | `/api/ping` | identifica o painel (usado para não subir duas cópias) |
| GET | `/api/config` | URI de redirect, situação no ML, credenciais, App ID e contas do plugin (sem a chave), scraper (`?forcar=1` relê o ML) |
| GET | `/api/config/app-do-plugin` | App ID e chave do plugin, para pré-preencher o passo 2 (fora do MCP: a chave não vai para o chat) |
| GET | `/api/config/resumo` | o que falta configurar (usado pelo aviso do topo) |
| POST | `/api/config/credenciais` | valida no ML e grava App ID + chave secreta |
| POST | `/api/config/conectar` | recebe o endereço (ou o `code`) colado depois de autorizar e conecta a conta |
| POST | `/api/scraper/reiniciar` | reinicia o scraper |
| GET | `/api/status` | conta ativa |
| GET | `/api/accounts` | contas conectadas (nunca devolve token) |
| POST | `/api/accounts/active` | troca a conta ativa |
| POST | `/api/accounts/remove` | esquece o token de uma conta |
| GET | `/api/items` | lista anúncios (`status`, `q`, `sort`, `offset`, `limit`, `dias`), com visitas do período |
| GET | `/api/periodo?dias=&ids=` | vendas, curva ABC, tendência e lucro do período (ver 9.1) |
| PUT | `/api/items/:id/custo` | grava custo do produto e outros custos por unidade (só no painel) |
| PUT | `/api/imposto` | imposto sobre a venda (%) da conta ativa |
| GET | `/api/items/:id` | anúncio completo + descrição + visitas |
| PUT | `/api/items/:id` | edita o anúncio |
| PUT | `/api/items/:id/description` | troca a descrição |
| GET | `/api/items/:id/analytics?dias=` | painel do anúncio numa janela (15/30/60/90/150 dias), com lucro |
| GET | `/api/items/:id/quality` | health e sugestões do ML |
| GET | `/api/items/:id/upgrades` | trocas de tipo de anúncio disponíveis |
| POST | `/api/items/:id/listing-type` | troca o tipo de anúncio |
| POST | `/api/items` | publica um anúncio novo |
| POST | `/api/pictures` | sobe uma foto (bytes crus no corpo) |
| GET | `/api/predict?q=` | sugere categoria pelo título |
| GET | `/api/category?id=` | ficha técnica + regras da categoria |
| GET | `/api/listing-types` | tipos de anúncio do site |
| GET | `/api/products` | espelho local dos anúncios |
| GET | `/api/scraper` | o scraper está no ar e com sessão válida? |
| GET | `/api/navegador` · `/api/navegador/tela` | estado e JPEG do navegador interativo |
| POST | `/api/navegador/abrir` · `/acao` · `/concluir` · `/fechar` | sessão interativa (ver 5.1) |
| GET/POST | `/api/keywords` · POST `/api/keywords/remove` | termos acompanhados por anúncio |
| POST | `/api/posicao` | mede a posição agora e grava no histórico |
| GET | `/api/ads/status` · `/api/ads/advertising/*` | Mercado Ads (`api-version: 2`) |

### 7.2 Scraper (`127.0.0.1:8100`)

| Método | Rota | O que faz |
|---|---|---|
| GET | `/health` | a API está de pé (não toca no navegador) |
| GET | `/status` | a sessão do ML ainda passa? |
| GET | `/produto?url=&imagens=` | raspa um produto |
| POST | `/produtos` | raspa vários (máx. 50) |
| GET | `/busca?q=&paginas=&maximo=&imagens=` | busca por termo e raspa os resultados |
| GET | `/posicao?item=&q=&paginas=` | posição do anúncio na busca + vizinhos com preço e vendas |
| GET | `/navegador` · `/navegador/tela` | estado e JPEG da sessão interativa |
| POST | `/navegador/abrir` · `/acao` · `/concluir` · `/fechar` | sessão interativa; só o painel deve chamar |

Guardas de entrada: só `https` e só domínios do Mercado Livre — `file://`, `http://` e outros hosts recebem `400`.

| Código | Significa | O que fazer |
|---|---|---|
| 400 | URL fora do domínio permitido ou não-https | corrigir a URL |
| 404 | a página carregou mas não é um produto | conferir o ID; anúncio removido cai aqui |
| 422 | lote acima de 50 URLs | dividir |
| 423 | o navegador interativo está aberto | concluir ou fechar na aba Navegador |
| 503 | página não carregou (bloqueio ou timeout) | aba Navegador do painel |

---

## 8. O que a API do ML deixa editar

Testado campo a campo em dois anúncios reais, alterando **de verdade** e restaurando
depois. Um PUT com o mesmo valor não serve de teste: o ML aceita o no-op e recusa a
mudança real.

| Campo | `PUT /items` | Quando é recusado |
|---|---|---|
| `title` | aceita | **anúncio com `family_name`** — `You cannot modify the title if the item has a family_name` |
| `price` | aceita | **anúncio com variações** — o preço vive em cada variação |
| `available_quantity` | aceita | **anúncio com variações** — o estoque vive em cada variação |
| `condition` | aceita | |
| `warranty` | aceita | derivado de `sale_terms`; a tela não expõe |
| `pictures` | aceita | a ordem enviada vira a ordem no anúncio |
| `attributes` | aceita | 54 editáveis numa categoria de informática, não só os 6 obrigatórios |
| `shipping` | aceita | |
| `category_id` | aceita | |
| `video_id` | aceita | vazio remove o vídeo |
| `seller_custom_field` | aceita | é o SKU interno |
| `sale_terms` | aceita | garantia e condições de venda |
| `listing_type_id` | **nunca** | use `POST /items/{id}/listing_type` |

**Estar pausado não trava nada.** A mensagem de erro do ML diz `[status:paused,
has_bids:false]` mesmo quando a causa é outra — num anúncio pausado *sem* variações o
preço muda sem problema. Cair nessa pista falsa é fácil; por isso a tela não adivinha:
ela lê `family_name` e `variations` do próprio anúncio e mostra o motivo antes de você
tentar.

`buildEdicao()` em `server.js` é a lista fechada desses campos: o que estiver fora é
descartado antes de chegar ao ML. Cada aceitação e cada recusa tem teste em `test.js`.

### Ficha técnica: todos os campos, não só os obrigatórios

A Central de Vendedores mostra "Características principais" e "Características
secundárias". A API entrega as duas coisas na mesma chamada — o que separa é a tag:

```
/categories/MLB121405/attributes  →  123 atributos
  6    obrigatórios      (required / catalog_required)
  3    condicionais
  69   ocultos ou read-only  → não dá para editar
  54   EDITÁVEIS            → é o que a tela mostra agora
```

A primeira versão mostrava só os 6. Num anúncio real, 23 dos outros 48 estavam em
branco — e é exatamente isso que faz a ML avisar *"corrija as características principais
para recuperar sua exposição"*.

`GET /api/category` devolve os 54 com `obrigatorio`, `value_type`, `values`, `unidades`,
`unidade_padrao` e `dica`. Quem escolhe o que mostrar é a tela:

- **Publicar** usa só os obrigatórios — publicar não deveria exigir 54 campos.
- **Editar** mostra os obrigatórios em cima e o resto num bloco recolhido, com o contador
  de quantos estão em branco.

Um controle por tipo, medido na categoria de informática: 25 `string`, 11 `number_unit`,
11 `boolean`, 3 `list`, 3 `number`, 1 `picture_id`. O `number_unit` vira **campo + seletor
de unidade** (`27` + `"`), porque o ML espera `"16 GB"` num campo só e pedir isso digitado
é pedir erro.

### Garantia e condição

**Garantia é `sale_terms`, não atributo**, e é lista fechada:

| Termo | Tipo | Valores |
|---|---|---|
| `WARRANTY_TYPE` | `list` | Garantia do vendedor · Garantia de fábrica · Sem garantia |
| `WARRANTY_TIME` | `number_unit` | número + dias/meses/anos |

Não existe endpoint que liste as opções: `/sites/MLB/sale_terms` dá **404** e
`/categories/{id}/sale_terms` dá **403**. Os ids (`2230280`, `2230279`, `6150835`) foram
lidos dos anúncios reais da conta, e o valor que o anúncio já tem é unido à lista — se o
ML criar um termo novo, ele aparece mesmo sem estar no código.

⚠️ O campo `warranty` do item é **derivado**: `"Garantia de fábrica: 12 meses"` é a junção
dos dois acima. Editá-lo como texto livre briga com a estrutura, então a tela não o expõe.

**Condição** sai de `settings.item_conditions` da categoria, não de uma lista fixa.
Medido: `condition: "refurbished"` responde **400 Validation error** na categoria de
informática, enquanto `not_specified` passa. Onde o ML aceitar Recondicionado, a opção
aparece sozinha.

`ITEM_CONDITION` existe como atributo com os três valores, mas vem com `hidden: true` —
é informativo, não editável.

### A mensagem de erro do ML não fica num campo fixo

Às vezes o texto útil vem em `message`, às vezes em `error`, às vezes só dentro de
`cause[]` — e um dos dois costuma ser um código inútil (`BODY_INVALID_FIELDS`).
`mensagemDoML()` escolhe a mais descritiva, ignorando os códigos em maiúsculas. Sem isso
o usuário vê `BODY_INVALID_FIELDS` em vez de "você não pode mudar o título".

Outras regras medidas:

- **Fotos**: mínimo **500 px** no maior lado; o ideal é 1200×1200 para permitir zoom. A tela mede a imagem no navegador antes de gastar o upload.
- **Visitas**: `/visits/items` aceita **um** id por chamada — a listagem busca em paralelo.
- **Encerrar é definitivo**: o ML não reativa anúncio encerrado. Para tirar do ar temporariamente, use Pausar.
- **Ficha técnica**: o ML recusa a publicação sem os atributos obrigatórios da categoria. A tela busca em `/categories/{id}/attributes` e exige antes de enviar.

---

## 9. Análise por anúncio

O menu **⋮ → Análise do anúncio** abre um painel com tudo que a API entrega sobre um item.
No topo, o nome do produto (H1), o código do anúncio e o link para vê-lo no Mercado Livre.
`GET /api/items/:id/analytics` junta oito chamadas em paralelo; cada bloco falha sozinho,
então um endpoint fora do ar não derruba o resto.

| Bloco | De onde vem | Exemplo real |
|---|---|---|
| Visitas 30 dias + série diária | `/items/{id}/visits/time_window` | 484 visitas, pico de 69 num dia |
| Visitas desde sempre | `/visits/items` | 9.449 |
| Pedidos, unidades, faturamento, ticket | cópia local dos pedidos (9.1) | só pedidos pagos da janela, sem teto |
| **Conversão** | pedidos ÷ visitas | 10,3% |
| Taxa do ML (preço de hoje) | `/sites/{site}/listing_prices` | taxa R$ 82,61 (13,5%) |
| Frete pago pelo vendedor | `/shipments/{id}/costs` dos envios reais (9.2) | por unidade vendida |
| **Lucro real e margem** | pedidos + frete + o custo que o vendedor digita (9.2) | lucro do período, margem e markup |
| Avaliações e nota | `/reviews/item/{id}` | 65 avaliações · nota 5,0 |
| Perguntas e sem responder | `/questions/search` | 41 · 0 sem responder |
| Mercado Ads | `/advertising/product_ads/ads/{id}` | active · id da campanha |
| Tendências da categoria | `/trends/{site}/{categoria}` | o que as pessoas buscam |

Visitas e vendas ficam em **dois gráficos**, cada um com a sua escala (nunca dois eixos no
mesmo gráfico). Passar o mouse mostra o valor do dia.

### 9.1 Período na listagem: vendas, curva ABC e tendência

A listagem tem um seletor de **Período** (15, 30, 60, 90 ou 150 dias). Cada anúncio ganha uma
faixa com: gráfico de vendas e de visitas, selo **▼ em queda / ▲ em alta / ● estável**,
unidades e faturamento do período, selo da **curva ABC** e o lucro real (se o custo estiver
cadastrado). O topo resume a conta: faturamento, pedidos, unidades e quantos anúncios venderam.

Ordenações novas, todas **no período escolhido**: *Mais vendidos*, *Menos vendidos*,
*Curva ABC (faturamento)* e *Maiores quedas de venda*. As do ML (`sold_quantity`) seguem lá
como "(total)", porque contam desde a criação do anúncio.

| Regra | Como é |
|---|---|
| Janela | dias **completos**, de 00h a 00h de Brasília, **até ontem**. Hoje fica de fora: é um dia pela metade e, medido numa conta real, o último ponto de todo gráfico afundava (409 → 227 visitas), jogando qualquer anúncio para "em queda" |
| Tendência | 2ª metade da janela contra a 1ª. ±15% ou mais é alta/queda; menos que isso, estável. Abaixo de 6 unidades (ou 30 visitas) somadas, diz "pouco dado" em vez de "queda de 100%" |
| Curva ABC | por faturamento da **conta inteira** no período: A soma os primeiros 80%, B os 15% seguintes, C o resto. Quem não vendeu é C |
| Venda | pedido `paid` ou `partially_refunded`. Cancelado não é faturamento |

**Por que uma cópia local dos pedidos.** O ML só ordena pelo total de sempre, e somar o
período anúncio a anúncio não escala: uma conta real tinha **11.058 pedidos em 150 dias**
(~220 chamadas por tela). O painel guarda as linhas de pedido na tabela `vendas`: a
primeira abertura de uma janela baixa os pedidos dela (2.056 pedidos de 30 dias em ~2,5 s);
depois, só o que mudou desde a última vez (`order.date_last_updated.from`), o que também
pega a venda antiga que foi cancelada. Medido na API:

| Fato | Consequência |
|---|---|
| `limit` aceita até **51**; `offset + limit` acima de **10.000** dá 400 | janela com mais pedidos é fatiada ao meio por data até caber |
| `order_items[].sale_fee` é a tarifa **por unidade** (3 un. a R$ 31,47 → 3,62) | tarifa do pedido = `sale_fee × quantity` |
| a série de visitas **não vem em ordem de data** e pula dias sem visita | a série é alinhada pela data, nunca pela posição |

### 9.2 Custos, lucro real e margem de contribuição

No bloco **Custos e lucro** da análise o vendedor digita o **custo do produto** e os **outros
custos** (embalagem, etiqueta) por unidade, e o **imposto** (% sobre a venda, um só para a
conta). Ficam no `dados.sqlite`: o Mercado Livre não sabe quanto o produto custou. O
resultado recalcula a cada tecla e só grava em **Salvar custos**. Na listagem, anúncio sem
custo mostra **Informar custo**, que abre a análise já no campo.

```
margem de contribuição (1 venda, preço de hoje)
  = preço − tarifa do ML − frete − custo do produto − outros − imposto sobre o preço
lucro real (período)
  = Σ preço pago nos pedidos − Σ tarifas cobradas − frete − custo × unidades − outros − imposto
```

A conta é a convencional: margem = lucro ÷ preço, markup = lucro ÷ custo.
A análise mostra também o **preço mínimo sem
prejuízo** (aproximado: tarifa e frete mudam por faixa de preço).

**Frete é o cobrado de verdade, não a estimativa.** Medido em 19/09/2026: para o mesmo
anúncio a estimativa do ML (`/users/{id}/shipping_options/free`) deu R$ 8,25 e o cobrado
(`/shipments/{id}/costs`, `senders[].cost`) foi R$ 6,95 — e o vendedor pagou frete num item
de R$ 49,90 **sem** frete grátis. O painel consulta até **20 envios** de cada anúncio na
janela, guarda cada custo na tabela `fretes` (não muda depois do envio) e usa **frete por
unidade = Σ frete ÷ Σ unidades** desses envios: numa conta real o frete por envio ia de R$ 0
a R$ 253 conforme a quantidade no pedido, e a média por envio errava. A estimativa só entra
quando o anúncio não vendeu na janela. Sem custo ou sem frete conhecido, o painel **não
mostra lucro** — nunca troca o que falta por zero.

### Até onde o histórico vai — medido

| Dado | Profundidade | Como |
|---|---|---|
| Visitas, série por dia | **máximo 150 dias** | `last=365` responde `400: invalid time window, should be smaller or equal to 150 days` |
| Visitas, total | **desde sempre** | `/visits/items` **ignora** `date_from`/`date_to` — devolve o total do anúncio em qualquer intervalo |
| Pedidos | **todo o histórico**, com filtro de data e paginação | `order.date_created.from/to` + `offset`; `paging.total` já é o número exato |
| Unidades vendidas | **desde sempre** | `sold_quantity` do item |

Não existe granularidade diária entre 150 dias e "sempre". Se quiser série mais longa,
grave as medições no banco — é o que o histórico de posições já faz.

Medido numa conta real: pedidos de 2023 e 2024 voltam `0`, e 2025 volta 3.377. A API não
promete profundidade ilimitada; confira antes de tratar um total como definitivo.

### Um erro que essa medição corrigiu

A primeira versão do analytics pegava os **50 pedidos mais recentes sem filtro de data** e
rotulava "Pedidos 30 dias". Num anúncio real esses 50 cobriam **cinco meses**, e a
conversão dividia esse número pelas visitas de 30 dias:

```
errado : 50 pedidos ÷ 523 visitas 30d = 9,6%
certo  : 11 pedidos ÷ 523 visitas 30d = 2,1%
```

Quase 5× inflado. Agora visitas, pedidos, faturamento e conversão usam **a mesma janela**,
escolhida no seletor da modal (15, 30, 60, 90 ou 150 dias) — e a conversão fica estável entre
elas (2,1% / 2,2% / 2,3%), que é o sinal de que a conta fecha.

### Posição na listagem

A API oficial **não entrega**: `/sites/{site}/search` responde `403` mesmo com token do
vendedor. Quem mede é o scraper, a partir da **ordem que o próprio Mercado Livre declara**
no JSON da página de busca (`position`).

Como o número é calculado (desde 18/09/2026, medição "v2"):

- O `position` do ML começa em **0** e conta **banners** (ex.: `CART_INTERVENTION`) como
  casas da grade. O painel mostra o **número do card que o comprador vê**: a partir de 1, só
  anúncios, somando as páginas lidas.
- Cada anúncio vem de um objeto JSON **lido inteiro**. A v1 lia uma janela de 900 caracteres
  depois do `item_id`, maior que o objeto (~700), e pegava posição e preço do vizinho
  (medido: 11 de 59 com preço, e posições puladas).
- **Preço é o do card** (o que o comprador vê). Nos anúncios pagos o `price` do JSON é o
  total parcelado: card R$ 224,82 à vista contra JSON R$ 236,65 = 8× R$ 29,58.
  O preço sem desconto (`price_base`) aparece riscado.
- O mesmo anúncio pode aparecer **duas vezes** (pago e orgânico): os dois cards contam.
- As medições v1 ficam no banco (`versao = 1`) para auditoria, mas não entram na tela nem
  na variação ▲▼, porque comparar v1 com v2 mostraria um movimento que não aconteceu.
- **Não apareceu ≠ não mediu.** Se o anúncio não está nas posições lidas, a tela diz
  "fora das 60 primeiras posições" e oferece **Buscar em 3 páginas**. Junto, mostra os
  **outros anúncios seus** que apareceram na mesma busca (o painel pergunta ao ML, via
  `/items?ids=` em lotes de 20, quem é o vendedor de cada resultado). Isso importa: o ML
  costuma mostrar só um anúncio por vendedor para o mesmo produto. Medido numa conta real: para
  um dos termos acompanhados, o anúncio medido ficou de fora, e outros **9**
  anúncios da mesma conta ocupavam o 5º, 6º, 7º, 8º, 19º, 20º, 21º, 22º e 57º lugares.
- **A tabela tem todos os vendedores.** Cada medição guarda a busca inteira (coluna `lista`,
  ~25 KB). O resumo mostra os primeiros colocados, os vizinhos e os seus anúncios; cada
  "⋯ N anúncios de outros vendedores" abre ali mesmo, e **Ver todos** mostra os 60. Cada linha
  traz foto, título, vendedor, preço (com o sem desconto riscado) e quanto está acima ou
  abaixo do seu. Título, foto e vendedor vêm do card da página, porque a API devolve 403
  para anúncio de outro vendedor (medido): cobertura de 60/60 em título e foto e 52/60 em
  vendedor. O selo **SEU** vem da API (ela responde 200 só para os seus).
- **Lentidão não é bloqueio.** Se a página do ML não carrega em 45 s (medido com o Mac em
  load 74), o scraper responde `504 — tente de novo`; só um bloqueio de verdade vira `503`
  e pede a aba Navegador. Antes os dois viravam "bloqueio" e o painel guardava a sessão como
  bloqueada por 10 min.
- **Acompanhar termo já mede.** O termo novo entra medindo, com contador de segundos.
- O painel lembra por 10 min se a sessão do scraper está válida (`GET /api/scraper`;
  `?forcar=1` checa de novo). Antes, cada abertura da análise abria uma listagem de teste no
  ML: segurava o navegador por 5–10 s e somava acessos que aumentam o risco de reCAPTCHA.
  Medições e o desbloqueio atualizam esse estado.
- O ícone ao lado de cada anúncio abre a URL limpa do item
  (`produto.mercadolivre.com.br/MLB-…`), nunca o link do card: o dos pagos passa por
  `click1.mercadolivre` e conta um clique pago para o concorrente.

Na modal de análise, seção **Posição na listagem**: cadastre os termos que importam para
aquele produto e clique em **Medir agora**. Cada medição leva ~3 s e fica gravada, então a
próxima mostra se o anúncio **▲ subiu** ou **▼ caiu**.

A mesma página ainda entrega, de cada vizinho: **preço, unidades vendidas, pago ou
orgânico e frete grátis** — sem custo extra, é a mesma requisição.

Medido num anúncio real (v2; termo e IDs trocados por exemplos):

```
suporte de parede inox → 5º de 60 · 4 pagos acima
  2º  MLB1000000002  R$ 199,02            1000+  Pago
  3º  MLB1000000003  R$ 249,71            1000+  Pago
  4º  MLB1000000004  R$ 151,05 (de 159)   1000+  Pago
  5º  MLB1000000005  R$ 31,47 (de 49,90)  1000+  Orgânico   ← seu
  6º  MLB1000000006  R$ 35,90              500+  Orgânico
```

**Só funciona com painel e scraper na mesma máquina.** O painel chama `SCRAPER_URL`
(padrão `http://127.0.0.1:8100`). Não exponha essa porta para fora deste computador: ela dirige um
navegador com a sua sessão logada. Se o scraper estiver fora do ar, a seção diz o motivo
e o resto da análise continua funcionando.

**A posição não é absoluta.** Varia por termo, região e personalização da sessão logada.
Serve para acompanhar a tendência do seu anúncio, não como número oficial.

Por que não usar o `/busca` que já existia: ele raspa **cada produto** (4 s × N). Para
posição basta a página de listagem. E o `links_de_busca` só enxerga os `<a href>` — numa
medição achou 35 links onde a página tinha 60 anúncios. O `resultados_da_busca` lê o JSON
e pega os 60.

### O que a API não entrega

- **Posição na listagem pela API oficial.** `/sites/{site}/search` responde **403**. Está
  resolvido pelo scraper (acima), não pela API.
- **Métricas do Mercado Ads** (impressões, cliques, ACOS, investimento). O único caminho
  que responde é `/advertising/product_ads/ads/{item_id}`, que devolve status, campanha e
  grupo — não os números. Todos os caminhos de campanha e de métrica testados deram 404.
  O repasse `GET /api/ads/advertising/*` continua aberto para quando o caminho certo for

---

## 10. Banco de dados

`dados.sqlite`, criado sozinho no primeiro boot (`node:sqlite`, nativo).

| Tabela | Guarda |
|---|---|
| `contas` | uma linha por conta ML: id, nickname, site, tokens **cifrados**, validade |
| `estado` | conta ativa, App ID, chave secreta (**cifrada**), imposto da conta |
| `produtos` | cada anúncio publicado ou listado, com o payload, ligado à conta |
| `palavras`, `posicoes` | termos acompanhados e o histórico de posição na busca |
| `vendas` | cópia das linhas de pedido (data, status, quantidade, preço, tarifa, envio), sincronizada por conta |
| `fretes` | custo de envio cobrado do vendedor, por envio (consultado uma vez) |
| `custos` | custo do produto e outros custos por unidade, por anúncio (o imposto da conta fica em `estado`) |

Tokens e chave secreta usam **AES-256-GCM** com chave derivada de `ML_DB_KEY`, que o `npm start` gera sozinho no `.env` na primeira vez. **Perder o `.env` = reconectar as contas** (os tokens ficam ilegíveis). Guardamos só id, nickname e site da conta: nada de CPF, e-mail ou endereço, que o `/users/me` devolve mas o sistema não usa.

---

## 11. Testes

```bash
npm test
```

| Arquivo | Cobre |
|---|---|
| `test.js` | montagem do payload de publicação e de edição |
| `test-db.js` | cifra, multi-conta, troca de conta ativa, isolamento, configuração |
| `test-analise.js` | janela até ontem, série fora de ordem, tendência e "pouco dado", curva ABC, lucro real, margem, preço mínimo, frete por unidade, venda cancelada saindo da conta |
| `test-config.js` | URI de redirect no cadastro (confere, faltando, barra no fim, fluxos), o endereço colado e a leitura do app do plugin |
| `test-servidor.js` | sobe o painel com um Mercado Livre falso e prova: só localhost, `POST` de outro site recusado, rotas de túnel/senha fora, telas travadas sem conta, app do plugin pré-preenchido sem vazar chave nem token, login completo com code colado (`state`, PKCE, uso único), URI fora do cadastro e chave recusada explicadas antes do ML, sem escapar de `public/` |
| `test-mcp.js` | o servidor MCP por stdio de verdade: toda ferramenta cai numa rota que existe, `stdout` só com JSON-RPC, notificação sem resposta, erro de ferramenta como `isError` legível, e `ML_MCP_ESCRITA=0` escondendo e bloqueando o que muda dados |

Todos usam banco temporário: rodar teste não toca no seu `dados.sqlite`. O scraper tem os dele:

```bash
cd scraper && uv run python test_api.py
```

---

## 12. Quando der errado

### A tela diz que o app não tem a URI de redirect

Abra o seu app no DevCenter, acrescente a URI do passo 1 em **URIs de redirect** (exatamente igual, sem barra no final), salve e recarregue a tela Configurações (ela confere de novo ao abrir). O ML aceita várias URIs no mesmo app: não precisa apagar as outras.

### "Não salvei: App ID ou chave secreta incorretos"

A chave foi trocada no DevCenter — ou, se veio do plugin hn-anuncio-ml, a de lá está velha. Copie o App ID e a chave atuais do DevCenter para o passo 2.

### "Desculpe, não foi possível conectar o aplicativo à sua conta"

A tela de autorização do ML mostra isso para quatro causas diferentes. Elimine em ordem:

1. **`redirect_uri` não bate.** O painel já confere antes de mandar você para o ML — se passou, confira se salvou o app no DevCenter depois de colar a URI.
2. **App ID de outro aplicativo.** Dois apps diferentes dão exatamente esse erro.
3. **Conta colaborador.** Operador/colaborador não consegue autorizar — use a conta principal (`invalid_operator_user_id`).
4. **Dados pendentes de validação.** Vendedor *ou* dono da aplicação com pendência em *Meu Perfil → Dados pessoais* e *Dados da conta*. Enquanto houver, o ML não concede novas autorizações.

### "Esse login expirou" ao colar o endereço

O `code` vale poucos minutos e uma vez só, e o painel só aceita o do último **Conectar conta**. Clique em **Conectar conta** de novo e cole o endereço novo.

### Scraper "reiniciando" sem parar

`logs/scraper.log` mostra o erro do Python. O mais comum é faltar o Chromium: rode `npm run setup` de novo.

### Scraper devolve 503 em tudo

reCAPTCHA ou sessão caída. Aba **Navegador** → **Resolver reCAPTCHA** (ou **Fazer login**).

### `curl` e navegador automatizado tomam 403 em `auth.mercadolivre.com.br`

É o WAF da Cloudflare do lado do ML. A tela de autorização só abre num navegador de verdade.

### "Node … é antigo demais"

O painel precisa do Node 22.13 ou mais novo (`node:sqlite`). Atualize e rode `npm run setup` de novo.

---

## 13. Segurança

- **O painel não existe fora deste computador.** Ele escuta só em `127.0.0.1`, recusa `Host` que não seja local (barra *DNS rebinding*) e `POST` cuja origem seja outro site — então uma página aberta no navegador não consegue agir no painel. É isso que o protege; por não haver endereço público, não há senha. Não o exponha (túnel, `0.0.0.0`, porta aberta no roteador): ele daria acesso às contas a quem chegasse.
- **O login pelo `code` colado.** O `state` e o PKCE ficam no servidor; o `code` é de uso único, vence em minutos e só vale com a chave secreta. O painel só aceita o `code` do último **Conectar conta**, por até 15 minutos.
- **O token do plugin hn-anuncio-ml não é tocado.** Do cofre do plugin o painel lê só o aplicativo (App ID, chave, URI) e o ID/apelido das contas.
- **Segredos nunca em texto puro:** chave secreta e tokens cifrados no banco. `.env`, `dados.sqlite*`, `logs/` e `scraper/.sessao_ml/` estão no `.gitignore`.
- **Secret exposto = secret queimado.** Se a chave do DevCenter aparecer num print, log ou vídeo, gere outra no DevCenter e cole no painel.
- **Não exponha a porta do scraper.** Ela dirige um navegador logado e não tem autenticação.
- **Contas pessoais não devem ser usadas para testes** (documentação do ML). Use `criar-usuario-teste.js`.

---

## 14. MCP: o painel dentro do Claude Code

O `mcp.js` é um servidor **MCP local**: ele entrega ao Claude Code (ou a outro cliente MCP) as mesmas capacidades do painel — listar anúncios, melhores produtos, curva ABC, análise por anúncio, publicar, editar, medir posição — e mais o repasse para a API do Mercado Livre inteira. Assim dá para perguntar em português, no terminal, e o Claude Code busca o dado:

> *"quais foram meus 10 melhores produtos nos últimos 30 dias?"*
> *"quem está na curva A e perdendo venda?"*
> *"grave custo de R$ 42,30 no MLB1234567890 e me diga a margem"*

**Como ligar.** Abra o Claude Code **na pasta do projeto**. O `.mcp.json` já está no repositório: ele pergunta se você aprova o servidor `HN-Gestor-ML` e pronto. Confira com o comando `/mcp` — deve aparecer `HN-Gestor-ML: connected`. Nada a instalar: o servidor não tem dependência nenhuma além do próprio Node.

A tela **Configurações** do painel ensina isso sem sair de lá: mostra o estado (se já dá para usar ou se falta conectar a conta), a pasta do projeto e a linha pronta para colar no Terminal (`cd "…" && claude`), com botão de copiar.

**Não pede login nem OAuth.** Ele usa a conta que **você já conectou no painel** (passo 3 das Configurações). Os tokens continuam cifrados no SQLite e são renovados pelo mesmo código do painel. Se nenhuma conta estiver conectada, as ferramentas dizem isso em vez de falhar em silêncio.

**Não abre porta nenhuma.** A conversa é por `stdin`/`stdout`, entre o Claude Code e o processo, neste computador. E **de propósito não existe rota HTTP de repasse** para a API do ML: ela viraria "faça qualquer coisa na conta do vendedor" a um pedido de distância.

**O painel não precisa estar rodando.** O `npm start` e o MCP podem conviver: os dois escrevem no mesmo SQLite em modo WAL. Só a ferramenta de posição (`ml_posicao`) depende do scraper no ar.

### As ferramentas

| Ferramenta | O que faz |
|---|---|
| `ml_contas` · `ml_conta_usar` | contas conectadas; trocar a ativa |
| `ml_anuncios` | listar anúncios. `sort=vendas_desc` = **melhores produtos**, `sort=abc` = **curva ABC**, `sort=queda` = quem está caindo |
| `ml_periodo` | vendas, curva ABC, tendência, frete real e lucro de até 50 anúncios |
| `ml_anuncio` · `ml_analise` · `ml_qualidade` · `ml_upgrades` | anúncio completo, painel do anúncio na janela, health e sugestões do ML, trocas de tipo |
| `ml_posicao` · `ml_termos` · `ml_termo_add` · `ml_termo_remover` | posição na busca (usa o scraper) e termos acompanhados |
| `ml_publicar` · `ml_editar` · `ml_editar_descricao` · `ml_trocar_tipo` | publicar e editar anúncio |
| `ml_custo` · `ml_imposto` | custo por anúncio e imposto da conta — é o que falta para sair lucro e margem |
| `ml_prever_categoria` · `ml_categoria` · `ml_tipos_anuncio` | apoio ao cadastro |
| `ml_config` · `ml_scraper` · `ml_ads` | configuração do app, estado do scraper e Mercado Ads |
| `ml_api` | **a API do ML inteira**: qualquer caminho de `api.mercadolibre.com` com o token da conta ativa |

Cada ferramenta é uma rota do painel — o cálculo de curva ABC, tendência, frete e lucro é o **mesmo** que a tela mostra (`server.js` + `public/analise.js`), não uma segunda implementação. Um teste (`test-mcp.js`) confere que toda ferramenta aponta para uma rota que existe: renomeou rota, quebra no `npm test`, não na frente do usuário.

### Só leitura

As ferramentas que mudam algo (publicar, editar, custo, imposto, trocar tipo, e `POST`/`PUT`/`DELETE` no `ml_api`) vêm **ligadas** — é o seu painel. Para deixar o servidor apenas de leitura, ponha no `.env`:

```
ML_MCP_ESCRITA=0
```

Com isso elas somem da lista e, se alguém insistir, a resposta explica por quê. O Claude Code ainda pede sua aprovação a cada chamada, de qualquer forma.

Para depurar fora do Claude Code: `npm run mcp` e digite uma linha de JSON-RPC (ex.: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`). O log vai para o `stderr`; o `stdout` só carrega protocolo.

---

## 15. Créditos e licença

Projeto da **Aula Mercado Livre - Henrique Niada**.

O scraper começou a partir do projeto `alxmares/webscraping-MercadoLibre`, uma ferramenta em Tkinter para copiar dados de anúncios do Mercado Livre. A abordagem original — `requests` direto na página — parou de funcionar: o Mercado Livre bloqueia acesso anônimo à listagem e devolve parede de login ou reCAPTCHA. Este repositório troca isso por um navegador real com a sua sessão logada (Playwright, perfil persistente), e acrescenta CLI, API HTTP, sessão interativa pelo painel e testes. Nenhum arquivo do projeto original foi incluído: o repositório de origem **não declara licença**, então os direitos permanecem com o autor.

Licença **MIT** — ver [`LICENSE`](LICENSE). Pode usar, copiar, modificar e redistribuir, mantendo o aviso de copyright.

---

## Aviso

Ferramenta para fins educacionais. Respeite os termos de uso do Mercado Livre. Raspagem em volume, com conta logada, pode levar a bloqueio da conta — o scraper serializa os pedidos justamente para não parecer tráfego automatizado agressivo.
