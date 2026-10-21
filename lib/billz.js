// Синхронизация с BILLZ 2.0 API (https://api-admin.billz.ai).
// Вход: POST /v1/auth/login {secret_token} -> data.access_token.
// Пути товаров/продаж в документации BILLZ описаны неполно, поэтому синхронизация
// пробует несколько вариантов и сохраняет сырые ответы в data/raw для проверки.
const store = require('./store');

const BASE = 'https://api-admin.billz.ai';
let token = null, tokenUntil = 0;

async function login() {
  const secret = store.settings().billz_token;
  if (!secret) throw new Error('Не указан ключ BILLZ в настройках');
  const res = await fetch(BASE + '/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ secret_token: secret }),
  });
  const j = await res.json().catch(() => null);
  const t = j && j.data && j.data.access_token;
  if (!res.ok || !t) throw new Error('BILLZ не принял ключ (' + res.status + '): ' + JSON.stringify(j).slice(0, 300));
  token = t; tokenUntil = Date.now() + ((j.data.expires_in || 3600) * 1000) - 60000;
  return t;
}

async function request(path, query, retry = true) {
  if (!token || Date.now() > tokenUntil) await login();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { accept: 'application/json', authorization: 'Bearer ' + token } });
  if (res.status === 401 && retry) { token = null; return request(path, query, false); }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, url: url.pathname + url.search, body };
}

// Находит первый массив объектов в ответе (products, orders, data.items и т.п.)
function findArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const k of ['products', 'orders', 'items', 'data', 'result', 'results', 'rows', 'list', 'imports']) {
    const v = body[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') { const a = findArray(v); if (a) return a; }
  }
  for (const v of Object.values(body)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  return null;
}

const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };

// Достаёт цвет/размер из атрибутов товара в любом из распространённых видов
function attrs(p) {
  const out = {};
  const lists = [p.product_attributes, p.attributes, p.attribute_values, p.variations, p.custom_fields].filter(Array.isArray);
  for (const list of lists) for (const a of list) {
    const name = String(pick(a, ['attribute_name', 'name', 'title', 'key']) || '').toLowerCase();
    const val = pick(a, ['attribute_value', 'value', 'value_name', 'name_value']);
    if (val === undefined) continue;
    if (name.includes('цвет') || name.includes('color') || name.includes('rang')) out.color = String(val);
    if (name.includes('размер') || name.includes('size') || name.includes("o'lcham")) out.size = String(val);
  }
  for (const [k, v] of Object.entries(p)) {
    const kl = k.toLowerCase();
    if (!out.color && (kl === 'color' || kl.endsWith('цвет'))) out.color = String(v);
    if (!out.size && (kl === 'size' || kl.endsWith('размер'))) out.size = String(v);
  }
  return out;
}

function normProduct(p) {
  const a = attrs(p);
  const shops = {};
  const stockList = [p.shop_measurement_values, p.shop_stocks, p.stocks, p.measurement_values].find(Array.isArray) || [];
  for (const s of stockList) {
    const shop = String(pick(s, ['shop_name', 'name', 'shop']) || pick(s, ['shop_id']) || 'Магазин');
    shops[shop] = shops[shop] || { stock: 0, price: 0, cost: 0 };
    shops[shop].stock += num(pick(s, ['active_measurement_value', 'measurement_value', 'quantity', 'stock', 'amount', 'count']));
  }
  const priceList = [p.shop_prices, p.prices].find(Array.isArray) || [];
  for (const s of priceList) {
    const shop = String(pick(s, ['shop_name', 'name', 'shop']) || pick(s, ['shop_id']) || 'Магазин');
    shops[shop] = shops[shop] || { stock: 0, price: 0, cost: 0 };
    shops[shop].price = num(pick(s, ['retail_price', 'price', 'sale_price']));
    shops[shop].cost = num(pick(s, ['supply_price', 'cost_price', 'purchase_price'])) || shops[shop].cost;
  }
  const topCost = num(pick(p, ['supply_price', 'cost_price', 'purchase_price']));
  const topPrice = num(pick(p, ['retail_price', 'price']));
  if (!Object.keys(shops).length) shops['Магазин'] = { stock: num(pick(p, ['quantity', 'stock', 'measurement_value'])), price: topPrice, cost: topCost };
  for (const s of Object.values(shops)) { if (!s.cost) s.cost = topCost; if (!s.price) s.price = topPrice; }
  const cats = [p.categories, p.category].flat().filter(Boolean);
  const category = cats.length ? String(typeof cats[0] === 'object' ? pick(cats[0], ['name', 'title']) : cats[0]) : '';
  const supplier = p.suppliers && p.suppliers[0] ? pick(p.suppliers[0], ['name']) : pick(p, ['supplier_name', 'supplier']);
  return {
    id: String(pick(p, ['id', 'product_id']) || ''),
    name: String(pick(p, ['parent_name', 'name', 'title']) || '').trim(),
    full_name: String(pick(p, ['name', 'title']) || '').trim(),
    sku: String(pick(p, ['sku', 'article', 'vendor_code']) || ''),
    barcode: String(pick(p, ['barcode']) || ''),
    color: a.color || '', size: a.size || '',
    category, supplier: typeof supplier === 'object' ? JSON.stringify(supplier) : String(supplier || ''),
    brand: String(pick(p, ['brand_name']) || (p.brand && p.brand.name) || ''),
    created: String(pick(p, ['created_at', 'created']) || '').slice(0, 10),
    shops,
  };
}

async function fetchAll(paths, query, log) {
  for (const path of paths) {
    const first = await request(path, { ...query, page: 1, limit: 100 });
    store.write('raw/' + path.replace(/\W+/g, '_') + '.json', { at: new Date().toISOString(), status: first.status, url: first.url, body: first.body });
    const arr = first.ok ? findArray(first.body) : null;
    log.push(path + ' → ' + first.status + (arr ? ' (' + arr.length + ' на 1-й странице)' : ''));
    if (!arr) continue;
    const all = [...arr];
    for (let page = 2; arr.length && page <= 200; page++) {
      const r = await request(path, { ...query, page, limit: 100 });
      const a = r.ok ? findArray(r.body) : null;
      if (!a || !a.length) break;
      all.push(...a);
      if (a.length < 100) break;
    }
    return { path, items: all };
  }
  return { path: null, items: [] };
}

const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // время Алматы

async function sync() {
  const log = [];
  const started = new Date().toISOString();
  try {
    await login();
    log.push('Вход в BILLZ: ок');
    const prods = await fetchAll(['/v2/products', '/v1/products'], {}, log);
    const products = prods.items.map(normProduct).filter((p) => p.id || p.barcode);
    if (products.length) {
      const prev = store.read('products.json', []);
      store.write('products.json', products);
      // Снимок остатков на сегодня: ключ = id товара, значение = остаток по магазинам
      const snap = {};
      for (const p of products) snap[p.id || p.barcode] = Object.fromEntries(Object.entries(p.shops).map(([k, v]) => [k, v.stock]));
      const d = today();
      const prevSnap = store.read('snapshots/' + d + '.json', null);
      store.write('snapshots/' + d + '.json', snap);
      recordMoves(prevSnap || lastSnapshotBefore(d), snap, products);
      log.push('Товаров: ' + products.length + (prev.length ? ' (было ' + prev.length + ')' : ''));
    }
    // Продажи и приходы: пробуем известные пути, сохраняем сырые ответы
    const from = store.read('sync_state.json', {}).orders_from || '2026-01-01';
    const ord = await fetchAll(['/v2/orders', '/v1/orders', '/v3/orders'], { date_from: from, date_to: today(), start_date: from, end_date: today() }, log);
    if (ord.items.length) { store.write('orders_raw.json', ord.items); log.push('Продаж (чеков): ' + ord.items.length); }
    const imp = await fetchAll(['/v2/imports', '/v1/imports', '/v2/import', '/v2/supplies'], {}, log);
    if (imp.items.length) { store.write('imports_raw.json', imp.items); log.push('Приходов: ' + imp.items.length); }
    store.write('sync_state.json', { ...store.read('sync_state.json', {}), last_ok: started, last_log: log, last_error: null });
    return { ok: true, log };
  } catch (e) {
    log.push('Ошибка: ' + e.message);
    store.write('sync_state.json', { ...store.read('sync_state.json', {}), last_try: started, last_log: log, last_error: e.message });
    return { ok: false, log };
  }
}

function lastSnapshotBefore(d) {
  const files = store.list('snapshots').filter((f) => f.slice(0, 10) < d);
  return files.length ? store.read('snapshots/' + files[files.length - 1], null) : null;
}

// Движение: разница остатков между синхронизациями. Плюс = приход/возврат, минус = продажа/списание.
function recordMoves(prev, snap, products) {
  if (!prev) return;
  const byId = new Map(products.map((p) => [p.id || p.barcode, p]));
  const moves = store.read('moves.json', []);
  const at = new Date().toISOString();
  for (const [id, shops] of Object.entries(snap)) {
    for (const [shop, qty] of Object.entries(shops)) {
      const before = prev[id] ? num(prev[id][shop]) : 0;
      const delta = qty - before;
      if (!delta) continue;
      const p = byId.get(id) || {};
      moves.push({ at, date: today(), id, shop, name: p.name, color: p.color, size: p.size, before, after: qty, delta, cost: (p.shops && p.shops[shop] && p.shops[shop].cost) || 0, price: (p.shops && p.shops[shop] && p.shops[shop].price) || 0 });
    }
  }
  store.write('moves.json', moves.slice(-50000));
}

module.exports = { sync, request, today };
