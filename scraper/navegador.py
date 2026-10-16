"""Sessao interativa: abre o Chromium do scraper para uma PESSOA logar, passar
pelo codigo de verificacao (2FA) ou resolver o reCAPTCHA pelo painel.

O programa nao digita senha nem resolve captcha. Ele so repassa os cliques e as
teclas de quem esta no painel e devolve a tela. Roda SEM janela: a tela so existe
dentro do painel. channel="chromium" e o Chromium completo no modo headless novo (nao o
headless shell), o mais parecido com o navegador de verdade — medido em 16/10/2026: o
login do ML abre normal assim, igual ao com janela.

O Playwright sync amarra o navegador a thread que o abriu. Por isso existe uma
thread dona do navegador que consome uma fila de comandos; as rotas HTTP so
enfileiram e esperam o resultado.
"""
import queue
import re
import threading
import time
from concurrent.futures import Future
from urllib.parse import urlparse

from scrape_cli import LOGIN_URL, PRODUTO_TESTE, TESTE_URL, _bloqueado, _contexto

DESTINOS = {
    "login": LOGIN_URL,
    "desbloquear": TESTE_URL,
}
INATIVIDADE_S = 10 * 60   # sem clique/tecla nesse tempo, fecha e devolve o perfil
DURACAO_MAX_S = 30 * 60   # teto absoluto, mesmo com uso
ESPERA_S = 60             # quanto uma rota espera a thread do navegador responder
# nomes de tecla do Playwright ("Enter", "ArrowLeft", "Meta+a"); nada de texto livre aqui
TECLA = re.compile(r"^((Control|Alt|Shift|Meta)\+){0,3}([A-Za-z0-9]|[A-Z][A-Za-z0-9]{1,15})$")


class Ocupado(Exception):
    """Ja existe sessao aberta, ou o scraper esta raspando agora."""


class Fechado(Exception):
    """Nao ha sessao aberta (ou ela fechou enquanto o pedido esperava)."""


def _pagina_ativa(ctx):
    # popups (ex.: "entrar com Google") viram a ultima aba; ao fechar, volta a anterior
    abertas = [p for p in ctx.pages if not p.is_closed()]
    return abertas[-1] if abertas else ctx.new_page()


def _verificar(pg):
    """Mesma medicao do `desbloquear` do CLI: listagem e produto carregam de verdade?"""
    motivos = {}
    for nome, u in (("listagem", TESTE_URL), ("produto", PRODUTO_TESTE)):
        pg.goto(u, wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(2000)
        motivos[nome] = _bloqueado(pg.url, pg.content())
    return motivos


class Sessao:
    def __init__(self, lock_navegador: threading.Lock, liberar=None):
        self._perfil = lock_navegador  # o mesmo lock das rotas de raspagem
        # Chamado com o perfil na mao, antes de lancar o Chromium interativo: o
        # contexto persistente tem de soltar `.sessao_ml/` (so cabe um por vez).
        self._liberar = liberar
        self._mx = threading.Lock()
        self._fila: queue.Queue = queue.Queue()
        self.estado = "fechado"        # fechado | abrindo | aberto | verificando
        self.destino = None
        self.pagina = None             # host + caminho, sem query (pode ter token)
        self.titulo = None
        self.motivos = None            # ultima verificacao: {listagem, produto} -> motivo | None
        self.erro = None
        self._aberta_em = 0.0
        self._ultimo_uso = 0.0

    def ativa(self) -> bool:
        return self.estado != "fechado"

    def info(self) -> dict:
        restante = None
        if self.ativa():
            agora = time.monotonic()
            restante = int(max(0, min(INATIVIDADE_S - (agora - self._ultimo_uso),
                                      DURACAO_MAX_S - (agora - self._aberta_em))))
        return {"estado": self.estado, "destino": self.destino, "pagina": self.pagina,
                "titulo": self.titulo, "fecha_em_s": restante, "motivos": self.motivos,
                "erro": self.erro}

    # ------------------------------------------------------------ ciclo de vida

    def abrir(self, destino: str) -> dict:
        if destino not in DESTINOS:
            raise ValueError(f"destino precisa ser um de {sorted(DESTINOS)}")
        with self._mx:
            if self.ativa():
                raise Ocupado("o navegador ja esta aberto")
            if not self._perfil.acquire(timeout=5):
                raise Ocupado("o scraper esta raspando agora; tente de novo em instantes")
            # Com o lock na mao ninguem mais raspa: e aqui que da para tomar o perfil
            # de volta do contexto persistente sem corrida.
            if self._liberar is not None:
                self._liberar()
            self.estado, self.destino = "abrindo", destino
            self.pagina = self.titulo = self.motivos = self.erro = None
            self._fila = queue.Queue()
            self._aberta_em = self._ultimo_uso = time.monotonic()
        threading.Thread(target=self._rodar, args=(destino,), daemon=True,
                         name="navegador-interativo").start()
        return self.info()

    def _rodar(self, destino: str):
        from playwright.sync_api import sync_playwright
        try:
            with sync_playwright() as p:
                ctx = _contexto(p, headless=True, channel="chromium", accept_downloads=False)
                try:
                    pg = _pagina_ativa(ctx)
                    try:
                        # "commit" devolve assim que a navegacao comeca: a pessoa ja ve a
                        # pagina carregando, em vez de esperar tudo (a parede de captcha demora)
                        pg.goto(DESTINOS[destino], wait_until="commit", timeout=45000)
                    except Exception:
                        pass  # a tela aparece mesmo assim; a pessoa ve e recarrega
                    self._anota(pg)
                    self.estado = "aberto"
                    self._laco(ctx)
                finally:
                    ctx.close()
        except Exception as e:
            self.erro = f"o navegador falhou: {e}"
        finally:
            with self._mx:
                self.estado = "fechado"
                pendentes, self._fila = self._fila, queue.Queue()
            while not pendentes.empty():
                _, fut, _ = pendentes.get_nowait()
                fut.set_exception(Fechado("o navegador fechou"))
            self._perfil.release()

    def _laco(self, ctx):
        while True:
            agora = time.monotonic()
            if agora - self._ultimo_uso > INATIVIDADE_S:
                self.erro = "fechado por inatividade (10 min sem clique ou tecla)"
                return
            if agora - self._aberta_em > DURACAO_MAX_S:
                self.erro = "fechado pelo tempo maximo (30 min)"
                return
            try:
                cmd, fut, uso = self._fila.get(timeout=0.25)
            except queue.Empty:
                continue
            if cmd is None:
                fut.set_result(None)
                return
            if uso:
                self._ultimo_uso = time.monotonic()
            try:
                pg = _pagina_ativa(ctx)
                fut.set_result(cmd(pg))
                self._anota(_pagina_ativa(ctx))
            except Exception as e:
                fut.set_exception(e)

    def _anota(self, pg):
        try:
            u = urlparse(pg.url)
            self.pagina = (u.hostname or "") + u.path
            self.titulo = pg.title()[:120]
        except Exception:
            pass

    def _executar(self, cmd, uso: bool = True):
        fut: Future = Future()
        with self._mx:
            if not self.ativa():
                raise Fechado("o navegador nao esta aberto")
            self._fila.put((cmd, fut, uso))
        return fut.result(timeout=ESPERA_S)

    # ------------------------------------------------------------ comandos

    def tela(self) -> bytes:
        # olhar a tela nao conta como uso: aba do painel esquecida aberta nao segura o perfil
        return self._executar(lambda pg: pg.screenshot(
            type="jpeg", quality=55, scale="css", caret="initial", timeout=15000), uso=False)

    def acao(self, tipo: str, x=None, y=None, texto=None, tecla=None, dy=None) -> None:
        if tipo == "clique":
            if x is None or y is None:
                raise ValueError("clique precisa de x e y")

            def cmd(pg):
                pg.mouse.move(x, y, steps=6)
                pg.mouse.down()
                pg.mouse.up()
        elif tipo == "texto":
            if not texto:
                raise ValueError("texto vazio")
            cmd = lambda pg: pg.keyboard.type(texto, delay=25)  # noqa: E731
        elif tipo == "tecla":
            if not tecla or not TECLA.match(tecla):
                raise ValueError("tecla invalida")
            cmd = lambda pg: pg.keyboard.press(tecla)  # noqa: E731
        elif tipo == "rolar":
            if not dy:
                raise ValueError("rolar precisa de dy")
            cmd = lambda pg: pg.mouse.wheel(0, dy)  # noqa: E731
        elif tipo == "voltar":
            cmd = lambda pg: pg.go_back(wait_until="commit", timeout=20000)  # noqa: E731
        elif tipo == "recarregar":
            cmd = lambda pg: pg.reload(wait_until="commit", timeout=20000)  # noqa: E731
        else:
            raise ValueError(f"acao desconhecida: {tipo}")
        self._executar(cmd)

    def concluir(self) -> dict:
        """Mede se destravou. Liberado: fecha e devolve o perfil ao scraper.
        Ainda bloqueado: deixa aberto, na pagina do bloqueio, para a pessoa continuar."""
        with self._mx:
            if not self.ativa():
                raise Fechado("o navegador nao esta aberto")
            if self.estado != "aberto":
                raise Ocupado("o navegador ainda esta abrindo, ou ja esta verificando")
            self.estado = "verificando"
        try:
            motivos = self._executar(_verificar)
        finally:
            if self.estado == "verificando":
                self.estado = "aberto"
        self.motivos = motivos
        liberado = not any(motivos.values())
        if liberado:
            self.fechar()
        return {"liberado": liberado, "motivos": motivos}

    def fechar(self) -> None:
        try:
            self._executar(None)
        except Fechado:
            pass
