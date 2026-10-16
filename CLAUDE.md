# Aula Mercado Livre - Henrique Niada

Responda em português do Brasil. Instalação do zero: siga `PRD-INSTALACAO.md`.

## Rodar

- `npm run setup` — instala tudo (uv, Python, Chromium) e roda os testes. Idempotente.
- `npm start` — sobe painel (`localhost:3100`) e scraper Python (`127.0.0.1:8100`) juntos.
  Processo longo: rode em segundo plano. `Ctrl+C` ou `npm run parar` encerra os dois.
- `npm run atualizar` — traz as correções do repositório da aula (fork não recebe sozinho).
- `npm run mcp` — servidor MCP por stdio (só para depurar; o Claude Code sobe sozinho pelo
  `.mcp.json` de quem abre esta pasta). Confira com `/mcp`.
- `npm test` — testes do painel. Scraper: `cd scraper && uv run python test_api.py`.
- Logs: `logs/scraper.log`.

## Arquitetura (leia antes de mexer)

- `server.js` sobe **um** servidor, só em `127.0.0.1`, que exige Host local e recusa POST com
  Origin de outro site (`pedidoLocal`). É isso que protege o painel — não há senha nem túnel:
  ele não existe fora deste computador. Não abra porta pública nem crie atalho que pule
  `pedidoLocal`.
- Login do ML sem túnel: `/auth` abre o ML numa aba com `redirect_uri` fixa
  (`app-ml.js#REDIRECT_PADRAO`, `https://httpbin.org/get`, a mesma do plugin hn-anuncio-ml);
  o aluno cola o endereço de volta e `POST /api/config/conectar` troca o code (PKCE sempre).
- App ID e chave: SQLite (tabela `estado`) → `.env`. O app do plugin hn-anuncio-ml
  (`~/.hn-anuncio-ml/config.json` ou `ANUNCIO_OS_CONFIG`; `app-ml.js#appDoPlugin`) só
  PRÉ-PREENCHE o passo 2 via `GET /api/config/app-do-plugin` — rota fora do MCP, porque
  devolve a chave. Vale depois do "Salvar e validar". O token das contas do plugin nunca é
  lido nem copiado (refresh_token é de uso único; dividir derruba um dos dois).
- Sem conta conectada, toda página `.html` (e `/`) menos `configuracao.html` redireciona
  para a Configuração; a tela trava os links do menu.
- `app-ml.js#situacao` confere se a URI fixa está no cadastro real do app no ML (lido via
  `client_credentials`). `invalid_client` = chave errada/trocada → `pendente: 'credenciais'`.
- Scraper: `scraper-processo.js` sobe e reinicia o Python; ele escuta só em `127.0.0.1`.
- `mcp.js` expõe as MESMAS rotas do painel como ferramentas MCP (stdio, sem porta, sem OAuth:
  usa a conta já conectada). Ferramenta nova = uma linha na tabela `FERRAMENTAS` apontando
  para a rota; `server.js#despachar` é o único caminho, e `test-mcp.js` reprova ferramenta
  que aponte para rota inexistente. O repasse livre à API do ML (`ml_api`) mora só no MCP e
  usa `server.js#ml` — não crie rota HTTP equivalente (ver "Nunca").

## Nunca

- Commitar `.env`, `dados.sqlite*`, `logs/`, `scraper/.sessao_ml/` (cookies da conta logada).
- Pedir App ID ou chave secreta no chat: eles são digitados no painel (ou vêm do plugin).
- Pôr `/api/config/app-do-plugin` na tabela do MCP ou a chave na `/api/config`.
- Ler, copiar ou renovar o token de conta do cofre do plugin hn-anuncio-ml.
- Usar `Referrer-Policy: no-referrer` no painel: o navegador passa a mandar `Origin: null`
  no POST e a checagem de origem recusa o próprio usuário.
- Expor o painel ou o scraper para fora deste computador (túnel, `0.0.0.0`, porta pública).
- Criar rota HTTP de repasse para a API do Mercado Livre: vira "faça qualquer coisa na conta
  do vendedor" a um pedido de distância. Repasse é só no MCP.
