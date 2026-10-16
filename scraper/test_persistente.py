"""Ciclo de vida do contexto persistente, sem abrir Chromium de verdade.

O que quebra se a logica estiver errada: reabrir o navegador a cada chamada
(perde o ganho), usar o contexto de outra thread (Playwright sync estoura) ou
nao soltar o perfil quando a sessao interativa pede.

O playwright entra por sys.modules, entao este teste roda sem ele instalado.
"""
import sys
import threading
import types

import pytest

import scrape_cli
from persistente import Persistente


class CtxFalso:
    """Faz as vezes do contexto do Playwright, contando aberturas e fechamentos."""

    def __init__(self, conta):
        self.conta = conta
        self.pages = []
        conta["abriu"] += 1

    def new_page(self):
        return "pagina"

    def close(self):
        self.conta["fechou"] += 1


@pytest.fixture
def conta(monkeypatch):
    """Troca playwright e carregamento por dubles. Devolve o contador."""
    reg = {"abriu": 0, "fechou": 0, "threads": set()}

    class PlaywrightFalso:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    # persistente/navegador fazem `from playwright.sync_api import sync_playwright`
    # DENTRO da funcao: interceptar em sys.modules dispensa instalar o pacote.
    pacote = types.ModuleType("playwright")
    sub = types.ModuleType("playwright.sync_api")
    sub.sync_playwright = lambda: PlaywrightFalso()
    pacote.sync_api = sub
    monkeypatch.setitem(sys.modules, "playwright", pacote)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sub)

    monkeypatch.setattr(scrape_cli, "_contexto",
                        lambda p, **kw: CtxFalso(reg))

    def carregar(pg, urls, falhas=None):
        reg["threads"].add(threading.current_thread().name)
        return {u: f"<html>{u}</html>" for u in urls}

    monkeypatch.setattr(scrape_cli, "_carregar", carregar)
    return reg


def test_reaproveita_o_mesmo_navegador(conta):
    p = Persistente()
    try:
        assert p.baixar(["a"]) == {"a": "<html>a</html>"}
        p.baixar(["b"])
        p.baixar(["c"])
        assert conta["abriu"] == 1, "abriu o Chromium mais de uma vez"
        assert conta["fechou"] == 0
    finally:
        p.fechar()


def test_fechar_devolve_o_perfil(conta):
    p = Persistente()
    p.baixar(["a"])
    assert p.ativo()
    p.fechar()
    assert not p.ativo(), "fechar() voltou antes de a thread morrer"
    assert conta["fechou"] == 1, "nao fechou o contexto: o perfil segue preso"


def test_fechar_sem_ter_aberto_nao_estoura(conta):
    Persistente().fechar()


def test_reabre_depois_de_fechar(conta):
    p = Persistente()
    try:
        p.baixar(["a"])
        p.fechar()
        assert p.baixar(["b"]) == {"b": "<html>b</html>"}
        assert conta["abriu"] == 2
    finally:
        p.fechar()


def test_sempre_a_mesma_thread_dona(conta):
    """Playwright sync e preso a thread que criou o contexto, e o FastAPI atende
    em threads diferentes: o trabalho TEM de cair sempre na thread dona."""
    p = Persistente()
    try:
        erros = []

        def chamar(i):
            try:
                assert p.baixar([f"u{i}"]) == {f"u{i}": f"<html>u{i}</html>"}
            except Exception as e:  # pragma: no cover
                erros.append(e)

        ts = [threading.Thread(target=chamar, args=(i,)) for i in range(6)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(timeout=10)

        assert not erros, erros
        assert conta["abriu"] == 1, "cada thread abriu o seu navegador"
        assert len(conta["threads"]) == 1, f"rodou em varias threads: {conta['threads']}"
    finally:
        p.fechar()


def test_baixar_roteia_pelo_persistente(conta):
    """posicao(), busca() e status() chamam scrape_cli.baixar(): e por ali que o
    contexto persistente tem de entrar, senao o ganho vale so para quem usa a classe."""
    p = Persistente()
    try:
        scrape_cli.usar_baixador(p.baixar)
        assert scrape_cli.baixar(["x"]) == {"x": "<html>x</html>"}
        assert conta["abriu"] == 1
    finally:
        scrape_cli.usar_baixador(None)
        p.fechar()


def test_sessao_interativa_toma_o_perfil(conta):
    """Sessao.abrir() precisa fechar o persistente ANTES de lancar o Chromium dela:
    o perfil .sessao_ml/ so aceita um navegador por vez."""
    from navegador import Sessao

    p = Persistente()
    p.baixar(["a"])
    assert conta["fechou"] == 0

    s = Sessao(threading.Lock(), liberar=p.fechar)
    try:
        s.abrir("login")
        assert conta["fechou"] == 1, "a sessao interativa subiu com o perfil ainda preso"
    finally:
        p.fechar()
