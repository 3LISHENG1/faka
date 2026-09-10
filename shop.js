// 发卡商城 · 买家端
// 安全约定：本页不携带任何"标记已支付/改库存/改价格"的能力。
// 浏览器只能调用 4 个白名单 RPC，卡密只在订单已支付后由数据库发出。
'use strict';

const CFG = window.FAKA_CONFIG;
if (!CFG || !CFG.SUPA_URL || !CFG.SUPA_KEY) {
  document.getElementById('goodsGrid').innerHTML =
    '<div class="empty">请先编辑 assets/config.js 填写 Supabase 接口地址</div>';
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
  grid.textContent = '';
  if (!catalog.length) {
    grid.appendChild(el('div', 'empty', '暂无在售商品'));
    return;
  }
  for (const g of catalog) grid.appendChild(renderCard(g));
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

  const stockEl = el('div', 'goods-stock' + (stock <= 3 ? ' low' : ''),
    stock > 0 ? `库存 ${stock} 张` : '⚠️ 已售罄');
  box.appendChild(stockEl);

  const btn = el('button', 'btn btn-primary btn-block', stock > 0 ? '立即购买' : '暂时缺货');
  btn.disabled = stock <= 0;
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
  $('buyStock').textContent = String(Number(g.stock) || 0);
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
      p_goods_id: current.id, p_qty: qty, p_email: email,
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
}

document.addEventListener('DOMContentLoaded', async () => {
  bind();
  await loadSite();
  loadCatalog();
});
