"""Contexto headless que sobrevive entre chamadas.

Abrir um Chromium por requisicao cobra duas vezes: o startup (~1-2 s) e o
proof-of-work em JS que o Mercado Livre serve antes da listagem. Aqui o
navegador fica vivo entre as chamadas, entao uma rajada de raspagens paga isso
uma vez so.

Playwright sync e preso a UMA thread: quem cria o contexto tem de ser quem o
usa. O FastAPI atende requisicoes em threads diferentes, entao guardar o
contexto num global e usa-lo na chamada seguinte estoura. O jeito e uma thread
dona com fila de pedidos — o mesmo padrao de navegador.py.

O perfil `.sessao_ml/` so aceita UM Chromium por vez. Enquanto este contexto
esta aberto, a sessao interativa nao consegue subir; por isso Sessao.abrir()
chama fechar() aqui antes de lancar a dela (ver navegador.py).
"""
from __future__ import annotations

import queue
import threading
from concurrent.futures import Future

import scrape_cli

OCIOSO_S = 300    # sem uso por isso, fecha: Chromium parado come 300+ MB
ESPERA_S = 180    # teto por pedido; baixar() ja tem 45 s por URL


class Persistente:
    def __init__(self) -> None:
        self._mx = threading.Lock()
        self._fila: queue.Queue | None = None
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------ chamavel de qualquer thread

    def baixar(self, urls: list[str], falhas: dict | None = None) -> dict[str, str]:
        f: Future = Future()
        with self._mx:
            if self._thread is None or not self._thread.is_alive():
                self._subir()
            self._fila.put(("baixar", urls, falhas, f))
        return f.result(timeout=ESPERA_S)

    def fechar(self) -> None:
        """Fecha o Chromium e devolve o perfil. Bloqueia ate ter fechado mesmo."""
        with self._mx:
            fila, thread = self._fila, self._thread
            self._fila = self._thread = None
        if thread is None:
            return
        fila.put(("parar", None, None, None))
        thread.join(timeout=30)

    def ativo(self) -> bool:
        with self._mx:
            return self._thread is not None and self._thread.is_alive()

    # ------------------------------------------------------ interno

    def _subir(self) -> None:
        """Sobe a thread dona. Chamado com _mx tomado."""
        self._fila = queue.Queue()
        self._thread = threading.Thread(target=self._rodar, args=(self._fila,),
                                        name="scraper-persistente", daemon=True)
        self._thread.start()

    def _aposentar(self, fila: queue.Queue) -> bool:
        """Deu o tempo de ocioso: posso morrer? Fecha a janela de corrida com baixar(),
        que enfileira com _mx tomado — se algo entrou, a fila nao esta vazia."""
        with self._mx:
            if not fila.empty():
                return False
            if self._fila is fila:
                self._fila = self._thread = None
            return True

    def _rodar(self, fila: queue.Queue) -> None:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            ctx = scrape_cli._contexto(p, headless=True)
            try:
                pg = ctx.pages[0] if ctx.pages else ctx.new_page()
                while True:
                    try:
                        acao, urls, falhas, f = fila.get(timeout=OCIOSO_S)
                    except queue.Empty:
                        if self._aposentar(fila):
                            return
                        continue
                    if acao == "parar":
                        return
                    try:
                        f.set_result(scrape_cli._carregar(pg, urls, falhas))
                    except Exception as e:
                        # _carregar trata falha de URL sozinho; chegar aqui e contexto
                        # quebrado (aba fechada, Chromium morto). Morre e a proxima
                        # chamada sobe outro.
                        f.set_exception(e)
                        self._aposentar(fila)
                        return
            finally:
                # ponytail: so fecha o contexto. Se sobrar Chromium orfao na pratica,
                # o proximo passo e gravar o pid num arquivo.
                try:
                    ctx.close()
                except Exception:
                    pass
