"""Scraper do Mercado Livre com sessao logada (voce loga, ele raspa).

    uv run python scrape_cli.py login                  # abre o navegador, VOCE loga
    uv run python scrape_cli.py desbloquear            # VOCE resolve o reCAPTCHA
    uv run python scrape_cli.py status                 # a sessao ainda vale?
    uv run python scrape_cli.py url <url> [<url> ...]  # raspa produtos
    uv run python scrape_cli.py busca "fone bluetooth" [--paginas 2] [--max 20]
    uv run python scrape_cli.py posicao MLB123 "cascata piscina"   # onde voce aparece
    uv run python scrape_cli.py --html pagina.html     # parse offline
    uv run python scrape_cli.py --self-check

A sessao fica em .sessao_ml/ (cookies = credencial: nao versionar, nao compartilhar).
"""
import sys, os, re, csv, json, pathlib, time
import requests
from bs4 import BeautifulSoup

RAIZ = pathlib.Path(__file__).parent
PERFIL = RAIZ / ".sessao_ml"
SAIDA = RAIZ / "saida"
TESTE_URL = "https://lista.mercadolivre.com.br/fone-de-ouvido"  # rota bloqueada p/ anonimo
# Login: o endereco antigo (mercadolivre.com.br/login) passou a dar 404 (medido em 19/09/2026).
# Este e o link "Entre" da pagina inicial do ML; depois de logar, volta para o .com.br.
LOGIN_URL = ("https://www.mercadolivre.com/jms/mlb/lgz/login?platform_id=ML"
             "&go=https%3A%2F%2Fwww.mercadolivre.com.br%2F&loginType=explicit")
UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
}


def _bloqueado(url: str, html: str):
    """Devolve o motivo do bloqueio, ou None se a pagina veio de verdade."""
    if "account-verification" in url:
        return "parede de login"
    if "suspicious-traffic" in html[:6000]:
        return "anti-bot (trafego suspeito)"
    # captcha so conta se a pagina tambem nao trouxe conteudo de produto/listagem
    if "recaptcha" in html.lower() and "ui-pdp-title" not in html and html.count("MLB") < 20:
        return "reCAPTCHA (pagina de Seguranca)"
    return None


# ---------------------------------------------------------------- sessao

def _contexto(p, headless: bool, **extra):
    PERFIL.mkdir(mode=0o700, exist_ok=True)
    return p.chromium.launch_persistent_context(
        str(PERFIL), headless=headless, locale="pt-BR",
        viewport={"width": 1440, "height": 900},
        user_agent=UA["User-Agent"],
        args=["--disable-blink-features=AutomationControlled"],
        **extra,
    )


def login():
    from playwright.sync_api import sync_playwright
    print("Abrindo o navegador. Faca login na SUA conta do Mercado Livre na janela.")
    print("Eu nao digito nem vejo sua senha — quem loga e voce.\n")
    with sync_playwright() as p:
        ctx = _contexto(p, headless=False)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.goto(LOGIN_URL, wait_until="domcontentloaded")
        input("Terminou o login? Volte aqui e aperte ENTER para salvar a sessao... ")
        pg.goto(TESTE_URL, wait_until="domcontentloaded")
        motivo = _bloqueado(pg.url, pg.content())
        ctx.close()
    print(f"Sessao salva, mas AINDA BLOQUEADO: {motivo}" if motivo
          else "Sessao salva em .sessao_ml/ — listagem acessivel.")
    return 1 if motivo else 0


PRODUTO_TESTE = "https://produto.mercadolivre.com.br/MLB-1837525408"


def desbloquear():
    """Abre a janela para VOCE resolver o reCAPTCHA, depois mede se destravou."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        ctx = _contexto(p, headless=False)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.goto(TESTE_URL, wait_until="domcontentloaded")
        print("Resolva o reCAPTCHA na janela. Eu nao resolvo captcha — quem resolve e voce.\n")
        input("Terminou? ENTER para eu medir... ")
        resultado = {}
        for nome, u in (("listagem", TESTE_URL), ("produto", PRODUTO_TESTE)):
            pg.goto(u, wait_until="domcontentloaded", timeout=45000)
            pg.wait_for_timeout(2000)
            resultado[nome] = _bloqueado(pg.url, pg.content())
        ctx.close()
    for nome, motivo in resultado.items():
        print(f"  {nome:9} -> {motivo or 'LIBERADO'}")
    return 0 if not any(resultado.values()) else 1


def _carregar(pg, urls: list[str], falhas: dict | None = None) -> dict[str, str]:
    """Carrega as URLs numa pagina JA aberta. Retorna {url: html}."""
    out = {}
    for u in urls:
        try:
            pg.goto(u, wait_until="domcontentloaded", timeout=45000)
            pg.wait_for_timeout(1200)
            html = pg.content()
            motivo = _bloqueado(pg.url, html)
            if motivo:
                raise RuntimeError(f"bloqueado: {motivo}")
            out[u] = html
        except Exception as e:
            out[u] = ""
            if falhas is not None:
                falhas[u] = (f"bloqueio: {str(e)[len('bloqueado: '):]}" if str(e).startswith("bloqueado:")
                             else "lentidao")
            print(f"  ! {u} -> {e}", file=sys.stderr)
    return out


# Quem carrega as paginas. None = abre um Chromium por chamada, que e o modo do
# CLI. A API instala aqui o contexto persistente (persistente.py), e assim TODO
# mundo que chama baixar() — status, busca, posicao — passa a reaproveita-lo.
_baixador = None


def usar_baixador(fn) -> None:
    """Instala o carregador persistente. `None` volta ao Chromium por chamada."""
    global _baixador
    _baixador = fn


def baixar(urls: list[str], falhas: dict | None = None) -> dict[str, str]:
    """Carrega cada URL no navegador logado. Retorna {url: html}.

    Se `falhas` vier, anota por que cada URL falhou: "bloqueio: ..." ou "lentidao".
    Sao coisas diferentes para quem ve: bloqueio pede resolver o captcha; lentidao
    (pagina que nao carrega em 45 s, medido com o Mac em load 74) pede so tentar de novo.
    """
    if _baixador is not None:
        return _baixador(urls, falhas)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        ctx = _contexto(p, headless=True)
        try:
            return _carregar(ctx.pages[0] if ctx.pages else ctx.new_page(), urls, falhas)
        finally:
            ctx.close()


def status():
    html = baixar([TESTE_URL])[TESTE_URL]
    ok = bool(html)
    print("Sessao VALIDA — da pra raspar." if ok else "Sessao INVALIDA — rode: login")
    return 0 if ok else 1


# ---------------------------------------------------------------- parse

def melhor_imagem(url: str) -> str:
    """Normaliza a URL da foto para a maior resolucao (-F). Medido: -F > -O > -W > -V > -R."""
    url = re.sub(r"(//http2\.mlstatic\.com/)D_Q_NP_", r"\1D_NQ_NP_", url)
    return re.sub(r"-[A-Z]\.(webp|jpg|jpeg|png)$", r"-F.\1", url, flags=re.I)


def eh_foto_produto(url: str) -> bool:
    """Descarta icones da interface (play, setas) que moram na mesma galeria."""
    return "frontend-assets" not in url and not url.lower().endswith(".svg")


def parse(html: str) -> dict:
    s = BeautifulSoup(html, "html.parser")
    title = s.select_one("h1.ui-pdp-title") or s.select_one("h1")
    meta_price = s.select_one('meta[itemprop="price"]')
    frac = s.select_one(".andes-money-amount__fraction")
    brand = None
    for row in s.select("tr.andes-table__row"):
        head = row.select_one("th, .andes-table__header")
        val = row.select_one("td, .andes-table__column--value")
        if head and val and "marca" in head.get_text(strip=True).lower():
            brand = val.get_text(strip=True)
            break

    imgs, seen = [], set()
    for img in s.select("figure.ui-pdp-gallery__figure img, .ui-pdp-gallery__wrapper img"):
        src = img.get("src") or img.get("data-src") or img.get("data-zoom")
        if not src or not src.startswith("http") or not eh_foto_produto(src):
            continue
        src = melhor_imagem(src)
        if src not in seen:
            seen.add(src)
            imgs.append(src)

    return {
        "titulo": title.get_text(strip=True) if title else None,
        "preco": (meta_price and meta_price.get("content")) or (frac and frac.get_text(strip=True)),
        "marca": brand,
        "imagens": imgs,
    }


def links_de_busca(html: str) -> list[str]:
    achados = re.findall(
        # anuncio de catalogo (/p/MLB), anuncio proprio do vendedor (/MLB-) e o dominio antigo
        r'https://(?:www\.mercadolivre\.com\.br/[^"\s#?]*?/(?:p/MLB\d+|MLB-\d+)'
        r'|produto\.mercadolivre\.com\.br/MLB-\d+[^"\s#?]*)',
        html)
    vistos, out = set(), []
    for l in achados:
        chave = re.sub(r"[?#].*", "", l)
        if chave not in vistos:
            vistos.add(chave)
            out.append(chave)
    return out


# ---------------------------------------------------------------- posicao

def _objetos_item(html: str) -> list[dict]:
    """Cada objeto {"item_id": ...} INTEIRO do JSON embutido na pagina.

    Ler o objeto inteiro, e nao uma janela de texto depois do item_id: os objetos
    tem ~700 caracteres e uma janela maior invadia o item seguinte, trazendo
    posicao e preco do vizinho (medido: 11 de 59 com preco, e posicoes puladas).
    """
    out = []
    for m in re.finditer(r'\{(\\"|")item_id\1:', html):
        prof = 0
        for j in range(m.start(), min(len(html), m.start() + 20000)):
            c = html[j]
            if c == '{':
                prof += 1
            elif c == '}':
                prof -= 1
                if prof == 0:
                    trecho = html[m.start():j + 1]
                    try:
                        if m.group(1) != '"':      # a pagina as vezes embute o JSON escapado
                            trecho = json.loads('"' + trecho + '"')
                        out.append(json.loads(trecho))
                    except ValueError:
                        pass
                    break
    return out


def _numero(el) -> float | None:
    fr = el and el.select_one('.andes-money-amount__fraction')
    if not fr:
        return None
    ct = el.select_one('.andes-money-amount__cents')
    return float(fr.get_text(strip=True).replace('.', '') + '.' + (ct.get_text(strip=True) if ct else '0'))


def _dados_dos_cards(html: str) -> dict[str, dict]:
    """O que o comprador ve em cada card: preco, titulo, foto e vendedor.

    Vem do HTML porque a API do ML devolve 403 para anuncio de outro vendedor
    (medido com o token do vendedor: /items?ids= so responde os proprios).
    O preco do card vence o `price` do JSON: nos pagos o JSON traz o total
    parcelado (medido: card 224,82 a vista vs JSON 236,65 = 8x 29,58).
    Medido numa busca: 60/60 com titulo e foto, 52/60 com vendedor.
    """
    s = BeautifulSoup(html, 'lxml')
    dados = {}
    for card in s.select('div.poly-card'):
        a = card.select_one('a.poly-component__title')
        href = a.get('href', '') if a else ''
        # em ordem de prioridade: em link de catalogo o primeiro MLB da URL e o
        # /p/MLB... do PRODUTO, nao do anuncio
        for padrao in (r'wid=(MLB\d+)', r'item_id(?:%3A|:)(MLB\d+)', r'/(MLB)-(\d+)'):
            m = re.search(padrao, href)
            if m:
                break
        if not m or ''.join(m.groups()) in dados:
            continue
        img = card.select_one('img.poly-component__picture')
        src = (img.get('src') or img.get('data-src') or '') if img else ''
        vend = card.select_one('.poly-component__seller')
        dados[''.join(m.groups())] = {
            'preco': _numero(card.select_one('.poly-price__current .andes-money-amount')),
            'titulo': ' '.join(a.get_text(' ').split())[:160] or None,
            'imagem': src if src.startswith('https://') else None,
            'vendedor': (re.sub(r'^Por\s+', '', vend.get_text(' ', strip=True))[:80] or None) if vend else None,
        }
    return dados


def resultados_da_busca(html: str) -> list[dict]:
    """Anuncios da listagem, na ordem, com o que o proprio ML declara de cada um.

    A pagina embute um JSON de tracking com position, price, sold_quantity e type.
    Ler dele e mais completo E mais barato que raspar produto a produto: os
    <a href> so trazem os anuncios de catalogo (medido: 27 de 65 numa busca).

    `position` do ML comeca em 0 e conta banners (ex.: CART_INTERVENTION) como
    casas da grade. Aqui ficam so anuncios; a posicao final e calculada em `posicao()`.
    Um mesmo anuncio pode aparecer duas vezes (pago e organico): o comprador ve os
    dois cards, entao os dois contam.
    """
    casas = {}
    for o in _objetos_item(html):
        if re.fullmatch(r'MLB\d+', str(o.get('item_id'))) and isinstance(o.get('position'), int):
            casas.setdefault(o['position'], o)
    cards = _dados_dos_cards(html) if casas else {}
    if casas and not cards:
        # Achou anuncios no JSON e nenhum card: o ML renomeou as classes.
        # Sem este aviso a quebra e muda — ver o comentario em posicao().
        print(f"  ! {len(casas)} anuncios no JSON e nenhum card casou: o HTML do ML mudou",
              file=sys.stderr)
    out = []
    for pos in sorted(casas):
        o = casas[pos]
        c = cards.get(o['item_id'], {})
        preco = c.get('preco') if c.get('preco') is not None else o.get('price')
        base = o.get('price_base')
        out.append({
            'item_id': o['item_id'],
            'casa_ml': pos,                      # como o ML numera: 0 = primeira casa
            'preco': preco,
            'preco_original': base if base and preco and base > preco else None,
            'vendidos': o.get('sold_quantity'),
            'tipo': o.get('type'),
            'frete_gratis': o.get('has_free_shipping'),
            'produto': o.get('product_id'),
            'titulo': c.get('titulo'),
            'imagem': c.get('imagem'),
            'vendedor': c.get('vendedor'),
        })
    return out


def posicao(item_id: str, termo: str, paginas: int = 1) -> dict:
    """Onde o anuncio aparece na busca por `termo`, e quem esta em volta.

    A posicao e contada a partir de 1, so entre anuncios, na ordem da grade e
    somando as paginas lidas: e o numero do card que o comprador ve.
    """
    base = 'https://lista.mercadolivre.com.br/' + re.sub(r'\s+', '-', termo.strip())
    urls = [base] + [f'{base}_Desde_{n * 50 + 1}' for n in range(1, paginas)]
    falhas = {}
    paginas_html = baixar(urls, falhas)

    ordem = []
    for u in urls:
        for r in resultados_da_busca(paginas_html.get(u) or ''):
            r['posicao'] = len(ordem) + 1
            ordem.append(r)

    # Nenhum titulo em NADA que veio = os cards nao casaram. Isso nao derruba a
    # medicao (posicao, vendidos e tipo saem do JSON), mas envenena o preco: o
    # JSON traz o TOTAL parcelado, nao o a vista (medido: 236,65 contra 224,82).
    # Erro silencioso e pior que erro: a posicao sai certa e o preco sai errado
    # com cara de certo. Vai junto das falhas de carregamento, que o painel ja mostra.
    if ordem and not any(r.get('titulo') for r in ordem):
        falhas['cards'] = 'html do ML mudou: os cards nao casaram, o preco pode estar errado'

    eu = next((r for r in ordem if r['item_id'] == item_id), None)
    patrocinados = [r for r in ordem if r.get('tipo') and r['tipo'] != 'ORGANIC']
    vizinhos = []
    if eu:
        i = ordem.index(eu)
        vizinhos = ordem[max(0, i - 3):i + 4]

    return {
        'item_id': item_id,
        'termo': termo,
        'posicao': eu['posicao'] if eu else None,
        'encontrado': eu is not None,
        'tipo': eu.get('tipo') if eu else None,
        'preco': eu.get('preco') if eu else None,
        'total_na_pagina': len(ordem),
        'patrocinados': len(patrocinados),
        'patrocinados_acima': len([r for r in patrocinados if eu and r['posicao'] < eu['posicao']]),
        'vizinhos': vizinhos,
        'paginas_lidas': sum(1 for u in urls if paginas_html.get(u)),
        'falhas': sorted(set(falhas.values())),
        # lista compacta de tudo que apareceu: o painel cruza com os anuncios do
        # vendedor (o JSON da listagem nao diz de quem e cada anuncio)
        'resultados': [{k: r.get(k) for k in ('item_id', 'posicao', 'tipo', 'preco', 'preco_original', 'vendidos',
                                          'frete_gratis', 'titulo', 'imagem', 'vendedor')} for r in ordem],
    }


# ---------------------------------------------------------------- saida

def _slug(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (t or "sem_titulo").lower())[:60].strip("_")


def baixar_imagens(item: dict) -> int:
    pasta = SAIDA / "imagens" / _slug(item["titulo"])
    pasta.mkdir(parents=True, exist_ok=True)
    n = 0
    for i, url in enumerate(item["imagens"]):
        ext = pathlib.Path(re.sub(r"[?#].*", "", url)).suffix
        if ext.lower() not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            ext = ".jpg"
        try:
            r = requests.get(url, headers=UA, timeout=25)
            r.raise_for_status()
            (pasta / f"{i:02d}{ext}").write_bytes(r.content)
            n += 1
        except Exception as e:
            print(f"  ! imagem {url}: {e}", file=sys.stderr)
    return n


def gravar(itens: list[dict]):
    SAIDA.mkdir(exist_ok=True)
    (SAIDA / "dados.json").write_text(json.dumps(itens, indent=2, ensure_ascii=False))
    with (SAIDA / "dados.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["url", "titulo", "preco", "marca", "qtd_imagens", "imagens"])
        for i in itens:
            w.writerow([i.get("url"), i["titulo"], i["preco"], i["marca"],
                        len(i["imagens"]), " | ".join(i["imagens"])])
    print(f"\n{len(itens)} produto(s) -> {SAIDA}/dados.json e dados.csv")


def raspar(urls: list[str], com_imagens=True):
    print(f"Raspando {len(urls)} pagina(s) com a sessao logada...")
    itens = []
    for u, html in baixar(urls).items():
        if not html:
            continue
        d = parse(html) | {"url": u}
        if com_imagens and d["imagens"]:
            d["imagens_baixadas"] = baixar_imagens(d)
        itens.append(d)
        print(f"  OK {d['titulo']!r} | R$ {d['preco']} | {len(d['imagens'])} imgs")
    gravar(itens)
    return 0 if itens else 1


def buscar(termo: str, paginas=1, maximo=20):
    base = "https://lista.mercadolivre.com.br/" + re.sub(r"\s+", "-", termo.strip())
    alvos = [base if n == 1 else f"{base}_Desde_{(n - 1) * 50 + 1}" for n in range(1, paginas + 1)]
    urls = []
    for html in baixar(alvos).values():
        urls += links_de_busca(html)
    urls = list(dict.fromkeys(urls))[:maximo]
    print(f"Busca {termo!r}: {len(urls)} produto(s) encontrado(s).")
    return raspar(urls) if urls else 1


# ---------------------------------------------------------------- check

def self_check():
    html = """<html><body>
      <h1 class="ui-pdp-title">Fone XYZ</h1>
      <meta itemprop="price" content="199.90">
      <tr class="andes-table__row"><th>Marca</th><td class="andes-table__column--value">Acme</td></tr>
      <figure class="ui-pdp-gallery__figure"><img src="https://x/a.jpg"></figure>
      <figure class="ui-pdp-gallery__figure"><img data-src="https://x/b.jpg"></figure>
      <figure class="ui-pdp-gallery__figure"><img src="https://x/a.jpg"></figure>
    </body></html>"""
    d = parse(html)
    assert d["titulo"] == "Fone XYZ", d
    assert d["preco"] == "199.90", d
    assert d["marca"] == "Acme", d
    assert d["imagens"] == ["https://x/a.jpg", "https://x/b.jpg"], d
    assert parse("<html><body></body></html>")["imagens"] == []

    # miniatura e original do MESMO id colapsam em uma unica URL em -F
    base = "https://http2.mlstatic.com/"
    galeria = "".join(f'<figure class="ui-pdp-gallery__figure"><img src="{u}"></figure>' for u in [
        base + "D_Q_NP_895263-MLA995_122025-R.webp",     # miniatura 70x70
        base + "D_NQ_NP_895263-MLA995_122025-O.webp",    # mesma foto, 500x500
        base + "frontend-assets/vpp/picture-play.svg",   # icone da interface
    ])
    assert parse(galeria)["imagens"] == [base + "D_NQ_NP_895263-MLA995_122025-F.webp"], parse(galeria)
    assert not eh_foto_produto(base + "frontend-assets/x.svg")
    assert eh_foto_produto(base + "D_NQ_NP_1-F.jpg")

    busca = '<a href="https://www.mercadolivre.com.br/fone-x/p/MLB123?ref=1">a</a>' \
            '<a href="https://produto.mercadolivre.com.br/MLB-99887766-fone">b</a>' \
            '<a href="https://www.mercadolivre.com.br/fone-x/p/MLB123">dup</a>'
    assert links_de_busca(busca) == [
        "https://www.mercadolivre.com.br/fone-x/p/MLB123",
        "https://produto.mercadolivre.com.br/MLB-99887766-fone"], links_de_busca(busca)

    assert _bloqueado("https://www.mercadolivre.com.br/gz/account-verification?go=x", "")
    assert _bloqueado("https://x/p", "<html>grecaptcha badge</html>")
    assert not _bloqueado("https://x/p", '<h1 class="ui-pdp-title">a</h1> grecaptcha')
    assert not _bloqueado("https://produto.mercadolivre.com.br/MLB-1", "<html>ok</html>")
    assert _slug("Fone Bluetooth JBL!! 2024") == "fone_bluetooth_jbl_2024"

    # listagem: objetos inteiros (sem vazar do vizinho), banner fora, posicao a partir de 1,
    # preco do card vence o do JSON, e o mesmo anuncio pago + organico conta duas vezes
    objs = ('[{"item_id":"MLB1","type":"PAD","sold_quantity":1000,"position":0,"price":236.65},'
            '{"item_id":"INTERVENTION","type":"CART_INTERVENTION","position":1},'
            '{"item_id":"MLB2","type":"ORGANIC","position":2,"price":31.47,"price_base":49.9},'
            '{"item_id":"MLB3","type":"ORGANIC","position":3},'
            '{"item_id":"MLB1","type":"ORGANIC","position":4,"price":236.65}]')
    card = ('<div class="poly-card"><img class="poly-component__picture" src="https://h/f.webp">'
            '<a class="poly-component__title" href="https://click1.x/c?'
            'wid=MLB1&amp;is_advertising=true">Suporte  Inox</a>'
            '<span class="poly-component__seller">Por LOJA X</span><div class="poly-price__current">'
            '<span class="andes-money-amount"><span class="andes-money-amount__fraction">1.224'
            '</span><span class="andes-money-amount__cents">82</span></span></div></div>'
            '<div class="poly-card"><a class="poly-component__title" href="https://www.mercado'
            'livre.com.br/x/p/MLB999?pdp_filters=item_id%3AMLB3">t</a><div class="poly-price__'
            'current"><span class="andes-money-amount"><span class="andes-money-amount__fraction">'
            '10</span></span></div></div>')
    for pagina in (f'<script>var d={objs};</script>{card}',                     # JSON cru
                   '<script>x("' + objs.replace('"', '\\"') + f'")</script>{card}'):  # escapado
        r = resultados_da_busca(pagina)
        assert [x["item_id"] for x in r] == ["MLB1", "MLB2", "MLB3", "MLB1"], r
        assert r[0]["preco"] == 1224.82 and r[3]["preco"] == 1224.82, r    # card, nao 236,65
        assert r[1]["preco"] == 31.47 and r[1]["preco_original"] == 49.9, r
        assert r[2]["preco"] == 10.0 and r[2]["vendidos"] is None, r        # MLB3, nao MLB999
        assert (r[0]["titulo"], r[0]["vendedor"], r[0]["imagem"]) == \
            ("Suporte Inox", "LOJA X", "https://h/f.webp"), r
        assert r[1]["titulo"] is None and r[2]["vendedor"] is None, r       # sem card / sem vendedor
    global baixar
    real, baixar = baixar, lambda urls, falhas=None: {u: f'<script>var d={objs};</script>' for u in urls}
    try:
        p = posicao("MLB2", "x")
    finally:
        baixar = real
    assert p["posicao"] == 2 and p["patrocinados_acima"] == 1 and p["total_na_pagina"] == 4, p
    assert [v["posicao"] for v in p["vizinhos"]] == [1, 2, 3, 4], p
    assert [(x["item_id"], x["posicao"]) for x in p["resultados"]] == \
        [("MLB1", 1), ("MLB2", 2), ("MLB3", 3), ("MLB1", 4)], p
    # canario: a pagina acima so tem o JSON, entao nenhum card casou. A medicao
    # continua valendo, mas o preco vem do JSON e tem de sair avisado.
    assert any("cards" in f for f in p["falhas"]), p["falhas"]

    # com card, nada de aviso falso
    real, baixar = baixar, lambda urls, falhas=None: {u: f'<script>var d={objs};</script>{card}'
                                                      for u in urls}
    try:
        ok = posicao("MLB2", "x")
    finally:
        baixar = real
    assert ok["posicao"] == 2 and not ok["falhas"], ok["falhas"]
    print("self-check OK")


if __name__ == "__main__":
    a = sys.argv[1:]
    cmd = a[0] if a else ""
    if cmd == "desbloquear":
        sys.exit(desbloquear())
    elif cmd == "login":
        sys.exit(login())
    elif cmd == "status":
        sys.exit(status())
    elif cmd == "url":
        sys.exit(raspar(a[1:]))
    elif cmd == "busca":
        p = int(a[a.index("--paginas") + 1]) if "--paginas" in a else 1
        m = int(a[a.index("--max") + 1]) if "--max" in a else 20
        sys.exit(buscar(a[1], p, m))
    elif cmd == "posicao":
        p = int(a[a.index("--paginas") + 1]) if "--paginas" in a else 1
        print(json.dumps(posicao(a[1], a[2], p), indent=2, ensure_ascii=False))
    elif cmd == "--html":
        print(json.dumps(parse(pathlib.Path(a[1]).read_text()), indent=2, ensure_ascii=False))
    elif cmd == "--self-check":
        self_check()
    else:
        print(__doc__)
