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
