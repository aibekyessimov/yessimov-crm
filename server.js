// YESSIMOV CRM — остатки, приходы, движение и решения по товару. Данные берутся из BILLZ через API.
const http = require('http');
const crypto = require('crypto');
const store = require('./lib/store');
const billz = require('./lib/billz');
const an = require('./lib/analytics');
const tg = require('./lib/telegram');

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const PASS = { admin: process.env.ADMIN_PASS || '', seller: process.env.SELLER_PASS || '' };
const VERSION = require('./package.json').version;

// ---------- утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const pct = (v) => Math.round((v || 0) * 100) + '%';
const sign = (v) => (v > 0 ? '+' : '') + v;

function sessionCookie(role) {
  const exp = Date.now() + 30 * 864e5, data = role + '.' + exp;
  return data + '.' + crypto.createHmac('sha256', SECRET).update(data).digest('hex').slice(0, 32);
}
function roleOf(req) {
  const m = /(?:^|;\s*)s=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [role, exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!role || Number(exp) < Date.now()) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(role + '.' + exp).digest('hex').slice(0, 32);
  return sig === ok && (role === 'admin' || role === 'seller') ? role : null;
}
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => res(Object.fromEntries(new URLSearchParams(b)))); });
const redirect = (res, to, cookie) => { res.writeHead(303, { location: to, ...(cookie ? { 'set-cookie': cookie } : {}) }); res.end(); };

const DEC_CLASS = { 'Повтор': 'good', 'Распродать': 'bad', 'Уценка −50%': 'bad', 'Уценка −30%': 'warn', 'Летнее — распродать или убрать': 'warn', 'Новинка — ждём': 'info' };
const DEC_ORDER = ['Повтор', 'Распродать', 'Уценка −50%', 'Уценка −30%', 'Летнее — распродать или убрать', 'Новинка — ждём', 'Норма', 'Закончилась'];
const badge = (d) => '<span class="b ' + (DEC_CLASS[d] || '') + '">' + esc(d) + '</span>';

function currentShop(req, url) {
  const shops = an.shopsList(store.read('products.json', []));
  let s = url.searchParams.get('shop') || (/(?:^|;\s*)shop=([^;]+)/.exec(req.headers.cookie || '') || [])[1];
  s = s ? decodeURIComponent(s) : null;
  if (!s || !shops.includes(s)) s = shops.find((x) => /yessimov/i.test(x)) || shops[0] || '';
  return { shop: s, shops };
}

// ---------- оформление ----------
const CSS = `
:root{--bg:#f6f6f3;--panel:#fff;--fg:#151515;--mut:#6b6b66;--line:#e6e5df;--acc:#c8f03c;--good:#1d7a3a;--warn:#a05a00;--bad:#b3261e;--info:#2a5bd7}
@media(prefers-color-scheme:dark){:root{--bg:#121212;--panel:#1b1b1b;--fg:#f1f1ee;--mut:#a3a39d;--line:#2c2c2a;--good:#6fd38a;--warn:#f0b35a;--bad:#ff8a80;--info:#8fb0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
a{color:inherit}header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line)}
.top{display:flex;align-items:center;gap:12px;padding:10px 16px;max-width:1200px;margin:auto;flex-wrap:wrap}
.logo{font-weight:700;letter-spacing:.08em}.logo i{background:var(--acc);color:#111;font-style:normal;padding:0 6px;border-radius:4px;margin-left:6px;font-size:12px;letter-spacing:0}
nav{display:flex;gap:4px;overflow-x:auto;flex:1}nav a{padding:6px 10px;border-radius:8px;text-decoration:none;color:var(--mut);white-space:nowrap}nav a.on{background:var(--fg);color:var(--bg)}
main{max-width:1200px;margin:auto;padding:16px}h1{font-size:22px;margin:4px 0 12px}h2{font-size:17px;margin:0 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
.k{color:var(--mut);font-size:12px}.v{font-size:26px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}.s{color:var(--mut);font-size:12px}
.tw{overflow:auto;max-height:70vh}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th{position:sticky;top:0;background:var(--panel);text-align:left;color:var(--mut);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--line)}td.n,th.n{text-align:right}tr.click{cursor:pointer}tr.click:hover td{background:var(--bg)}
.b{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);white-space:nowrap}.b.good{color:var(--good)}.b.warn{color:var(--warn)}.b.bad{color:var(--bad)}.b.info{color:var(--info)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}.chips a{padding:4px 10px;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:13px;background:var(--panel)}.chips a.on{background:var(--fg);color:var(--bg)}
input,select,button,textarea{font:inherit;color:inherit}input[type=text],input[type=password],input[type=search],select{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--panel);min-width:0}
button,.btn{padding:8px 14px;border-radius:10px;border:1px solid var(--fg);background:var(--fg);color:var(--bg);cursor:pointer;text-decoration:none;display:inline-block}button.ghost{background:none;color:var(--fg)}
form.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.mx td,.mx th{text-align:center}.mx td:first-child,.mx th:first-child{text-align:left}.mx .q{font-size:16px;font-weight:600}.mx .z .q{color:var(--bad)}.mx small{display:block;color:var(--mut)}
.plus{color:var(--good)}.minus{color:var(--bad)}.note{color:var(--mut);font-size:13px}pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:var(--bg);padding:10px;border-radius:10px;max-height:60vh;overflow:auto}
.login{max-width:340px;margin:12vh auto}.login input{width:100%;margin:8px 0}.login button{width:100%}`;

function page(req, url, role, title, body, active) {
  const { shop, shops } = currentShop(req, url);
  const links = [['/', 'Сводка'], ['/stock', 'Остатки'], ['/decisions', 'Решения'], ['/moves', 'Движение'], ['/arrivals', 'Приходы']];
  if (role === 'admin') links.push(['/settings', 'Настройки']);
  const shopSel = shops.length > 1 ? '<form method="get" action="' + esc(url.pathname) + '"><select name="shop" onchange="document.cookie=\'shop=\'+encodeURIComponent(this.value)+\';path=/;max-age=31536000\';this.form.submit()">' + shops.map((s) => '<option' + (s === shop ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></form>' : '';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + ' · YESSIMOV CRM</title><style>' + CSS + '</style></head><body><header><div class="top"><div class="logo">YESSIMOV<i>CRM</i></div><nav>' +
    links.map(([h, t]) => '<a href="' + h + '"' + (active === h ? ' class="on"' : '') + '>' + t + '</a>').join('') + '</nav>' + shopSel + '<a class="note" href="/logout">Выйти</a></div></header><main>' + body + '</main></body></html>';
}

function syncLine() {
  const st = store.read('sync_state.json', {});
  const t = st.last_ok ? new Date(st.last_ok).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) : 'ещё не было';
  return '<p class="note">Последняя синхронизация с BILLZ: ' + esc(t) + (st.last_error ? ' · <span class="minus">ошибка: ' + esc(st.last_error) + '</span>' : '') + '</p>';
}

// ---------- страницы ----------
function pSummary(req, url, role) {
  const { shop } = currentShop(req, url);
  const products = store.read('products.json', []);
  if (!products.length) return page(req, url, role, 'Сводка', '<h1>Добро пожаловать</h1><div class="card"><p>Данных из BILLZ пока нет.</p>' + (role === 'admin' ? '<p><a class="btn" href="/settings">Указать ключ BILLZ</a></p>' : '<p>Попросите администратора подключить BILLZ.</p>') + '</div>' + syncLine(), '/');
  const s = an.summary(shop), money = role === 'admin';
  const tiles = [['Товара на полке', fmt(s.units) + ' шт', s.models + ' моделей']];
  if (money) tiles.push(['В товаре по себестоимости', fmt(s.cost) + ' ₸', 'по рознице ' + fmt(s.retail) + ' ₸']);
  tiles.push(['Ушло сегодня', fmt(s.today_out_units) + ' шт', money ? '≈ ' + fmt(s.today_out_retail) + ' ₸ по ценнику' : '']);
  tiles.push(['Пришло сегодня', fmt(s.today_in_units) + ' шт', '']);
  tiles.push(['Ушло за 7 дней', fmt(s.week_out_units) + ' шт', money ? 'себестоимость ' + fmt(s.week_out_cost) + ' ₸ — бюджет закупа' : '']);
  const dec = DEC_ORDER.filter((d) => s.decisions[d]).map((d) => '<a href="/decisions?d=' + encodeURIComponent(d) + '">' + badge(d) + ' ' + s.decisions[d] + '</a>').join(' ');
  const top = s.list.filter((m) => m.decision === 'Повтор').sort((a, b) => b.st - a.st).slice(0, 8);
  return page(req, url, role, 'Сводка', '<h1>' + esc(shop) + '</h1><div class="grid">' + tiles.map(([k, v, sub]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + sub + '</div></div>').join('') + '</div>' +
    '<div class="card"><h2>Решения по моделям</h2><div class="chips">' + dec + '</div></div>' +
    (top.length ? '<div class="card"><h2>Повторить в первую очередь</h2>' + modelsTable(top, role) + '</div>' : '') + syncLine(), '/');
}

function modelsTable(list, role) {
  const money = role === 'admin';
  return '<div class="tw"><table><thead><tr><th>Модель</th><th>Решение</th><th>Категория</th><th class="n">Остаток</th>' + (money ? '<th class="n">В товаре, ₸</th>' : '') + '<th class="n">Ушло</th><th class="n">Продаваемость</th><th class="n">Дней с прихода</th><th class="n">Дней без продаж</th></tr></thead><tbody>' +
    list.map((m) => '<tr class="click" onclick="location=\'/model?n=' + encodeURIComponent(m.name).replace(/'/g, '%27') + '\'"><td>' + esc(m.name) + '</td><td>' + badge(m.decision) + '</td><td>' + esc(m.category) + '</td><td class="n">' + fmt(m.stock) + '</td>' + (money ? '<td class="n">' + fmt(m.stock_cost) + '</td>' : '') + '<td class="n">' + fmt(m.sold) + '</td><td class="n">' + pct(m.st) + '</td><td class="n">' + (m.age ?? '—') + '</td><td class="n">' + (m.dl ?? '—') + '</td></tr>').join('') + '</tbody></table></div>';
}

function pStock(req, url, role) {
  const { shop } = currentShop(req, url);
  const q = (url.searchParams.get('q') || '').toLowerCase(), cat = url.searchParams.get('cat') || '';
  let list = an.models(shop);
  const cats = [...new Set(list.map((m) => m.category))].sort();
  list = list.filter((m) => (!q || m.name.toLowerCase().includes(q)) && (!cat || m.category === cat) && m.stock > 0).sort((a, b) => b.stock_cost - a.stock_cost);
  const form = '<form class="row" method="get"><input type="search" name="q" placeholder="Поиск модели" value="' + esc(q) + '"><select name="cat"><option value="">Все категории</option>' + cats.map((c) => '<option' + (c === cat ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select><button>Найти</button></form>';
  const units = list.reduce((s, m) => s + m.stock, 0);
  return page(req, url, role, 'Остатки', '<h1>Остатки</h1><div class="card">' + form + '<p class="note">' + list.length + ' моделей · ' + fmt(units) + ' шт. Нажмите на модель — увидите цвета и размеры.</p>' + modelsTable(list, role) + '</div>' + syncLine(), '/stock');
}

function pDecisions(req, url, role) {
  const { shop } = currentShop(req, url);
  const d = url.searchParams.get('d') || 'Повтор';
  const all = an.models(shop), counts = {};
  for (const m of all) counts[m.decision] = (counts[m.decision] || 0) + 1;
  const list = all.filter((m) => m.decision === d).sort((a, b) => b.stock_cost - a.stock_cost);
  const chips = '<div class="chips">' + DEC_ORDER.filter((x) => counts[x]).map((x) => '<a class="' + (x === d ? 'on' : '') + '" href="/decisions?d=' + encodeURIComponent(x) + '">' + esc(x) + ' · ' + counts[x] + '</a>').join('') + '</div>';
  return page(req, url, role, 'Решения', '<h1>Решения</h1><div class="card"><p class="note">Лестница: 0–30 дней полная цена · 30–60 −30% · 60–90 −50% · 90+ распродать. Повтор — ушло больше половины. «Ушло» считается по движению остатков с момента подключения CRM.</p>' + chips + modelsTable(list, role) + '</div>', '/decisions');
}

function pModel(req, url, role) {
  const { shop } = currentShop(req, url);
  const n = url.searchParams.get('n') || '';
  const m = an.models(shop).find((x) => x.name === n);
  if (!m) return page(req, url, role, 'Модель', '<h1>Модель не найдена</h1><p><a href="/stock">← к остаткам</a></p>', '/stock');
  const sizes = [...new Set(m.variants.map((v) => v.size))].sort((a, b) => an.sizeRank(a) - an.sizeRank(b));
  const colors = [...new Set(m.variants.map((v) => v.color))].sort((a, b) => a.localeCompare(b, 'ru'));
  const cell = (c, z) => { const vs = m.variants.filter((v) => v.color === c && v.size === z); if (!vs.length) return '<td class="note">·</td>'; const st = vs.reduce((s, v) => s + v.stock, 0), sd = vs.reduce((s, v) => s + v.sold, 0); return '<td class="' + (st <= 0 ? 'z' : '') + '"><span class="q">' + st + '</span><small>ушло ' + sd + '</small></td>'; };
  const v0 = m.variants[0] || {};
  const info = [badge(m.decision), 'остаток ' + fmt(m.stock) + ' шт', 'ушло ' + fmt(m.sold), 'продаваемость ' + pct(m.st), 'дней с прихода ' + (m.age ?? '—'), 'цена ' + fmt(v0.price) + ' ₸' + (role === 'admin' ? ', себестоимость ' + fmt(v0.cost) + ' ₸' : '')].join(' · ');
  return page(req, url, role, m.name, '<p><a class="note" href="/stock">← Остатки</a></p><h1>' + esc(m.name) + '</h1><div class="card"><p>' + info + '</p><div class="tw"><table class="mx"><thead><tr><th>Цвет \\ размер</th>' + sizes.map((z) => '<th>' + esc(z) + '</th>').join('') + '</tr></thead><tbody>' +
    colors.map((c) => '<tr><td>' + esc(c) + '</td>' + sizes.map((z) => cell(c, z)).join('') + '</tr>').join('') + '</tbody></table></div><p class="note">Красный ноль — размер закончился. «Ушло» — по движению остатков.</p></div>', '/stock');
}

function movesTable(list, role) {
  return '<div class="tw"><table><thead><tr><th>Когда</th><th>Модель</th><th>Цвет</th><th>Размер</th><th class="n">Было</th><th class="n">Стало</th><th class="n">Изменение</th>' + (role === 'admin' ? '<th class="n">По ценнику, ₸</th>' : '') + '</tr></thead><tbody>' +
    list.slice(0, 1500).map((m) => '<tr><td>' + esc(new Date(m.at).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) + '</td><td>' + esc(m.name) + '</td><td>' + esc(m.color) + '</td><td>' + esc(m.size) + '</td><td class="n">' + m.before + '</td><td class="n">' + m.after + '</td><td class="n ' + (m.delta > 0 ? 'plus' : 'minus') + '">' + sign(m.delta) + '</td>' + (role === 'admin' ? '<td class="n">' + fmt(Math.abs(m.delta) * m.price) + '</td>' : '') + '</tr>').join('') + '</tbody></table></div>';
}

function pMoves(req, url, role) {
  const { shop } = currentShop(req, url);
  const kind = url.searchParams.get('k') || 'all';
  let list = an.moves(shop, 90);
  if (kind === 'out') list = list.filter((m) => m.delta < 0); if (kind === 'in') list = list.filter((m) => m.delta > 0);
  const chips = '<div class="chips">' + [['all', 'Всё'], ['out', 'Ушло (продажи, списания)'], ['in', 'Пришло (приходы, возвраты)']].map(([k, t]) => '<a class="' + (k === kind ? 'on' : '') + '" href="/moves?k=' + k + '">' + t + '</a>').join('') + '</div>';
  return page(req, url, role, 'Движение', '<h1>Движение товара</h1><div class="card"><p class="note">Каждый час CRM сверяет остатки в BILLZ и записывает, что изменилось. История копится с момента подключения.</p>' + chips + (list.length ? movesTable(list, role) : '<p>Пока изменений не было.</p>') + '</div>' + syncLine(), '/moves');
}

function pArrivals(req, url, role) {
  const { shop } = currentShop(req, url);
  const list = an.moves(shop, 365).filter((m) => m.delta > 0);
  const byDay = new Map();
  for (const m of list) { const k = m.date; const o = byDay.get(k) || { date: k, units: 0, cost: 0, models: new Set() }; o.units += m.delta; o.cost += m.delta * m.cost; o.models.add(m.name); byDay.set(k, o); }
  const days = [...byDay.values()];
  return page(req, url, role, 'Приходы', '<h1>Приходы</h1><div class="card"><p class="note">Всё, что добавилось в остатки BILLZ: приходы и возвраты.</p>' + (days.length ? '<div class="tw"><table><thead><tr><th>Дата</th><th class="n">Штук</th>' + (role === 'admin' ? '<th class="n">Себестоимость, ₸</th>' : '') + '<th>Модели</th></tr></thead><tbody>' + days.map((d) => '<tr><td>' + esc(d.date) + '</td><td class="n">' + fmt(d.units) + '</td>' + (role === 'admin' ? '<td class="n">' + fmt(d.cost) + '</td>' : '') + '<td>' + esc([...d.models].join(', ')) + '</td></tr>').join('') + '</tbody></table></div>' : '<p>Приходов с момента подключения пока не было.</p>') + '</div>' + '<div class="card"><h2>Детально</h2>' + (list.length ? movesTable(list, role) : '<p class="note">—</p>') + '</div>', '/arrivals');
}

function pSettings(req, url, role, msg) {
  const s = store.settings(), st = store.read('sync_state.json', {});
  const chats = s.tg_chats || [];
  const mask = (v) => v ? '•••• ' + esc(String(v).slice(-4)) : 'не указан';
  return page(req, url, role, 'Настройки', '<h1>Настройки</h1>' + (msg ? '<div class="card">' + msg + '</div>' : '') +
    '<div class="card"><h2>BILLZ</h2><p class="note">Ключ: ' + mask(s.billz_token) + '. Синхронизация каждый час.</p><form class="row" method="post" action="/settings"><input type="password" name="billz_token" placeholder="Вставьте ключ API BILLZ" autocomplete="off" style="flex:1;min-width:220px"><button>Сохранить</button></form><form method="post" action="/sync"><button class="ghost">Синхронизировать сейчас</button></form>' +
    (st.last_log ? '<pre>' + esc(st.last_log.join('\n')) + '</pre>' : '') + '</div>' +
    '<div class="card"><h2>Telegram-бот</h2><p class="note">Токен: ' + mask(s.tg_token) + '. После сохранения откройте бота и нажмите /start, потом подтвердите себя ниже.</p><form class="row" method="post" action="/settings"><input type="password" name="tg_token" placeholder="Токен от @BotFather" autocomplete="off" style="flex:1;min-width:220px"><button>Сохранить</button></form>' +
    (chats.length ? '<table><tbody>' + chats.map((c) => '<tr><td>' + esc(c.name) + '</td><td>' + (c.approved ? '<span class="b good">подключён</span>' : '<form method="post" action="/tg/approve"><input type="hidden" name="id" value="' + esc(c.id) + '"><button>Подтвердить</button></form>') + '</td></tr>').join('') + '</tbody></table><form method="post" action="/tg/test" style="margin-top:8px"><button class="ghost">Отправить сводку сейчас</button></form>' : '<p class="note">Пока никто не нажал /start.</p>') + '</div>' +
    '<div class="card"><h2>Для разработчика</h2><p><a href="/explorer">Проверка API BILLZ</a> · версия ' + esc(VERSION) + '</p></div>', '/settings');
}

async function pExplorer(req, url, role) {
  const path = url.searchParams.get('path') || '/v2/products';
  const qs = url.searchParams.get('q') || 'limit=2';
  let out = '';
  if (url.searchParams.has('path')) {
    try { const r = await billz.request(path, Object.fromEntries(new URLSearchParams(qs))); out = '<p class="note">' + esc(r.url) + ' → ' + r.status + '</p><pre>' + esc(JSON.stringify(r.body, null, 2).slice(0, 60000)) + '</pre>'; }
    catch (e) { out = '<p class="minus">' + esc(e.message) + '</p>'; }
  }
  const raws = store.list('raw').map((f) => '<a href="/raw?f=' + encodeURIComponent(f) + '">' + esc(f) + '</a>').join(' · ');
  return page(req, url, role, 'API', '<h1>Проверка API BILLZ</h1><div class="card"><form class="row" method="get"><input type="text" name="path" value="' + esc(path) + '" style="flex:1"><input type="text" name="q" value="' + esc(qs) + '" style="flex:1"><button>GET</button></form>' + out + '<p class="note">Сохранённые ответы: ' + (raws || '—') + '</p></div>', '/settings');
}

// ---------- отчёт для Telegram ----------
function reportText() {
  const products = store.read('products.json', []);
  const shops = an.shopsList(products);
  const shop = shops.find((x) => /yessimov/i.test(x)) || shops[0];
  if (!shop) return 'Данных из BILLZ пока нет.';
  const s = an.summary(shop);
  const t = billz.today();
  const out = an.moves(shop, 2).filter((m) => m.date === t && m.delta < 0);
  const lines = out.slice(0, 25).map((m) => '• ' + esc(m.name) + ' ' + esc([m.color, m.size].filter(Boolean).join(' ')) + ' — ' + (-m.delta) + ' шт');
  const rep = s.list.filter((m) => m.decision === 'Повтор').slice(0, 10).map((m) => '• ' + esc(m.name) + ' (ушло ' + pct(m.st) + ', осталось ' + m.stock + ')');
  return '<b>' + esc(shop) + ' — ' + t + '</b>\nУшло сегодня: ' + s.today_out_units + ' шт (≈ ' + fmt(s.today_out_retail) + ' ₸ по ценнику)\nПришло: ' + s.today_in_units + ' шт\nНа полке: ' + fmt(s.units) + ' шт\n' +
    (lines.length ? '\n<b>Что ушло</b>\n' + lines.join('\n') + '\n' : '') + (rep.length ? '\n<b>Повторить</b>\n' + rep.join('\n') : '');
}

function weeklyText() {
  const products = store.read('products.json', []);
  const shops = an.shopsList(products);
  const shop = shops.find((x) => /yessimov/i.test(x)) || shops[0];
  if (!shop) return null;
  const s = an.summary(shop);
  const grp = (d) => s.list.filter((m) => m.decision === d).slice(0, 12).map((m) => '• ' + esc(m.name) + ' — ' + m.stock + ' шт');
  const parts = [['Повторить', 'Повтор'], ['Уценить −30%', 'Уценка −30%'], ['Уценить −50%', 'Уценка −50%'], ['Распродать', 'Распродать']].map(([t, d]) => { const l = grp(d); return l.length ? '<b>' + t + '</b>\n' + l.join('\n') : ''; }).filter(Boolean);
  return '<b>Понедельник: решения по товару</b>\nБюджет закупа на неделю ≈ ' + fmt(s.week_out_cost) + ' ₸ (себестоимость ушедшего за 7 дней)\n\n' + parts.join('\n\n');
}

// ---------- маршруты ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (html, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, version: VERSION })); }
  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      const b = await readBody(req);
      const role = PASS.admin && b.p === PASS.admin ? 'admin' : PASS.seller && b.p === PASS.seller ? 'seller' : null;
      if (role) return redirect(res, '/', 's=' + encodeURIComponent(sessionCookie(role)) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
      await new Promise((r) => setTimeout(r, 800));
    }
    return send('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · YESSIMOV CRM</title><style>' + CSS + '</style></head><body><div class="login card"><div class="logo">YESSIMOV<i>CRM</i></div><form method="post"><input type="password" name="p" placeholder="Пароль" autofocus>' + (req.method === 'POST' ? '<p class="minus">Неверный пароль</p>' : '') + '<button>Войти</button></form></div></body></html>');
  }
  if (url.pathname === '/logout') return redirect(res, '/login', 's=; Path=/; Max-Age=0');
  const role = roleOf(req);
  if (!role) return redirect(res, '/login');
  const admin = role === 'admin';
  try {
    switch (url.pathname) {
      case '/': return send(pSummary(req, url, role));
      case '/stock': return send(pStock(req, url, role));
      case '/decisions': return send(pDecisions(req, url, role));
      case '/model': return send(pModel(req, url, role));
      case '/moves': return send(pMoves(req, url, role));
      case '/arrivals': return send(pArrivals(req, url, role));
    }
    if (!admin) return send(page(req, url, role, 'Нет доступа', '<h1>Нет доступа</h1>'), 403);
    if (url.pathname === '/settings' && req.method === 'POST') {
      const b = await readBody(req), patch = {};
      if (b.billz_token) patch.billz_token = b.billz_token.trim();
      if (b.tg_token) patch.tg_token = b.tg_token.trim();
      store.saveSettings(patch);
      if (patch.billz_token) { const r = await doSync(); return send(pSettings(req, url, role, r.ok ? 'Ключ сохранён, данные из BILLZ загружены.' : 'Ключ сохранён, но синхронизация не прошла — смотрите журнал ниже.')); }
      return redirect(res, '/settings');
    }
    if (url.pathname === '/settings') return send(pSettings(req, url, role));
    if (url.pathname === '/sync' && req.method === 'POST') { const r = await doSync(); return send(pSettings(req, url, role, r.ok ? 'Синхронизация прошла.' : 'Синхронизация не прошла — смотрите журнал.')); }
    if (url.pathname === '/tg/approve' && req.method === 'POST') { const b = await readBody(req); const s = store.settings(); const chats = (s.tg_chats || []).map((c) => String(c.id) === b.id ? { ...c, approved: true } : c); store.saveSettings({ tg_chats: chats }); const c = chats.find((x) => String(x.id) === b.id); if (c) tg.send(c.id, 'Готово! Вы подключены к YESSIMOV CRM. Сводка — каждый вечер в 21:00, команда /otchet — в любой момент.'); return redirect(res, '/settings'); }
    if (url.pathname === '/tg/test' && req.method === 'POST') { const n = await tg.broadcast(reportText()); return send(pSettings(req, url, role, 'Сводка отправлена в ' + n + ' чат(а).')); }
    if (url.pathname === '/explorer') return send(await pExplorer(req, url, role));
    if (url.pathname === '/raw') { const f = url.searchParams.get('f') || ''; if (!/^[\w.-]+\.json$/.test(f)) return send('bad', 400); return send(page(req, url, role, f, '<h1>' + esc(f) + '</h1><pre>' + esc(JSON.stringify(store.read('raw/' + f, null), null, 2).slice(0, 80000)) + '</pre>', '/settings')); }
    return send(page(req, url, role, 'Не найдено', '<h1>Страница не найдена</h1>'), 404);
  } catch (e) {
    console.error(e);
    return send(page(req, url, role, 'Ошибка', '<h1>Ошибка</h1><pre>' + esc(e.stack || e.message) + '</pre>'), 500);
  }
}

let syncing = null;
async function doSync() {
  if (syncing) return syncing;
  syncing = billz.sync().then((r) => { try { an.updateFirstSeen(store.read('products.json', [])); } catch {} return r; }).finally(() => { syncing = null; });
  return syncing;
}

// ---------- расписание ----------
function almatyNow() { const d = new Date(Date.now() + 5 * 3600e3); return { h: d.getUTCHours(), m: d.getUTCMinutes(), wd: d.getUTCDay(), date: d.toISOString().slice(0, 10) }; }
setInterval(async () => {
  const s = store.settings(), st = store.read('sync_state.json', {}), now = almatyNow();
  const last = Date.parse(st.last_ok || st.last_try || 0) || 0;
  if (s.billz_token && Date.now() - last > 55 * 60e3) await doSync();
  const sent = store.read('sent.json', {});
  if (now.h === 21 && sent.daily !== now.date) { await doSync(); await tg.broadcast(reportText()); store.write('sent.json', { ...sent, daily: now.date }); }
  if (now.wd === 1 && now.h === 10 && sent.weekly !== now.date) { const t = weeklyText(); if (t) await tg.broadcast(t); store.write('sent.json', { ...store.read('sent.json', {}), weekly: now.date }); }
}, 60e3);

tg.start(async () => { await doSync(); return reportText(); });
http.createServer(handle).listen(PORT, () => console.log('YESSIMOV CRM ' + VERSION + ' on :' + PORT));
