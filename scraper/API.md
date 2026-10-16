# API local — Scraper Mercado Livre

Documento de integração. Público-alvo: um agente de IA que vai consumir esta API.
Tudo aqui foi medido contra a API rodando, não estimado.

---

## 1. O que ela é

HTTP local (FastAPI) que raspa páginas de produto do Mercado Livre **dirigindo um
navegador Chromium real com a sessão do usuário já logada**. Não é cliente da API
oficial do Mercado Livre.

**Consequências que mudam o seu design de cliente — leia antes de implementar:**

| Fato | Impacto no cliente |
|---|---|
| Um perfil de navegador = **um acesso por vez**. A API serializa com lock. | Paralelizar requests **não acelera nada**. Requests concorrentes ficam na fila. |
| Cada página leva ~2–4 s | Chamadas são **lentas por natureza**. Use timeout alto (≥120 s). |
| O Mercado Livre pode reapresentar reCAPTCHA | A API devolve **503** com a ação de correção. É um humano que resolve. |
| Escuta só em `127.0.0.1`, sem autenticação | Não exponha na rede. Quem alcança a porta usa a conta logada do usuário. |

---

## 2. Subir

No dia a dia não precisa: o `npm start` (na raiz) sobe o scraper junto com o painel e o reinicia se cair. À mão, para testar só ele:

```bash
cd scraper
uv run python -m uvicorn api:app --host 127.0.0.1 --port 8100
```

- Base URL: `http://127.0.0.1:8100`
- OpenAPI (gere seu cliente a partir daqui): `http://127.0.0.1:8100/openapi.json`
- Docs interativas: `http://127.0.0.1:8100/docs`

**Pré-requisito:** a sessão do navegador precisa estar liberada. Cheque com `GET /status`.

---

## 3. Endpoints

### `GET /health`
Só diz se o processo está de pé. **Não toca no navegador** — use para readiness check.

```json
{ "ok": true }
```

### `GET /status`
Faz uma requisição real ao Mercado Livre para ver se a sessão ainda passa. Leva ~3 s.

```json
{ "sessao": "valida" }
{ "sessao": "bloqueada", "acao": "uv run python scrape_cli.py desbloquear" }
```

Sempre **200**. O bloqueio vem no corpo, não no status — é uma consulta de saúde,
não uma falha da chamada.

### `GET /produto`
| Param | Tipo | Padrão | Obs |
|---|---|---|---|
| `url` | string | — | obrigatório, `https://` e host do Mercado Livre |
| `imagens` | bool | `false` | `true` baixa as fotos em `saida/imagens/<slug>/` |

```bash
curl "http://127.0.0.1:8100/produto?url=https://www.mercadolivre.com.br/cafeteira-nespresso-essenza-mini-preta-127v/p/MLB19479467"
```

### `POST /produtos`
Lote. Corpo:

```json
{ "urls": ["https://www.mercadolivre.com.br/.../p/MLB1", "..."], "imagens": false }
```

`urls`: 1 a 50 itens. Acima disso é **422**.

### `GET /busca`
Busca por termo, coleta os links da listagem e raspa cada produto.

| Param | Tipo | Padrão | Faixa |
|---|---|---|---|
| `q` | string | — | mín. 2 caracteres |
| `paginas` | int | `1` | 1–5 |
| `maximo` | int | `10` | 1–50 |
| `imagens` | bool | `false` | — |

```bash
curl "http://127.0.0.1:8100/busca?q=liquidificador&maximo=3"
```

---

## 4. Schema de resposta

`/produto` devolve um objeto; `/produtos` e `/busca` devolvem uma lista dele.

```json
{
  "url": "https://www.mercadolivre.com.br/.../p/MLB19479467",
  "titulo": "Cafeteira Nespresso Essenza Mini Preta 127V",
  "preco": "512.05",
  "marca": "Nespresso",
  "imagens": ["https://http2.mlstatic.com/D_NQ_NP_762385-MLA99889045659_112025-F.webp"],
  "imagens_baixadas": null
}
```

| Campo | Tipo | Garantias |
|---|---|---|
| `url` | string | sempre presente |
| `titulo` | string | **sempre preenchido num 200** — se não extraiu, vira 404 |
| `preco` | string \| null | string decimal com ponto (`"512.05"`), **não** número. Sem símbolo de moeda. Pode ser `null` em anúncio sem preço |
| `marca` | string \| null | `null` quando o anúncio não declara |
| `imagens` | string[] | URLs já normalizadas para a maior resolução (`-F`). Deduplicadas. Ícones da interface removidos. Pode ser `[]` |
| `imagens_baixadas` | int \| null | quantas foram salvas em disco; `null` quando `imagens=false` |

`preco` é string de propósito: preserva a precisão exata do anúncio. Converta para
`Decimal`, nunca para `float`, se for fazer conta com dinheiro.

---

## 5. Erros — contrato

| Código | Significado | O cliente deve |
|---|---|---|
| **400** | URL não é `https://` ou o host não é do Mercado Livre | Corrigir a URL. Não repetir igual |
| **404** | A página carregou mas não tem produto (ID errado, anúncio removido) | Não repetir. Marcar o item como inválido |
| **422** | Corpo fora do schema (ex.: mais de 50 URLs) | Corrigir o pedido |
| **503** | Bloqueio do Mercado Livre (reCAPTCHA / sessão caiu) | **Parar o lote.** Avisar o humano. Não repetir em loop |

400, 404 e 503 trazem `detail` com `erro`, `url` e `acao`/`dica`:

```json
{ "detail": { "erro": "a pagina nao tem produto",
              "url": "https://www.mercadolivre.com.br/x/p/MLB18068293",
              "dica": "confira o ID; anuncio removido tambem cai aqui" } }
```

**Sobre o 503:** é o único erro que exige um humano. A correção é rodar
`uv run python scrape_cli.py desbloquear` no terminal e resolver o reCAPTCHA na
janela. **Nunca tente resolver o captcha programaticamente** — além de violar os
termos do Mercado Livre, derruba a conta.

---

## 6. Latência medida

| Chamada | Tempo real |
|---|---|
| `GET /health` | instantâneo |
| `GET /status` | ~3 s |
| `GET /produto` | **3,4 s** |
| `POST /produtos` (2 URLs) | **6,1 s** |
| `GET /busca` (1 listagem + 3 produtos) | **13,8 s** |
| 2 listagens + 15 produtos (via CLI) | **79 s** |

Regra prática: **~2–4 s por página**. Estime `(paginas + maximo) × 4 s` e some folga.

Um lote de 50 produtos leva ~3 minutos numa única requisição HTTP. Se isso estourar
o seu timeout, **quebre em lotes menores no cliente** — não paralelize, o lock
serializa de qualquer jeito.

---

## 7. Como implementar o cliente

1. `GET /health` → a API subiu?
2. `GET /status` → se `"bloqueada"`, **pare** e peça ao humano para rodar o `desbloquear`. Não siga.
3. Faça as chamadas **em série**, com timeout ≥120 s.
4. Em **503**, aborte o lote inteiro e avise o humano. Em **404**, pule só aquele item e continue.
5. Guarde `preco` como `Decimal`. Guarde `imagens` como lista de URLs — elas são estáveis e já estão na maior resolução.

Esqueleto:

```python
import requests
from decimal import Decimal

BASE = "http://127.0.0.1:8100"


class Bloqueado(Exception):
    """Exige um humano: reCAPTCHA ou sessao caida."""


def raspar(urls: list[str]) -> list[dict]:
    out = []
    s = requests.Session()
    if s.get(f"{BASE}/status", timeout=60).json()["sessao"] != "valida":
        raise Bloqueado("rode: uv run python scrape_cli.py desbloquear")
    for u in urls:                          # em serie: paralelizar nao ajuda
        r = s.get(f"{BASE}/produto", params={"url": u}, timeout=120)
        if r.status_code == 404:
            continue                        # anuncio invalido: pula esse
        if r.status_code == 503:
            raise Bloqueado(r.json()["detail"]["acao"])
        r.raise_for_status()
        d = r.json()
        d["preco"] = Decimal(d["preco"]) if d["preco"] else None
        out.append(d)
    return out


if __name__ == "__main__":
    for p in raspar([
        "https://www.mercadolivre.com.br/x/p/MLB19479467",
        "https://www.mercadolivre.com.br/x/p/MLB18068293",   # inexistente: 404, pulado
    ]):
        print(p["titulo"], "| R$", p["preco"], "|", len(p["imagens"]), "imgs")
```

Rodando esse bloco tal como está (`cliente_exemplo.py`), a saída real é:

```
Cafeteira Nespresso Essenza Mini Preta 127V | R$ 512.05 | 17 imgs
```

---

## 8. Limites conhecidos

- **Sem persistência.** A API só responde; não grava banco. `imagens=true` escreve em `saida/imagens/`, e o CLI sobrescreve `saida/dados.json` a cada execução.
- **`/busca` pode repetir o mesmo produto** com URLs diferentes (catálogo vs. anúncio do vendedor). Deduplique por `titulo` no cliente, se importar.
- **Sem cache.** Duas chamadas à mesma URL raspam duas vezes.
- **Sem autenticação.** A proteção é só o bind em `127.0.0.1`.
- **Um processo só.** Não rode duas instâncias da API — elas brigam pelo lock do perfil do Chromium.
- **Sem estoque, vendedor, avaliações ou frete.** Só título, preço, marca e imagens. Esses outros campos existem na API oficial do Mercado Livre, não aqui.

## 9. Checagem

```bash
uv run python test_api.py        # guardas de entrada/saida, sem rede
uv run python scrape_cli.py --self-check   # parser, dedup, deteccao de bloqueio
```
