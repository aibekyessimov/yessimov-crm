// Расчёты: модели, продаваемость, возраст товара, решения по лестнице уценки.
const store = require('./store');
const { today } = require('./billz');

const DAY = 864e5;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const SUMMER = /шорт|лен|лён|тенниск|холодок|alo|сетк|майка/i;
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', '5XL'];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i >= 0 ? i : 100 + (Number(s) || 999); };

// Категория по названию, если в BILLZ её нет
const RULES = [['Носки', /носк|ноские|следик/i], ['Двойки и костюмы', /двойка|костюм/i], ['Спорт', /спорт|трико|джоггер|леггинс/i], ['Лонгсливы', /лонгслив/i],
  ['Тенниски и поло', /тенниск|polo/i], ['Футболки и майки', /футболк|майка|акция/i], ['Кофты и кардиганы', /кофт|кардиган|свитер|джемпер/i], ['Рубашки', /рубашк/i],
  ['Шорты', /шорт/i], ['Джинсы', /джинс/i], ['Брюки и штаны', /брюки|штаны|слаксы|чинос/i], ['Верхняя одежда', /ветровк|пальто|куртк|пуховик|бомбер/i], ['Жилеты', /жилет/i], ['Аксессуары', /сумк|ремен|кепк|шапк/i]];
const guessCat = (n) => { for (const [c, re] of RULES) if (re.test(n)) return c; return 'Без категории'; };

function shopsList(products) {
  const s = new Set(); for (const p of products) for (const k of Object.keys(p.shops || {})) s.add(k); return [...s];
}

// Первая дата, когда товар появился в остатках (по снимкам), иначе дата создания в BILLZ
function firstSeen() {
  const seen = store.read('first_seen.json', null);
  if (seen) return seen;
  return {};
}
// Дата появления товара. Товары, которые уже были в остатках при подключении CRM, получают null
// (дата неизвестна), пока её не загрузят из выгрузки приходов. Новые — дату первой синхронизации, где они появились.
function updateFirstSeen(products) {
  const st = store.read('sync_state.json', {});
  const d = today();
  const baseline = !st.tracking_since;
  const seen = baseline ? {} : store.read('first_seen.json', {});
  for (const p of products) {
    const id = p.id || p.barcode;
    const has = Object.values(p.shops || {}).some((s) => s.stock > 0);
    if (!(id in seen)) seen[id] = baseline ? (p.created || null) : (has ? d : null);
    else if (seen[id] === null && has && !baseline && st.tracking_since && st.tracking_since < d && !(store.read('baseline_ids.json', {})[id])) seen[id] = d;
  }
  if (baseline) { store.write('baseline_ids.json', Object.fromEntries(products.map((p) => [p.id || p.barcode, 1]))); store.write('sync_state.json', { ...st, tracking_since: d }); }
  store.write('first_seen.json', seen);
}

// Продано: по чекам BILLZ (sales.json), а если чеков нет — по движению остатков
function sold(sinceDays) {
  const sales = store.read('sales.json', []);
  if (sales.length) {
    const since = new Date(Date.now() - sinceDays * DAY).toISOString().slice(0, 10);
    const out = new Map();
    for (const l of sales) if (l.date >= since) { const k = l.shop + '\u0001' + l.product_id; out.set(k, (out.get(k) || 0) + l.qty - (l.returned || 0)); }
    return out;
  }
  const moves = store.read('moves.json', []);
  const since = new Date(Date.now() - sinceDays * DAY).toISOString();
  const out = new Map();
  for (const m of moves) if (m.delta < 0 && m.at >= since) {
    const k = m.shop + '\u0001' + m.id; out.set(k, (out.get(k) || 0) - m.delta);
  }
  return out;
}

function decide({ stock, st, age, dl, name }) {
  if (stock <= 0) return st >= 0.5 ? 'Повтор' : 'Закончилась';
  if (age === null && dl === null && st === 0) return SUMMER.test(name) ? 'Летнее — распродать или убрать' : 'Нет данных — копим историю';
  if (SUMMER.test(name) && (dl === null || dl > 30)) return 'Летнее — распродать или убрать';
  if (age !== null && age <= 30) return st >= 0.5 ? 'Повтор' : 'Новинка — ждём';
  const d = age !== null ? age : (dl === null ? 999 : dl);
  if (d > 90 && st < 0.8) return 'Распродать';
  if (d > 60 && st < 0.6) return 'Уценка −50%';
  if (d > 30 && st < 0.4) return 'Уценка −30%';
  if (st >= 0.5 && dl !== null && dl <= 14) return 'Повтор';
  return 'Норма';
}

function lastSale() {
  const sales = store.read('sales.json', []);
  if (sales.length) {
    const out = new Map();
    for (const l of sales) if (l.qty > 0) { const k = l.shop + '\u0001' + l.product_id; if (!out.get(k) || out.get(k) < l.date) out.set(k, l.date); }
    return out;
  }
  const moves = store.read('moves.json', []);
  const out = new Map();
  for (const m of moves) if (m.delta < 0) { const k = m.shop + '\u0001' + m.id; if (!out.get(k) || out.get(k) < m.date) out.set(k, m.date); }
  return out;
}

// Модели магазина: суммы по всем вариантам (цвет × размер)
function models(shop) {
  const products = store.read('products.json', []);
  const seen = firstSeen(), s30 = sold(3650), ls = lastSale(), t = today();
  const fsale = new Map();
  for (const l of store.read('sales.json', [])) if (l.qty > 0) { const k = l.shop + '\u0001' + l.product_id; if (!fsale.get(k) || l.date < fsale.get(k)) fsale.set(k, l.date); }
  const m = new Map();
  for (const p of products) {
    const sh = (p.shops || {})[shop]; if (!sh) continue;
    const id = p.id || p.barcode, k = p.name || p.full_name;
    const o = m.get(k) || { name: k, category: p.category || guessCat(k), stock: 0, stock_cost: 0, stock_retail: 0, sold: 0, first: null, last: null, variants: [] };
    const sd = s30.get(shop + '\u0001' + id) || 0;
    o.stock += Math.max(0, sh.stock); o.stock_cost += Math.max(0, sh.stock) * sh.cost; o.stock_retail += Math.max(0, sh.stock) * sh.price; o.sold += sd;
    // дата завоза варианта: из наблюдений CRM, иначе не позже первой продажи
    const fs = fsale.get(shop + '\u0001' + id);
    const f = seen[id] && fs ? (seen[id] < fs ? seen[id] : fs) : (seen[id] || fs || null);
    if (f && (!o.first || f > o.first)) o.first = f; // последний завоз модели
    const l = ls.get(shop + '\u0001' + id); if (l && (!o.last || l > o.last)) o.last = l;
    o.variants.push({ id, color: p.color || '—', size: p.size || '—', stock: sh.stock, sold: sd, cost: sh.cost, price: sh.price, barcode: p.barcode });
    m.set(k, o);
  }
  return [...m.values()].map((o) => {
    const st = o.sold + o.stock > 0 ? o.sold / (o.sold + o.stock) : 0;
    const age = o.first ? days(o.first, t) : null, dl = o.last ? days(o.last, t) : null;
    return { ...o, st, age, dl, decision: decide({ stock: o.stock, st, age, dl, name: o.name }) };
  });
}

// Движение по дням
function moves(shop, limitDays = 60) {
  const since = new Date(Date.now() - limitDays * DAY).toISOString();
  return store.read('moves.json', []).filter((m) => m.shop === shop && m.at >= since).reverse();
}

function salesStats(shop) {
  const sales = store.read('sales.json', []).filter((l) => l.shop === shop);
  const t = today(), back = (n) => new Date(Date.parse(t + 'T00:00:00Z') - n * DAY).toISOString().slice(0, 10), d7 = back(6), d30 = back(29);
  const agg = (ls) => ({ units: ls.reduce((s, l) => s + l.qty - (l.returned || 0), 0), revenue: ls.reduce((s, l) => s + l.total, 0), cost: ls.reduce((s, l) => s + (l.qty - (l.returned || 0)) * l.cost, 0), discount: ls.reduce((s, l) => s + l.discount, 0), checks: new Set(ls.map((l) => l.order)).size });
  const bySeller = new Map();
  for (const l of sales.filter((l) => l.date >= d30)) { const o = bySeller.get(l.seller) || { seller: l.seller || '—', revenue: 0, units: 0, discount: 0 }; o.revenue += l.total; o.units += l.qty; o.discount += l.discount; bySeller.set(l.seller, o); }
  const weeks = new Map();
  for (const l of sales) { const d = new Date(l.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const w = d.toISOString().slice(0, 10); weeks.set(w, (weeks.get(w) || 0) + l.total); }
  return { has: sales.length > 0, today: agg(sales.filter((l) => l.date === t)), week: agg(sales.filter((l) => l.date >= d7)), month: agg(sales.filter((l) => l.date >= d30)), sellers: [...bySeller.values()].sort((a, b) => b.revenue - a.revenue), weeks: [...weeks.entries()].sort(), lines: sales };
}

function summary(shop) {
  const ms = models(shop);
  const mv = moves(shop, 7);
  const t = today();
  const todayOut = mv.filter((m) => m.date === t && m.delta < 0);
  const todayIn = mv.filter((m) => m.date === t && m.delta > 0);
  const weekOut = mv.filter((m) => m.delta < 0);
  return {
    units: ms.reduce((s, m) => s + m.stock, 0), cost: ms.reduce((s, m) => s + m.stock_cost, 0), retail: ms.reduce((s, m) => s + m.stock_retail, 0),
    models: ms.length,
    today_out_units: todayOut.reduce((s, m) => s - m.delta, 0), today_out_retail: todayOut.reduce((s, m) => s - m.delta * m.price, 0),
    today_in_units: todayIn.reduce((s, m) => s + m.delta, 0),
    week_out_units: weekOut.reduce((s, m) => s - m.delta, 0), week_out_cost: weekOut.reduce((s, m) => s - m.delta * m.cost, 0), week_out_retail: weekOut.reduce((s, m) => s - m.delta * m.price, 0),
    decisions: ms.reduce((acc, m) => { acc[m.decision] = (acc[m.decision] || 0) + 1; return acc; }, {}),
    list: ms,
  };
}

module.exports = { models, moves, summary, salesStats, shopsList, sizeRank, updateFirstSeen };
