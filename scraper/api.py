"""API local do scraper do Mercado Livre.

    uv run uvicorn api:app --host 127.0.0.1 --port 8100

Docs interativas: http://127.0.0.1:8100/docs
OpenAPI (para gerar cliente): http://127.0.0.1:8100/openapi.json

Escuta so em 127.0.0.1. Nao exponha na rede: ela dirige um navegador
com a SUA sessao logada do Mercado Livre.
"""
import threading
from concurrent.futures import TimeoutError as Demorou
from contextlib import asynccontextmanager, contextmanager
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Response
from pydantic import BaseModel, Field

import scrape_cli
from navegador import Fechado, Ocupado, Sessao
from persistente import Persistente
from scrape_cli import (TESTE_URL, baixar, baixar_imagens, links_de_busca,
                        parse, posicao, _bloqueado)

# Um perfil de navegador = um acesso por vez. O lock serializa os pedidos;
# sem ele, dois requests simultaneos brigam pelo lock do perfil do Chromium.
_navegador = threading.Lock()
# Chromium vivo entre as chamadas: sem ele, cada requisicao paga o startup e
# refaz o proof-of-work do ML. Instalado no scrape_cli para que posicao() e
# tudo mais que chama baixar() ja aproveite.
persistente = Persistente()
scrape_cli.usar_baixador(persistente.baixar)
# Sessao interativa (login / 2FA / reCAPTCHA pelo painel). Segura o mesmo lock
# enquanto estiver aberta, e toma o perfil de volta do contexto persistente.
sessao = Sessao(_navegador, liberar=persistente.fechar)

ACAO = "abra a aba Navegador do painel, ou rode: uv run python scrape_cli.py desbloquear"

ANFITRIOES = {
    "mercadolivre.com.br", "www.mercadolivre.com.br",
    "produto.mercadolivre.com.br", "lista.mercadolivre.com.br",
}

@asynccontextmanager
async def _ciclo(app: FastAPI):
    yield
    # Sem isso o Chromium fica orfao: a thread e daemon e morre com o processo,
    # mas o navegador e processo FILHO e nao cai junto.
    persistente.fechar()


app = FastAPI(
    title="Scraper Mercado Livre (local)",
    version="1.1.0",
    description="Raspa produtos do Mercado Livre usando uma sessao de navegador ja logada.",
    lifespan=_ciclo,
)


class Produto(BaseModel):
    url: str
    titulo: str | None
    preco: str | None
    marca: str | None
    imagens: list[str]
    imagens_baixadas: int | None = None


class PedidoUrls(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=50)
    imagens: bool = False


class PedidoAbrir(BaseModel):
    destino: Literal["login", "desbloquear"] = "desbloquear"


class Acao(BaseModel):
    tipo: Literal["clique", "texto", "tecla", "rolar", "voltar", "recarregar"]
    x: float | None = Field(None, ge=0, le=4000)
    y: float | None = Field(None, ge=0, le=4000)
    texto: str | None = Field(None, max_length=500)
    tecla: str | None = Field(None, max_length=40)
    dy: int | None = Field(None, ge=-3000, le=3000)


def _valida(url: str) -> str:
    p = urlparse(url)
    if p.scheme != "https" or p.hostname not in ANFITRIOES:
        raise HTTPException(400, f"URL precisa ser https de {sorted(ANFITRIOES)}")
    return url


@contextmanager
def _usando_navegador():
    # Responde na hora em vez de esperar o lock: a sessao interativa pode ficar
    # aberta por minutos, e quem chama (o painel) desiste antes disso.
    if sessao.ativa():
        raise HTTPException(423, {"erro": "o navegador esta aberto para login ou desbloqueio",
                                  "acao": "conclua ou feche na aba Navegador do painel"})
    with _navegador:
        yield


def _raspa(urls: list[str], imagens: bool) -> list[Produto]:
    with _usando_navegador():
        paginas = baixar(urls)
    out = []
    for u, html in paginas.items():
        if not html:
            motivo = "pagina nao carregou (bloqueio ou timeout)"
            raise HTTPException(503, {"erro": motivo, "url": u, "acao": ACAO})
        d = parse(html) | {"url": u}
        if not d["titulo"]:
            # a pagina carregou mas nao e um produto (URL inexistente, removido, redirecionado)
            raise HTTPException(404, {"erro": "a pagina nao tem produto", "url": u,
                                      "dica": "confira o ID; anuncio removido tambem cai aqui"})
        if imagens and d["imagens"]:
            d["imagens_baixadas"] = baixar_imagens(d)
        out.append(Produto(**d))
    return out


@app.get("/health", summary="A API esta de pe (nao toca no navegador)")
def health():
    return {"ok": True}


@app.get("/status", summary="A sessao do Mercado Livre ainda passa?")
def status():
    if sessao.ativa():
        return {"sessao": "em_uso", "acao": "conclua ou feche na aba Navegador do painel"}
    with _usando_navegador():
        html = baixar([TESTE_URL])[TESTE_URL]
    if not html:
        return {"sessao": "bloqueada", "acao": ACAO}
    return {"sessao": "valida"}


@app.get("/produto", response_model=Produto, summary="Raspa um produto pela URL")
def produto(url: str = Query(..., description="URL do produto no mercadolivre.com.br"),
            imagens: bool = Query(False, description="Baixar as fotos para saida/imagens/")):
    return _raspa([_valida(url)], imagens)[0]


@app.post("/produtos", response_model=list[Produto], summary="Raspa varios produtos")
def produtos(p: PedidoUrls):
    return _raspa([_valida(u) for u in p.urls], p.imagens)


@app.get("/busca", response_model=list[Produto], summary="Busca por termo e raspa os resultados")
def busca(q: str = Query(..., min_length=2, description="Termo de busca"),
          paginas: int = Query(1, ge=1, le=5),
          maximo: int = Query(10, ge=1, le=50, description="Teto de produtos a raspar"),
          imagens: bool = False):
    import re
    base = "https://lista.mercadolivre.com.br/" + re.sub(r"\s+", "-", q.strip())
    alvos = [base if n == 1 else f"{base}_Desde_{(n - 1) * 50 + 1}" for n in range(1, paginas + 1)]
    with _usando_navegador():
        paginas_html = baixar(alvos)
    urls = []
    for html in paginas_html.values():
        urls += links_de_busca(html)
    urls = list(dict.fromkeys(urls))[:maximo]
    if not urls:
        raise HTTPException(503, {"erro": "a listagem nao devolveu produtos (provavel captcha)",
                                  "acao": ACAO})
    return _raspa(urls, imagens)


@app.get("/posicao", summary="Posicao do anuncio numa busca, com precos e vendas dos vizinhos")
def posicao_do_item(
    item: str = Query(..., pattern=r"^MLB\d+$", description="ID do anuncio, ex.: MLB123456"),
    q: str = Query(..., min_length=2, description="Termo de busca"),
    paginas: int = Query(1, ge=1, le=3, description="Paginas de listagem a ler"),
):
    """Le so a pagina de listagem (~3 s), nao raspa produto a produto.

    A posicao vem do campo que o proprio Mercado Livre declara no JSON da pagina.
    Varia por termo, regiao e personalizacao da sessao: serve para acompanhar a
    tendencia do seu anuncio, nao como numero oficial.
    """
    with _usando_navegador():
        r = posicao(item, q, paginas)
    if not r["paginas_lidas"]:
        # lentidao nao e bloqueio: mandar resolver captcha quando a pagina so demorou
        # confundia (e o painel marcava a sessao como bloqueada)
        if any(f.startswith("bloqueio") for f in r["falhas"]):
            raise HTTPException(503, {"erro": "o Mercado Livre bloqueou a listagem (" + ", ".join(r["falhas"]) + ")",
                                      "termo": q, "acao": ACAO})
        raise HTTPException(504, {"erro": "o Mercado Livre nao carregou a listagem em 45 s; "
                                          "costuma ser o computador sobrecarregado. Tente de novo.",
                                  "termo": q})
    return r


# ---------------------------------------------------------------- navegador interativo
# Uma PESSOA resolve login, 2FA ou reCAPTCHA; o programa so repassa cliques e
# teclas e devolve a tela. Nunca exponha estas rotas fora do painel autenticado.

@contextmanager
def _traduz_erros():
    try:
        yield
    except Ocupado as e:
        raise HTTPException(409, {"erro": str(e)})
    except Fechado as e:
        raise HTTPException(409, {"erro": str(e), "estado": "fechado"})
    except ValueError as e:
        raise HTTPException(400, {"erro": str(e)})
    except Demorou:
        raise HTTPException(504, {"erro": "o navegador demorou para responder"})
    except HTTPException:
        raise
    except Exception as e:  # erro do Playwright (timeout de navegacao, aba fechada...)
        raise HTTPException(502, {"erro": f"o navegador recusou: {str(e).splitlines()[0][:200]}"})


@app.get("/navegador", summary="Estado da sessao interativa")
def navegador_estado():
    return sessao.info()


@app.post("/navegador/abrir", summary="Abre o Chromium para uma pessoa logar ou desbloquear")
def navegador_abrir(p: PedidoAbrir):
    with _traduz_erros():
        return sessao.abrir(p.destino)


@app.get("/navegador/tela", summary="Captura atual da aba ativa (JPEG)",
         response_class=Response, responses={200: {"content": {"image/jpeg": {}}}})
def navegador_tela():
    with _traduz_erros():
        jpg = sessao.tela()
    return Response(jpg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.post("/navegador/acao", summary="Repassa um clique, texto, tecla ou rolagem")
def navegador_acao(a: Acao):
    with _traduz_erros():
        sessao.acao(a.tipo, x=a.x, y=a.y, texto=a.texto, tecla=a.tecla, dy=a.dy)
    return {"ok": True}


@app.post("/navegador/concluir", summary="Mede se destravou; se sim, fecha o navegador")
def navegador_concluir():
    with _traduz_erros():
        return sessao.concluir()


@app.post("/navegador/fechar", summary="Fecha sem verificar")
def navegador_fechar():
    sessao.fechar()
    return sessao.info()
