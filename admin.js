// 发卡商城 · 管理后台
// 鉴权走 Supabase Auth：服务器签发真实 JWT，权限由数据库 RLS 判定。
// 旧版的 passwordHash 字符串比对与 sessionStorage 假 token 已全部删除。
'use strict';

const CFG = window.FAKA_CONFIG;
const supa = window.supabase.createClient(CFG.SUPA_URL, CFG.SUPA_KEY);

let goodsCache = [];
let orderCache = [];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function btn(cls, text, fn) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
const $ = (id) => document.getElementById(id);
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const money = (fen) => ((Number(fen) || 0) / 100).toFixed(2);
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(Number(ts)), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function errText(err) {
  const m = String((err && err.message) || err || '');
  if (m.includes('Invalid login credentials')) return '邮箱或密码错误';
  if (m.includes('rate limit')) return '尝试过于频繁，请稍后再试';
  if (m.includes('permission denied') || m.includes('row-level security')) return '没有权限（该账号未登记为管理员）';
  return m || '操作失败';
}
const statusTag = (s) => ({ paid: '已支付', pending: '待支付', cancelled: '已关闭' }[s] || s);

/* ---------- 视图切换 ---------- */
function showLogin() { $('loginView').style.display = 'flex'; $('appView').style.display = 'none'; }
function showApp() { $('loginView').style.display = 'none'; $('appView').style.display = 'block'; }

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => { v.style.display = 'none'; });
  const target = $('view-' + name);
  if (target) target.style.display = 'block';
  document.querySelectorAll('.nav-item[data-view]').forEach((n) =>
    n.classList.toggle('active', n.getAttribute('data-view') === name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'goods') loadGoodsAdmin();
  if (name === 'cards') { loadGoodsForSelect().then(loadCards); }
  if (name === 'orders') loadOrders();
  if (name === 'settings') loadSiteSettings();
}

/* ---------- 登录 / 会话 ---------- */
async function doLogin() {
  const email = $('loginEmail').value.trim();
  const password = $('loginPwd').value;
  const b = $('loginBtn');
  if (!email || !password) { toast('请输入邮箱和密码'); return; }
  b.disabled = true; b.textContent = '登录中...';
  try {
    const { error } = await supa.auth.signInWithPassword({ email, password });
    if (error) { toast(errText(error)); return; }
    const { data } = await supa.auth.getUser();
    const uid = data && data.user && data.user.id;
    // auth.users 里能登录 ≠ 管理员；还必须在 admin_users 中登记（由 RLS 强制）
    const chk = await supa.from('admin_users').select('user_id').eq('user_id', uid).maybeSingle();
    if (chk.error || !chk.data) {
      await supa.auth.signOut();
      toast('该账号未登记为管理员，无法进入后台');
      return;
    }
    showApp(); boot();
  } finally { b.disabled = false; b.textContent = '登 录'; }
}
async function logout() { await supa.auth.signOut(); location.reload(); }

function boot() {
  loadDashboard(); loadGoodsAdmin(); loadGoodsForSelect().then(loadCards); loadOrders(); loadSiteSettings();
}

/* ---------- 仪表盘 ---------- */
function statRow(numId, label) { return [numId, label]; }
async function loadDashboard() {
  const [{ data: orders, error: e1 }, { count: goodsCount }, { count: stockCount }] = await Promise.all([
    supa.from('orders').select('status,amount,paid_at').order('created_at', { ascending: false }).limit(2000),
    supa.from('goods').select('id', { count: 'exact', head: true }).eq('status', 1),
    supa.from('cards').select('id', { count: 'exact', head: true }).eq('status', 0),
  ]);
  if (e1) { toast(errText(e1)); return; }
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  let total = 0, today = 0, todayCount = 0;
  for (const o of orders || []) {
    if (o.status !== 'paid') continue;
    total += Number(o.amount) || 0;
    if (Number(o.paid_at) >= todayStart.getTime()) { today += Number(o.amount) || 0; todayCount++; }
  }
  $('stTodayAmount').textContent = '¥' + money(today);
  $('stTodayOrders').textContent = String(todayCount);
  $('stGoods').textContent = String(goodsCount || 0);
  $('stStock').textContent = String(stockCount || 0);
  $('stTotalAmount').textContent = '¥' + money(total);

  const tbody = document.querySelector('#recentTable tbody');
  tbody.textContent = '';
  const recent = (orders || []).slice(0, 5);
  $('recentEmpty').style.display = recent.length ? 'none' : 'block';
  for (const o of recent) {
    const tr = el('tr');
    for (const v of [o.order_id, o.goods_name, o.qty, '¥' + money(o.amount)]) tr.appendChild(el('td', 'td-wrap', v));
    tr.appendChild(el('td', null, statusTag(o.status)));
    tr.appendChild(el('td', null, fmtTime(o.created_at)));
    tbody.appendChild(tr);
  }
}

/* ---------- 商品 ---------- */
async function loadGoodsAdmin() {
  const { data, error } = await supa.from('goods').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) { toast(errText(error)); return; }
  goodsCache = data || [];
  const tbody = document.querySelector('#goodsTable tbody');
  tbody.textContent = '';
  $('goodsEmpty').style.display = goodsCache.length ? 'none' : 'block';
  for (const g of goodsCache) {
    const { count } = await supa.from('cards').select('id', { count: 'exact', head: true }).eq('goods_id', g.id).eq('status', 0);
    const tr = el('tr');
    tr.appendChild(el('td', null, (g.cover || '🎁') + ' ' + g.name));
    tr.appendChild(el('td', null, g.category || '-'));
    tr.appendChild(el('td', null, '¥' + money(g.price)));
    tr.appendChild(el('td', null, String(count || 0)));
    tr.appendChild(el('td', null, String(g.sales || 0)));
    tr.appendChild(el('td', null, g.status === 1 ? '上架中' : '已下架'));
    const ops = el('td');
    ops.appendChild(btn('btn btn-ghost btn-sm', '编辑', () => openGoodsModal(g)));
    ops.appendChild(document.createTextNode(' '));
    ops.appendChild(btn('btn btn-danger btn-sm', '删除', () => deleteGoods(g)));
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  loadGoodsForSelect();
}
function openGoodsModal(g) {
  $('goodsModalTitle').textContent = g ? '编辑商品' : '添加商品';
  $('goodsId').value = g ? String(g.id) : '';
  $('gName').value = g ? g.name : '';
  $('gCover').value = g ? (g.cover || '') : '🎁';
  $('gPrice').value = g ? money(g.price) : '';
  $('gCategory').value = g ? (g.category || '') : '';
  $('gDesc').value = g ? (g.description || '') : '';
  $('gStatus').value = g ? String(g.status) : '1';
  $('goodsModal').classList.add('show');
}
async function saveGoods() {
  const id = $('goodsId').value;
  const name = $('gName').value.trim();
  const price = parseFloat($('gPrice').value);
  if (!name) { toast('请填写商品名称'); return; }
  if (!price || price <= 0) { toast('请填写正确的价格'); return; }
  const payload = {
    name, cover: $('gCover').value || '🎁', price: Math.round(price * 100),
    category: $('gCategory').value.trim(), description: $('gDesc').value.trim(),
    status: parseInt($('gStatus').value, 10),
  };
  const b = $('saveGoodsBtn'); b.disabled = true;
  try {
    let r;
    if (id) r = await supa.from('goods').update(payload).eq('id', Number(id));
    else r = await supa.from('goods').insert(Object.assign({ sales: 0, created_at: Date.now() }, payload));
    if (r.error) { toast(errText(r.error)); return; }
    toast('保存成功'); $('goodsModal').classList.remove('show'); loadGoodsAdmin();
  } finally { b.disabled = false; }
}
async function deleteGoods(g) {
  if (!confirm(`删除商品「${g.name}」？其未售出卡密会一并删除。`)) return;
  const r1 = await supa.from('cards').delete().eq('goods_id', g.id).eq('status', 0);
  if (r1.error) { toast(errText(r1.error)); return; }
  const r2 = await supa.from('goods').delete().eq('id', g.id);
  if (r2.error) { toast(errText(r2.error)); return; }
  toast('已删除'); loadGoodsAdmin();
}
async function loadGoodsForSelect() {
  if (!goodsCache.length) {
    const { data } = await supa.from('goods').select('id,name').order('created_at', { ascending: false }).limit(200);
    goodsCache = data || [];
  }
  for (const sid of ['filterGoodsSelect', 'importGoodsSelect']) {
    const s = $(sid); if (!s) continue;
    const keep = s.value;
    s.textContent = '';
    if (sid === 'filterGoodsSelect') s.appendChild(new Option('全部商品', ''));
    for (const g of goodsCache) s.appendChild(new Option(g.name, String(g.id)));
    s.value = keep;
  }
}

/* ---------- 卡密 ---------- */
async function importCards() {
  const goodsId = $('importGoodsSelect').value;
  const raw = $('importCards').value;
  if (!goodsId) { toast('请先选择商品'); return; }
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) { toast('请粘贴卡密'); return; }
  if (lines.length > 500) { toast('单次最多 500 条'); return; }
  let added = 0, firstErr = null;
  for (let i = 0; i < lines.length; i += 100) {
    const batch = lines.slice(i, i + 100).map((line) => ({
      goods_id: Number(goodsId), content: line, status: 0, order_id: '', sold_at: 0, created_at: Date.now(),
    }));
    const { error } = await supa.from('cards').insert(batch);
    if (error) { firstErr = error; break; }
    added += batch.length;
  }
  toast(firstErr ? '导入中断：' + errText(firstErr) : `成功导入 ${added} 条卡密`);
  if (!firstErr) $('importCards').value = '';
  loadGoodsAdmin();
}
async function loadCards() {
  const goodsId = $('filterGoodsSelect').value;
  const status = $('filterStatus').value;
  let q = supa.from('cards').select('*').order('created_at', { ascending: false }).limit(200);
  if (goodsId) q = q.eq('goods_id', Number(goodsId));
  if (status !== '') q = q.eq('status', parseInt(status, 10));
  const { data, error } = await q;
  if (error) { toast(errText(error)); return; }
  const nameOf = {}; goodsCache.forEach((g) => { nameOf[g.id] = g.name; });
  const tbody = document.querySelector('#cardsTable tbody');
  tbody.textContent = '';
  $('cardsEmpty').style.display = (data || []).length ? 'none' : 'block';
  for (const row of data || []) {
    const tr = el('tr');
    tr.appendChild(el('td', 'td-wrap', row.content));
    tr.appendChild(el('td', 'td-wrap', nameOf[row.goods_id] || '-'));
    tr.appendChild(el('td', null, { 2: '已售出', 1: '锁定中' }[row.status] || '未售出'));
    tr.appendChild(el('td', null, fmtTime(row.created_at)));
    const ops = el('td');
    if (row.status === 0) ops.appendChild(btn('btn btn-danger btn-sm', '删除', async () => {
      if (!confirm('删除这条卡密？')) return;
      const r = await supa.from('cards').delete().eq('id', row.id);
      if (r.error) { toast(errText(r.error)); return; }
      toast('已删除'); loadCards();
    }));
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}

/* ---------- 订单 ---------- */
async function loadOrders() {
  const status = $('orderStatusFilter').value;
  let q = supa.from('orders').select('*').order('created_at', { ascending: false }).limit(200);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) { toast(errText(error)); return; }
  orderCache = data || [];
  const tbody = document.querySelector('#ordersTable tbody');
  tbody.textContent = '';
  $('ordersEmpty').style.display = orderCache.length ? 'none' : 'block';
  for (const o of orderCache) {
    const tr = el('tr');
    for (const v of [o.order_id, o.goods_name, o.qty, '¥' + money(o.amount), o.email, statusTag(o.status), fmtTime(o.created_at)])
      tr.appendChild(el('td', 'td-wrap', v));
    const ops = el('td');
    ops.appendChild(btn('btn btn-ghost btn-sm', '详情', () => viewOrder(o)));
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}
function viewOrder(o) {
  const box = $('orderDetail');
  box.textContent = '';
  const info = el('div', 'pay-info');
  const rows = [['订单号', o.order_id], ['商品', `${o.goods_name} × ${o.qty}`], ['金额', '¥' + money(o.amount)],
    ['邮箱', o.email], ['状态', statusTag(o.status)], ['渠道', o.channel || '-'], ['交易号', o.txn_id || '-'],
    ['下单时间', fmtTime(o.created_at)], ['支付时间', fmtTime(o.paid_at)]];
  for (const [k, v] of rows) { const r = el('div', 'row'); r.appendChild(el('span', null, k)); r.appendChild(el('b', null, v)); info.appendChild(r); }
  box.appendChild(info);
  const cards = Array.isArray(o.cards) ? o.cards : [];
  if (o.delivery_incomplete) box.appendChild(el('div', 'demo-tip', '⚠️ 已收款但卡密不足，需人工补发'));
  if (cards.length) {
    box.appendChild(el('div', 'hint', '发货卡密：'));
    for (const c of cards) { const d = el('div', 'card-secret'); d.appendChild(el('code', null, c)); box.appendChild(d); }
  }
  $('orderModal').classList.add('show');
}

/* ---------- 站点设置 ---------- */
async function loadSiteSettings() {
  const { data, error } = await supa.from('settings').select('data').eq('id', 'site').maybeSingle();
  if (error) { toast(errText(error)); return; }
  const s = (data && data.data) || {};
  $('setSiteName').value = s.siteName || '';
  $('setAnnouncement').value = s.announcement || '';
  $('setContact').value = s.contact || '';
}
async function saveSite() {
  const payload = { siteName: $('setSiteName').value || '发卡商城', announcement: $('setAnnouncement').value, contact: $('setContact').value };
  const { error } = await supa.from('settings').update({ data: payload }).eq('id', 'site');
  toast(error ? errText(error) : '保存成功，买家商城刷新后生效');
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $('loginBtn').addEventListener('click', doLogin);
  $('loginPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.querySelectorAll('.nav-item[data-view]').forEach((n) =>
    n.addEventListener('click', () => switchView(n.getAttribute('data-view'))));
  document.querySelectorAll('[data-action]').forEach((b) => {
    const a = b.getAttribute('data-action');
    if (a === 'logout') b.addEventListener('click', logout);
    if (a === 'shop') b.addEventListener('click', () => { location.href = 'index.html'; });
    if (a === 'add-goods') b.addEventListener('click', () => openGoodsModal(null));
    if (a === 'save-goods') b.addEventListener('click', saveGoods);
    if (a === 'import-cards') b.addEventListener('click', importCards);
    if (a === 'save-site') b.addEventListener('click', saveSite);
  });
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => $(b.getAttribute('data-close')).classList.remove('show')));
  document.querySelectorAll('.modal-mask').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); }));
  ['filterGoodsSelect', 'filterStatus'].forEach((id) => $(id) && $(id).addEventListener('change', loadCards));
  $('orderStatusFilter') && $('orderStatusFilter').addEventListener('change', loadOrders);
}

document.addEventListener('DOMContentLoaded', async () => {
  bind();
  const { data } = await supa.auth.getSession();
  const sess = data && data.session;
  if (!sess) { showLogin(); return; }
  const { data: adm } = await supa.from('admin_users').select('user_id').eq('user_id', sess.user.id).maybeSingle();
  if (adm && adm.data) { showApp(); boot(); } else showLogin();
});
