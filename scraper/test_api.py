"""Checagem da API sem tocar a rede: valida os guardas de entrada e de saida."""
from fastapi.testclient import TestClient
import api

c = TestClient(api.app)
PROD = '<h1 class="ui-pdp-title">X</h1><meta itemprop="price" content="9.90">'
URL_OK = "https://www.mercadolivre.com.br/x/p/MLB1"


def _finge(html):
    api.baixar = lambda urls: {u: html for u in urls}


def test():
    assert c.get("/health").json() == {"ok": True}

    # guarda de entrada: so https e so dominios do Mercado Livre
    for ruim in ["https://evil.example.com/x", "http://www.mercadolivre.com.br/x",
                 "file:///etc/passwd"]:
        assert c.get("/produto", params={"url": ruim}).status_code == 400, ruim

    # guarda de saida: pagina sem produto nao pode virar 200 com nulos
    _finge("<html><body>pagina de erro</body></html>")
    assert c.get("/produto", params={"url": URL_OK}).status_code == 404

    # pagina que nao carregou -> 503 com a acao de correcao
    _finge("")
    r = c.get("/produto", params={"url": URL_OK})
    assert r.status_code == 503 and "desbloquear" in str(r.json())

    # caminho feliz
    _finge(PROD)
    r = c.get("/produto", params={"url": URL_OK})
    assert r.status_code == 200 and r.json()["titulo"] == "X" and r.json()["preco"] == "9.90"

    # teto do lote
    assert c.post("/produtos", json={"urls": [URL_OK] * 51}).status_code == 422

    # listagem que nao carregou: lentidao (504, tente de novo) nao e bloqueio (503, captcha)
    real = api.posicao
    try:
        api.posicao = lambda item, q, p: {"paginas_lidas": 0, "falhas": ["lentidao"]}
        r = c.get("/posicao", params={"item": "MLB1", "q": "xx"})
        assert r.status_code == 504 and "Navegador" not in str(r.json()), r.json()
        api.posicao = lambda item, q, p: {"paginas_lidas": 0, "falhas": ["bloqueio: reCAPTCHA"]}
        r = c.get("/posicao", params={"item": "MLB1", "q": "xx"})
        assert r.status_code == 503 and "desbloquear" in str(r.json()), r.json()
    finally:
        api.posicao = real

    # navegador interativo fechado: acoes recusam com 409, nada fica pendurado
    assert c.get("/navegador").json()["estado"] == "fechado"
    assert c.post("/navegador/acao", json={"tipo": "voltar"}).status_code == 409
    assert c.get("/navegador/tela").status_code == 409
    assert c.post("/navegador/concluir").status_code == 409
    assert c.post("/navegador/fechar").status_code == 200
    assert c.post("/navegador/abrir", json={"destino": "file:///etc"}).status_code == 422
    # entrada malformada barra antes de chegar ao navegador
    assert c.post("/navegador/acao", json={"tipo": "executar"}).status_code == 422
    assert c.post("/navegador/acao", json={"tipo": "texto", "texto": "x" * 501}).status_code == 422
    for ruim in ["Enter; rm -rf", "a b", "", "Control+Alt+Shift+Meta+x"]:
        assert c.post("/navegador/acao", json={"tipo": "tecla", "tecla": ruim}).status_code in (400, 409), ruim

    # sessao aberta: raspagem responde 423 na hora em vez de esperar o lock
    api.sessao.estado = "aberto"
    try:
        _finge(PROD)
        r = c.get("/produto", params={"url": URL_OK})
        assert r.status_code == 423 and "Navegador" in str(r.json())
        assert c.get("/status").json()["sessao"] == "em_uso"
        assert c.get("/posicao", params={"item": "MLB1", "q": "xx"}).status_code == 423
        assert c.post("/navegador/abrir", json={"destino": "login"}).status_code == 409
        assert c.post("/navegador/acao", json={"tipo": "tecla", "tecla": "Enter; rm"}).status_code == 400
    finally:
        api.sessao.estado = "fechado"
    print("test_api OK")


if __name__ == "__main__":
    test()
