// 发卡商城 · 买家端
// 安全约定：本页不携带任何"标记已支付/改库存/改价格"的能力。
// 浏览器只能调用 4 个白名单 RPC，卡密只在订单已支付后由数据库发出。
'use strict';

const CFG = window.FAKA_CONFIG;
if (!CFG || !CFG.SUPA_URL || !CFG.SUPA_KEY) {
  const g = document.getElementById('goodsGrid');
  g.textContent = '';
  const tip = document.createElement('div');
  tip.className = 'empty';
  tip.textContent = '请先编辑站点根目录下的 config.js，填写 Supabase 接口地址';
  g.appendChild(tip);
  throw new Error('FAKA_CONFIG missing');
}

const supa = window.supabase.createClient(CFG.SUPA_URL, CFG.SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 数据库抛出的错误码 → 买家可见文案。
// 刻意不回显原始报错：旧版 toast(e.message) 会把表名/列名/策略名泄漏给攻击者。
const ERR_TEXT = {
  BAD_QTY: '购买数量不合法（1~10 张）',
  BAD_EMAIL: '请填写正确的邮箱',
  TOO_MANY_PENDING: '你在途的待支付订单过多，请先完成支付或稍后再试',
  NO_STOCK: '库存不足，暂时无法下单',
  GOODS_UNAVAILABLE: '该商品已下架',
  ORDER_NOT_FOUND: '未找到订单',
};
function errText(err) {
  const m = String((err && err.message) || err || '');
  for (const k in ERR_TEXT) if (m.includes(k)) return ERR_TEXT[k];
  if (m.includes('NetworkError') || m.includes('Failed to fetch')) return '网络异常，请重试';
  return '操作失败，请稍后重试';
}
const money = (fen) => ((Number(fen) || 0) / 100).toFixed(2);

/* ---------- DOM 工具：一律 textContent，不用 innerHTML 拼业务数据 ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
const $ = (id) => document.getElementById(id);
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function show(id) { $(id).classList.add('show'); }
function hide(id) { $(id).classList.remove('show'); }

/* ---------- 状态 ---------- */
let catalog = [];
let current = null;    // 当前选购的商品行
let qty = 1;
let order = null;      // rpc_create_order 返回的订单
let pollTimer = null;
let currentCards = [];

/* ---------- 加载 ---------- */
async function loadSite() {
  const { data, error } = await supa.rpc('rpc_site_config');
  if (error) { console.error(error); return; }
  $('siteName').textContent = data.siteName || '发卡商城';
  $('announcement').textContent = data.announcement || '欢迎光临本店！';
  document.title = (data.siteName || '发卡商城') + ' - 自动发卡，秒到账';
}

async function loadCatalog() {
  const grid = $('goodsGrid');
  grid.textContent = '';
  grid.appendChild(el('div', 'empty', '正在加载商品...'));
  const { data, error } = await supa.rpc('rpc_catalog');
  if (error) {
    grid.textContent = '';
    grid.appendChild(el('div', 'empty', errText(error)));
    console.error(error);
    return;
  }
  catalog = Array.isArray(data) ? data : [];
  shown = PAGE_SIZE;
  paint();
}

/* ---------- 分类 / 搜索 / 排序 / 分页 ----------
   商品上千个，一次性全渲染会卡；这里只渲染前 shown 个，其余靠「加载更多」。
   分类和搜索都在内存里做，不再多打一次数据库。 */
const PAGE_SIZE = 60;
let shown = PAGE_SIZE;
let catKey = '';
let keyword = '';
let sortKey = 'new';

function catOf(g) { return String(g.category || '').trim() || '未分类'; }

function byKeyword() {
  if (!keyword) return catalog;
  return catalog.filter((g) => `${g.name || ''} ${g.category || ''} ${g.description || ''}`.toLowerCase().includes(keyword));
}

function categoryList(list) {
  const m = new Map();
  for (const g of list) { const k = catOf(g); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
}

function sortedList(list) {
  const arr = list.slice();
  // rpc_catalog 本身按 created_at DESC 返回，new 就不用再排
  if (sortKey === 'cheap') arr.sort((a, b) => (a.price - b.price) || (b.id - a.id));
  else if (sortKey === 'exp') arr.sort((a, b) => (b.price - a.price) || (b.id - a.id));
  else if (sortKey === 'hot') arr.sort((a, b) => (Number(b.sales) || 0) - (Number(a.sales) || 0) || (b.id - a.id));
  return arr;
}

function currentList() {
  const base = byKeyword();
  const cats = categoryList(base);
  if (catKey && !cats.some((c) => c[0] === catKey)) catKey = '';
  const list = catKey ? base.filter((g) => catOf(g) === catKey) : base;
  return { cats, list: sortedList(list) };
}

function chip(label, n, key) {
  const b = el('button', 'cat-chip' + (catKey === key ? ' on' : ''));
  b.type = 'button';
  b.setAttribute('data-cat', key);
  b.appendChild(document.createTextNode(label));
  if (n) b.appendChild(el('small', null, String(n)));
  return b;
}

function renderCats(cats) {
  const bar = $('catBar');
  bar.textContent = '';
  if (cats.length < 2) return;
  const TOP = 16;
  const head = cats.slice(0, TOP);
  const tail = cats.slice(TOP);
  bar.appendChild(chip('全部', 0, ''));
  for (const [name, n] of head) bar.appendChild(chip(name, n, name));
  if (tail.length) {
    // 分类太多（自动归类很容易上百个），长尾收进下拉框，不占地方
    const sel = document.createElement('select');
    sel.className = 'shop-sort cat-more';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = `其他 ${tail.length} 个分类 ▾`;
    sel.appendChild(ph);
    for (const [name, n] of tail) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = `${name} (${n})`;
      sel.appendChild(o);
    }
    if (tail.some((c) => c[0] === catKey)) sel.value = catKey;
    sel.addEventListener('change', () => { catKey = sel.value; shown = PAGE_SIZE; paint(); });
    bar.appendChild(sel);
  }
}

function paint() {
  const grid = $('goodsGrid');
  const moreRow = $('moreRow');
  const count = $('shopCount');
  grid.textContent = '';
  if (!catalog.length) {
    grid.appendChild(el('div', 'empty', '暂无在售商品'));
    $('catBar').textContent = '';
    if (count) count.textContent = '';
    if (moreRow) moreRow.style.display = 'none';
    return;
  }
  const cur = currentList();
  renderCats(cur.cats);
  if (!cur.list.length) {
    grid.appendChild(el('div', 'empty', '没有匹配的商品，换个关键词试试'));
    if (count) count.textContent = '共 0 个';
    if (moreRow) moreRow.style.display = 'none';
    return;
  }
  for (const g of cur.list.slice(0, shown)) grid.appendChild(renderCard(g));
  if (moreRow) moreRow.style.display = shown < cur.list.length ? 'block' : 'none';
  if (count) {
    const bits = [];
    if (keyword) bits.push('搜索「' + keyword + '」');
    bits.push(catKey || '全部分类');
    bits.push('共 ' + cur.list.length + ' 个');
    bits.push('已显示 ' + Math.min(shown, cur.list.length) + ' 个');
    count.textContent = bits.join(' ｜ ');
  }
}

/* ---------- 货源代发：配了对方 SKU 的商品不受本店卡密库存限制 ---------- */
function supplierSku(g) {
  return String((g && g.supplier_sku_id) || '').trim();
}

function renderCard(g) {
  const stock = Number(g.stock) || 0;
  const box = el('div', 'goods-card');

  if (g.category) box.appendChild(el('span', 'goods-category', g.category));
  box.appendChild(el('div', 'goods-cover', g.cover || '🎁'));
  box.appendChild(el('div', 'goods-name', g.name));
  box.appendChild(el('div', 'goods-desc', g.description || '暂无介绍'));

  const meta = el('div', 'goods-meta');
  const price = el('span', 'goods-price');
  price.appendChild(el('small', null, '¥'));
  price.appendChild(document.createTextNode(money(g.price)));
  meta.appendChild(price);
  meta.appendChild(el('span', 'goods-sold', `已售 ${Number(g.sales) || 0}`));
  box.appendChild(meta);

  const sku = supplierSku(g);
  if (sku) {
    box.appendChild(el('div', 'goods-stock', '货源直发 · 付款后自动发货'));
  } else {
    box.appendChild(el('div', 'goods-stock' + (stock <= 3 ? ' low' : ''),
      stock > 0 ? `库存 ${stock} 张` : '⚠️ 已售罄'));
  }

  const btn = el('button', 'btn btn-primary btn-block',
    (sku || stock > 0) ? '立即购买' : '暂时缺货');
  btn.disabled = !sku && stock <= 0;
  btn.type = 'button';
  btn.addEventListener('click', () => openBuy(g));
  box.appendChild(btn);
  return box;
}

/* ---------- 购买 ---------- */
function openBuy(g) {
  current = g;
  qty = 1;
  $('qtyNum').textContent = '1';
  $('buyEmail').value = localStorage.getItem('FAKA_EMAIL') || '';
  const sum = $('buySummary');
  sum.textContent = '';
  sum.appendChild(el('div', 'cover', g.cover || '🎁'));
  const info = el('div');
  info.appendChild(el('div', 'name', g.name));
  info.appendChild(el('div', 'sub', `单价 ¥${money(g.price)} / 张`));
  sum.appendChild(info);
  const hint = $('buyStockHint');
  if (hint) hint.textContent = supplierSku(g)
    ? '（货源直发，单次 1~10 张）'
    : `（剩余库存 ${Number(g.stock) || 0} 张）`;
  updateTotal();
  show('buyModal');
  $('buyEmail').focus();
}

function changeQty(d) {
  if (!current) return;
  const stock = Number(current.stock) || 0;
  qty = Math.min(Math.max(1, qty + d), Math.max(1, Math.min(stock, 10)));
  $('qtyNum').textContent = String(qty);
  updateTotal();
}
function updateTotal() {
  if (current) $('totalPrice').textContent = money(current.price * qty);
}

async function submitOrder() {
  if (!current) return;
  const email = $('buyEmail').value.trim();
  const btn = $('submitOrderBtn');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('请填写正确的邮箱'); return; }

  btn.disabled = true;
  btn.textContent = '下单中...';
  try {
    const { data, error } = await supa.rpc('rpc_create_order', {
      p_goods_id: current.id, p_qty: qty, p_email: email, p_code: getRef(),
    });
    if (error) { toast(errText(error)); console.error(error); return; }

    order = data;
    order.email = email;
    localStorage.setItem('FAKA_EMAIL', email);
    hide('buyModal');
    openPayModal();
    loadCatalog();
  } finally {
    btn.disabled = false;
    btn.textContent = '立即下单';
  }
}

/* ---------- 支付（等待回调，不在本地判定成功） ---------- */
function openPayModal() {
  $('payAmount').textContent = money(order.amount);
  $('payOrderId').textContent = order.order_id;
  $('payGoodsName').textContent = order.goods_name;
  $('payQty').textContent = `${order.qty} 张`;
  $('payStatus').textContent = '等待支付结果…';
  show('payModal');
  startPolling();
}

async function refreshPayStatus(silent) {
  if (!order) return;
  const { data, error } = await supa.rpc('rpc_order_lookup', {
    p_order_id: order.order_id, p_email: order.email,
  });
  if (error) { if (!silent) toast(errText(error)); return; }
  if (!data || data.found === false) {
    $('payStatus').textContent = data && data.throttled
      ? '查询过于频繁，请稍后手动点「我已支付」刷新'
      : '订单处理中…';
    return;
  }
  if (data.status === 'paid') {
    stopPolling();
    hide('payModal');
    deliver(data);
  } else if (data.status === 'cancelled') {
    stopPolling();
    hide('payModal');
    toast('订单已超时关闭，请重新下单');
    loadCatalog();
  } else {
    $('payStatus').textContent = `等待支付结果…（${new Date(Number(data.expires_at)).toLocaleTimeString()} 前有效）`;
  }
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refreshPayStatus(true), 4000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ---------- 发货展示 ---------- */
function deliver(data) {
  currentCards = Array.isArray(data.cards) ? data.cards : [];
  $('resultOrderId').textContent = data.order_id;
  const list = $('cardList');
  list.textContent = '';
  if (!currentCards.length) {
    list.appendChild(el('div', 'hint-line', '该商品卡密暂时不足，已记录待人工补发，请稍后凭订单号查询。'));
  }
  for (const c of currentCards) {
    const row = el('div', 'card-secret');
    const code = el('code', null, c);
    row.appendChild(code);
    const b = el('button', 'copy-one', '复制');
    b.type = 'button';
    b.addEventListener('click', () => copyText(c, b));
    row.appendChild(b);
    list.appendChild(row);
  }
  const all = $('copyAllBtn');
  all.style.display = currentCards.length ? 'block' : 'none';
  show('resultModal');
}

function copyText(text, btn) {
  const done = () => {
    toast('已复制');
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '✓ 已复制';
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
  } else {
    legacyCopy(text, done);
  }
}
function legacyCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择'); }
  document.body.removeChild(ta);
}

/* ---------- 订单查询 ---------- */
async function doQuery() {
  const orderId = $('queryOrderId').value.trim();
  const email = $('queryEmail').value.trim();
  const box = $('queryResult');
  if (!orderId || !email) { toast('请填写订单编号和下单邮箱'); return; }
  box.textContent = '';
  box.appendChild(el('div', 'empty', '查询中...'));
  const { data, error } = await supa.rpc('rpc_order_lookup', { p_order_id: orderId, p_email: email });
  box.textContent = '';
  if (error) { box.appendChild(el('div', 'hint-line', errText(error))); return; }
  if (!data || data.found === false) {
    box.appendChild(el('div', 'hint-line', data && data.throttled
      ? '查询次数过多，请一小时后再试'
      : '未找到匹配的订单（订单编号与邮箱需完全一致）'));
    return;
  }
  const info = el('div', 'pay-info');
  const rows = [
    ['商品', `${data.goods_name} × ${data.qty}`],
    ['金额', `¥${money(data.amount)}`],
    ['状态', { pending: '⏳ 待支付', paid: '✅ 已支付', cancelled: '❌ 已关闭' }[data.status] || data.status],
  ];
  for (const [k, v] of rows) {
    const r = el('div', 'row');
    r.appendChild(el('span', null, k));
    r.appendChild(el('b', null, v));
    info.appendChild(r);
  }
  box.appendChild(info);

  const cards = Array.isArray(data.cards) ? data.cards : [];
  if (data.status === 'paid' && cards.length) {
    for (const c of cards) {
      const row = el('div', 'card-secret');
      row.appendChild(el('code', null, c));
      const b = el('button', 'copy-one', '复制');
      b.type = 'button';
      b.addEventListener('click', () => copyText(c, b));
      row.appendChild(b);
      box.appendChild(row);
    }
  } else if (data.status === 'paid') {
    box.appendChild(el('div', 'hint-line', '卡密发放中，请稍后再查。'));
  } else {
    box.appendChild(el('div', 'hint-line', '支付完成后这里会显示卡密。'));
  }
}

/* ---------- 事件绑定（CSP 禁内联脚本，全部走 addEventListener） ---------- */
function bind() {
  document.querySelectorAll('[data-act="open-query"]').forEach((b) =>
    b.addEventListener('click', () => { $('queryResult').textContent = ''; show('queryModal'); }));
  document.querySelectorAll('[data-act="goto-admin"]').forEach((b) =>
    b.addEventListener('click', () => { location.href = 'admin.html'; }));
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => hide(b.getAttribute('data-close'))));
  document.querySelectorAll('.modal-mask').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'payModal') m.classList.remove('show'); }));

  $('qtyMinus').addEventListener('click', () => changeQty(-1));
  $('qtyPlus').addEventListener('click', () => changeQty(1));
  $('submitOrderBtn').addEventListener('click', submitOrder);
  $('payRefreshBtn').addEventListener('click', () => refreshPayStatus(false));
  $('copyAllBtn').addEventListener('click', () => copyText(currentCards.join('\n'), null));
  $('doQueryBtn').addEventListener('click', doQuery);
  $('queryEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') doQuery(); });
  $('buyEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitOrder(); });

  // 商品筛选：输入防抖 220ms，避免每敲一个字就重排上千个卡片
  const sb = $('searchBox');
  let sTimer = null;
  const applyKw = () => { keyword = (sb.value || '').trim().toLowerCase(); shown = PAGE_SIZE; paint(); };
  if (sb) {
    sb.addEventListener('input', () => { clearTimeout(sTimer); sTimer = setTimeout(applyKw, 220); });
    sb.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(sTimer); applyKw(); } });
  }
  const so = $('sortBox');
  if (so) so.addEventListener('change', () => { sortKey = so.value || 'new'; shown = PAGE_SIZE; paint(); });
  const bar = $('catBar');
  if (bar) bar.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('[data-cat]') : null;
    if (!b) return;
    catKey = b.getAttribute('data-cat') || '';
    shown = PAGE_SIZE;
    paint();
  });
  const mb = $('moreBtn');
  if (mb) mb.addEventListener('click', () => { shown += PAGE_SIZE; paint(); });
}

/* ---------- 推广邀请码 ----------
   只在本次标签页会话内保持：够覆盖"点推广链接 → 下单"，
   又不给访客挂一个跨会话的追踪标识。 */
const REF_RE = /^[A-Za-z0-9]{6,16}$/;
function captureRef() {
  try {
    const r = new URLSearchParams(location.search).get('ref');
    if (r && REF_RE.test(r.trim())) sessionStorage.setItem('FAKA_REF', r.trim().toUpperCase());
  } catch (e) { /* URL 异常时按无归因处理 */ }
}
function getRef() {
  try { return sessionStorage.getItem('FAKA_REF') || ''; } catch (e) { return ''; }
}

document.addEventListener('DOMContentLoaded', async () => {
  captureRef();
  bind();
  await loadSite();
  loadCatalog();
});
