// Aviso no topo das telas quando falta algo para a integração com o Mercado Livre funcionar.
(async () => {
  let r;
  try {
    const res = await fetch('/api/config/resumo');
    if (!res.ok) return;
    r = await res.json();
  } catch { return; }

  const TEXTOS = {
    credenciais: ['Falta configurar o seu aplicativo do Mercado Livre.', 'Configurar agora'],
    url: ['Cadastre a URI de redirect no seu aplicativo do Mercado Livre — sem ela o login da conta não volta.', 'Ver a URI'],
    conta: ['Nenhuma conta do Mercado Livre conectada ainda.', 'Conectar conta'],
  };
  const t = TEXTOS[r.pendente];
  if (!t) return;

  const barra = document.createElement('div');
  barra.setAttribute('role', 'status');
  barra.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:10px 20px;'
    + 'font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border-bottom:1px solid;'
    + 'background:#fff4e0;color:#7a4a00;border-color:#f0c46b';
  const msg = document.createElement('span');
  msg.textContent = t[0];
  const link = document.createElement('a');
  link.href = '/configuracao.html';
  link.textContent = t[1] + ' →';
  link.style.cssText = 'color:inherit;font-weight:700';
  barra.append(msg, link);
  const header = document.querySelector('header');
  if (header) header.after(barra); else document.body.prepend(barra);
})();
