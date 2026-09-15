// 发卡商城 · 管理后台
// 鉴权走 Supabase Auth：服务器签发真实 JWT，权限由数据库 RLS 判定。
// 旧版的 passwordHash 字符串比对与 sessionStorage 假 token 已全部删除。
'use strict';

const CFG = window.FAKA_CONFIG;
const supa = window.supabase.createClient(CFG.SUPA_URL, CFG.SUPA_KEY);

let goodsCache = [];
let goodsLoaded = false;
let skuIndex = null;
let lastCatalog = [];
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
  if (name === 'supplier') loadSupplier();
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
  const { data, error } = await supa.from('goods').select('*').order('created_at', { ascending: false }).limit(3000);
  if (error) { toast(errText(error)); return; }
  goodsCache = data || [];
  goodsLoaded = true;
  // 卡密归属一次取回来本地计数：逐行 count 在商品上百个时会把页面卡死
  const cardRows = await supa.from('cards').select('goods_id').eq('status', 0).limit(20000);
  const cardCount = {};
  for (const c of cardRows.data || []) cardCount[c.goods_id] = (cardCount[c.goods_id] || 0) + 1;
  const tbody = document.querySelector('#goodsTable tbody');
  tbody.textContent = '';
  $('goodsEmpty').style.display = goodsCache.length ? 'none' : 'block';
  for (const g of goodsCache) {
    const count = cardCount[g.id] || 0;
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
  $('gSupplier').value = g ? (g.supplier_sku_id || '') : '';
  if ($('gStatus')) $('gStatus').value = g ? String(g.status === 0 ? 0 : 1) : '1';
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
    supplier_sku_id: $('gSupplier').value.trim(),
  };
  if ($('gStatus')) payload.status = parseInt($('gStatus').value, 10);
  const b = $('saveGoodsBtn'); b.disabled = true;
  try {
    let r;
    if (id) r = await supa.from('goods').update(payload).eq('id', Number(id));
    else r = await supa.from('goods').insert(Object.assign({ sales: 0, created_at: Date.now() }, payload));
    if (r.error) { toast(errText(r.error)); return; }
    toast('保存成功'); $('goodsModal').classList.remove('show'); loadGoodsAdmin();
    refreshSkuIndex().then(() => renderCatalogList()).catch(() => {});
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

/* ---------- 货源对接（dujiao-next） ---------- */
async function loadSupplier() {
  const { data, error } = await supa.from('supplier_config').select('*').eq('id', 'supplier').maybeSingle();
  if (error) { toast(errText(error)); return; }
  const c = data || {};
  $('supEnabled').value = c.enabled ? '1' : '0';
  $('supBaseUrl').value = c.base_url || '';
  $('supApiKey').value = c.api_key || '';
}
async function saveSupplier() {
  const base = $('supBaseUrl').value.trim();
  if (base && !/^https:\/\/api\.|^https:\/\//i.test(base)) { toast('对接网址必须是 https:// 开头'); return; }
  const payload = {
    id: 'supplier',
    enabled: $('supEnabled').value === '1',
    base_url: base,
    api_key: $('supApiKey').value.trim(),
    updated_at: Date.now(),
  };
  const { error } = await supa.from('supplier_config').upsert(payload);
  toast(error ? errText(error) : '已保存。商户密钥请单独配到 Edge Function Secrets（见 README 第 3 步）。');
}
// 用原生 fetch 而不是 supa.functions.invoke：supabase-js 会额外带上
// X-Client-Info 请求头，若 Edge Function 的 CORS 白名单里没有它，
// 浏览器在预检阶段就把请求掐掉，表现为一律报
// "Failed to send a request to the Edge Function"。
// 这里只发 content-type + authorization 两个头，预检必然通过。
async function fnCall(body) {
  const { data } = await supa.auth.getSession();
  const jwt = data && data.session && data.session.access_token;
  if (!jwt) throw new Error('登录状态已失效，请重新登录后台');
  const res = await fetch(
    CFG.SUPA_URL.replace(/\/+$/, '') + '/functions/v1/supplier-fulfill',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 走下面的兜底 */ }
  if (!res.ok && !json) throw new Error('HTTP ' + res.status + '：' + text.slice(0, 160));
  return json;
}
async function pullCatalog() {
  const b = document.querySelector('[data-action="pull-catalog"]');
  const box = $('supCatalog');
  if (b) { b.disabled = true; b.textContent = '拉取中...'; }
  try {
    const data = await fnCall({ action: 'catalog' });
    if (!data || data.ok === false) {
      box.textContent = ''; lastCatalog = []; renderCatalogList();
      toast((data && (data.error_message || data.err)) || '拉取失败');
      return;
    }
    const items = data.items || [];
    lastCatalog = items;
    // 对方商品总数由函数回传，翻页没翻完就明确说「清单不完整」，不要让人误以为没货
    const meta = data.truncated
      ? `\n⚠️ 对方共 ${data.total} 个商品，本次只翻到前 ${data.fetched_products} 个，清单不完整，请重试或联系对方`
      : `\n共 ${items.length} 个可售 SKU（对方商品数 ${data.total ?? '?'}）`;
    box.textContent = (items.length
      ? 'sku_id | 标题 | 价格 | 库存 | 发货\n' + items.map((it) => `${it.sku_id} | ${it.title} | ¥${it.price} | ${it.stock}${it.delivery ? ' | ' + it.delivery : ''}`).join('\n')
      : '对方暂无在售商品') + meta;
    try { await refreshSkuIndex(); } catch (e) { toast('已建商品列表刷新失败：' + e.message); }
    renderCatalogList();
    toast('已拉取 ' + items.length + ' 条');
  } catch (e) {
    box.textContent = ''; lastCatalog = []; renderCatalogList();
    toast(String((e && e.message) || e || '请求失败'));
  } finally {
    if (b) { b.disabled = false; b.textContent = '拉取对方商品清单'; }
  }
}
// 建议零售价：进价按加价率上浮后向上取整再落到 X.9，比 12.42 这种数字好卖
function retailPrice(p, pct) {
  const v = Number(p) || 0;
  return Math.max(1, Math.ceil(v * (1 + pct))) - 0.1;
}
function markupPct() {
  const box = $('supMarkup');
  const n = box ? Number(box.value) : 30;
  return (Number.isFinite(n) ? Math.min(500, Math.max(0, n)) : 30) / 100;
}
// 标题开头的英文单词当分类，前台的分类筛选才有用
function guessCategory(title) {
  const m = String(title || '').match(/^[A-Za-z]{2,10}/);
  return m ? m[0] : '';
}
// 「已建」判断不能依赖商品列表缓存：商品表 loadGoodsAdmin 只取前 1000 行，
// 一旦超过就会漏判，批量建商品会造出重复商品。这里单独把全部
// supplier_sku_id 拉一遍（只取一列，很轻），分页取到干净为止。
async function existingSkus() {
  const set = new Set();
  for (let p = 0; p < 20; p++) {
    const { data, error } = await supa.from('goods').select('supplier_sku_id')
      .neq('supplier_sku_id', '').range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(errText(error));
    for (const r of data || []) set.add(String(r.supplier_sku_id));
    if (!data || data.length < 1000) break;
  }
  return set;
}
async function refreshSkuIndex() {
  skuIndex = await existingSkus();
  return skuIndex;
}function builtSkuSet() {
  if (skuIndex) return skuIndex;
  return new Set((goodsCache || []).map((g) => String(g.supplier_sku_id || '')).filter(Boolean));
}
// 关键词框同时作用于「列表显示」和「批量建商品」。
// 想知道对方到底有没有给某个类目（例如 苹果 / Apple），直接在这里搜即可。
function catalogFiltered() {
  const box = $('supFilter');
  const kw = (box ? box.value : '').trim().toLowerCase();
  if (!kw) return lastCatalog;
  return lastCatalog.filter((it) => `${it.sku_id} ${it.title || ''} ${it.delivery || ''}`.toLowerCase().includes(kw));
}
// 批量过程中实时把该行翻成「已建」，不然跑几百条时完全看不出进度落在哪
function markBuilt(skuId) {
  const row = document.querySelector(`#supCatalogList [data-sku="${skuId}"]`);
  if (!row || !row.children || !row.children.length) return;
  const last = row.children[row.children.length - 1];
  if (last.tagName === 'BUTTON') {
    const span = el('span', null, '已建');
    span.style.cssText = 'color:#16a34a';
    row.replaceChild(span, last);
  }
}function renderCatalogList() {
  const list = $('supCatalogList');
  if (!list) return;
  list.textContent = '';
  const shown = catalogFiltered();
  const head = el('div', null, lastCatalog.length
    ? `搜索匹配 ${shown.length} / 共 ${lastCatalog.length} 个 SKU（已建商品 ${builtSkuSet().size} 个）`
    : '先点上面「拉取对方商品清单」');
  head.style.cssText = 'font-size:12px;color:#64748b;padding:2px 0 6px';
  list.appendChild(head);
  const built = builtSkuSet();
  for (const it of shown.slice(0, 1000)) {
    const row = el('div');
    row.setAttribute('data-sku', String(it.sku_id));
    row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:4px 0;border-bottom:1px solid #f1f5f9;font-size:12px';
    const idCell = el('b', null, it.sku_id);
    idCell.style.minWidth = '76px';
    row.appendChild(idCell);
    const title = el('span', null, String(it.title || ''));
    title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    row.appendChild(title);
    row.appendChild(el('span', null, '进价¥' + it.price));
    row.appendChild(el('span', null, String(it.delivery || '')));
    if (built.has(String(it.sku_id))) row.appendChild(el('span', null, '已建'));
    else row.appendChild(btn('btn btn-ghost btn-sm', '建商品', () => quickGoods(it)));
    list.appendChild(row);
  }
  if (shown.length > 1000) list.appendChild(el('div', null, `…… 另有 ${shown.length - 1000} 条未显示，用关键词缩小范围`));
}
function quickGoods(it) {
  if (builtSkuSet().has(String(it.sku_id))) { toast('这个 SKU 已经建过商品了'); return; }
  openGoodsModal(null);
  $('goodsModalTitle').textContent = '添加商品（来自货源清单）';
  $('gName').value = String(it.title || '').slice(0, 40) || `货源商品 ${it.sku_id}`;
  $('gCover').value = '📱';
  $('gPrice').value = retailPrice(it.price, markupPct()).toFixed(2);
  $('gCategory').value = guessCategory(it.title);
  $('gDesc').value = '货源直发 · 付款后自动发货';
  $('gSupplier').value = String(it.sku_id);
  if ($('gStatus')) $('gStatus').value = '1';
  toast('已自动填好，确认名字和价格后点「保存商品」');
}
function goodsPayload(it) {
  return {
    name: String(it.title || '').slice(0, 40) || `货源商品 ${it.sku_id}`,
    cover: '📱',
    price: Math.round(retailPrice(it.price, markupPct()) * 100),
    category: guessCategory(it.title),
    description: '货源直发 · 付款后自动发货',
    supplier_sku_id: String(it.sku_id),
    status: 1,
    sales: 0,
    created_at: Date.now(),
  };
}
// 批量建：只处理「关键词命中 + 还没建过」的行，逐条插入并实时报进度
async function bulkGoods() {
  if (!lastCatalog.length) { toast('先点「拉取对方商品清单」'); return; }
  // 判重要取全库的 supplier_sku_id，不能用只取 1000 行的商品列表缓存
  try { await refreshSkuIndex(); } catch (e) { toast('取已建商品失败：' + e.message); return; }
  const built = builtSkuSet();
  const todo = catalogFiltered().filter((it) => !built.has(String(it.sku_id)));
  if (!todo.length) { toast('没有「关键词命中且未建过」的商品'); return; }
  const manual = todo.filter((it) => String(it.delivery || '') === '人工').length;
  const msg = `将为 ${todo.length} 个 SKU 建商品（进价 +${Math.round(markupPct() * 100)}% 定价）`
    + `\n全清单 ${lastCatalog.length} 条，已建过的 ${built.size} 个自动跳过`
    + (manual ? `\n其中 ${manual} 个是「人工」发货，买家要等客服` : '')
    + '\n\n确定继续？';
  if (!confirm(msg)) return;
  const b = document.querySelector('[data-action="bulk-goods"]');
  if (b) b.disabled = true;
  let ok = 0; let fail = 0; let firstErr = '';
  for (let i = 0; i < todo.length; i++) {
    if ($('supBulkStat')) $('supBulkStat').textContent = `进行中 ${i + 1}/${todo.length}`;
    const r = await supa.from('goods').insert(goodsPayload(todo[i]));
    if (r.error) { fail++; if (!firstErr) firstErr = errText(r.error); } else { ok++; markBuilt(todo[i].sku_id); }
  }
  if (b) b.disabled = false;
  if ($('supBulkStat')) $('supBulkStat').textContent = `新建 ${ok}${fail ? '，失败 ' + fail : ''}`;
  toast(fail ? `完成 ${ok} 条，失败 ${fail} 条：${firstErr}` : `已新建 ${ok} 个商品，去「商品管理」看`);
  await loadGoodsAdmin();
  renderCatalogList();
}/* ---------- 事件绑定 ---------- */
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
    if (a === 'save-supplier') b.addEventListener('click', saveSupplier);
    if (a === 'pull-catalog') b.addEventListener('click', pullCatalog);
    if (a === 'bulk-goods') b.addEventListener('click', bulkGoods);
  });
  const sf = $('supFilter');
  if (sf) sf.addEventListener('input', renderCatalogList);
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

/* ================= 推广返佣（一级） ================= */
const SITE_URL = location.href.replace(/[^/]*$/, '');   // 用于拼推广链接

async function loadAgents() {
  const { data: agents, error } = await supa.from('agents').select('*').order('created_at', { ascending: false });
  if (error) { toast(errText(error)); return; }
  const tbody = document.querySelector('#agentsTable tbody');
  tbody.textContent = '';
  $('agentsEmpty').style.display = (agents || []).length ? 'none' : 'block';
  for (const a of agents || []) {
    const { data: sum } = await supa.from('agent_earnings')
      .select('commission').eq('agent_id', a.id).eq('status', 'pending');
    const pending = (sum || []).reduce((s, r) => s + Number(r.commission || 0), 0);
    const tr = el('tr');
    const codeTd = el('td', 'td-wrap');
    codeTd.appendChild(el('b', null, a.code));
    const link = SITE_URL + '?ref=' + a.code;
    codeTd.appendChild(el('div', 'sub', link));
    tr.appendChild(codeTd);
    tr.appendChild(el('td', null, a.name));
    tr.appendChild(el('td', null, (a.rate_bp / 100).toFixed(2) + '%'));
    tr.appendChild(el('td', null, '¥' + money(pending)));
    tr.appendChild(el('td', null, a.status === 1 ? '启用中' : '已停用'));
    const ops = el('td');
    ops.appendChild(btn('btn btn-ghost btn-sm', '复制链接', () => copyText(link)));
    ops.appendChild(document.createTextNode(' '));
    ops.appendChild(btn(a.status === 1 ? 'btn btn-danger btn-sm' : 'btn btn-ghost btn-sm',
      a.status === 1 ? '停用' : '启用', async () => {
      if (a.status === 1 && !confirm('停用「' + a.name + '」？停用后新订单不再计佣，历史台账保留。')) return;
      const r = await supa.from('agents').update({ status: a.status === 1 ? 0 : 1 }).eq('id', a.id);
      if (r.error) { toast(errText(r.error)); return; }
      toast('已更新'); loadAgents();
    }));
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}

async function addAgent() {
  const code = $('agCode').value.trim().toUpperCase();
  const name = $('agName').value.trim();
  const rate = parseFloat($('agRate').value);
  if (!/^[A-Z0-9]{6,16}$/.test(code)) { toast('邀请码需为 6-16 位字母或数字'); return; }
  if (!name) { toast('请填写昵称'); return; }
  if (!Number.isFinite(rate) || rate < 0 || rate > 30) { toast('返佣比例 0~30%'); return; }
  const { error } = await supa.from('agents').insert({
    code, name, contact: $('agContact').value.trim(),
    rate_bp: Math.round(rate * 100), status: 1,
    created_at: Date.now(),
  });
  if (error) { toast(error.message.includes('duplicate') || error.message.includes('unique') ? '该邀请码已存在' : errText(error)); return; }
  ['agCode', 'agName', 'agContact'].forEach((id) => { $(id).value = ''; });
  $('agRate').value = '10';
  toast('已创建推广员'); loadAgents();
}

async function loadEarnings() {
  const status = $('earnFilter').value;
  let q = supa.from('agent_earnings').select('*').order('created_at', { ascending: false }).limit(300);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) { toast(errText(error)); return; }
  const tbody = document.querySelector('#earningsTable tbody');
  tbody.textContent = '';
  $('earningsEmpty').style.display = (data || []).length ? 'none' : 'block';
  for (const r of data || []) {
    const tr = el('tr');
    tr.appendChild(el('td', 'td-wrap', r.order_id));
    tr.appendChild(el('td', null, r.agent_code));
    tr.appendChild(el('td', null, '¥' + money(r.order_amount)));
    tr.appendChild(el('td', null, (r.rate_bp / 100).toFixed(2) + '%'));
    tr.appendChild(el('td', null, '¥' + money(r.commission)));
    tr.appendChild(el('td', null, { pending: '待结', settled: '已结', void: '已作废' }[r.status] || r.status));
    const ops = el('td');
    if (r.status === 'pending') {
      ops.appendChild(btn('btn btn-primary btn-sm', '标记已结', async () => {
        const note = prompt('备注（线下转账单号/渠道，可留空）：', '') ;
        if (note === null) return;
        const u = await supa.from('agent_earnings')
          .update({ status: 'settled', settled_at: Date.now(), settle_note: note.trim() })
          .eq('id', r.id).eq('status', 'pending');   // 二次条件：并发下不会重复标记
        if (u.error) { toast(errText(u.error)); return; }
        toast('已标记'); loadEarnings(); loadAgents();
      }));
      ops.appendChild(document.createTextNode(' '));
      ops.appendChild(btn('btn btn-danger btn-sm', '作废', async () => {
        // 只作废 pending：已结说明钱已付出去，作废会造成账实不符
        const why = prompt('作废原因（必填，留档备查）。例如：测试数据 / 买家已退款 / 归因有误', '');
        if (why === null) return;
        if (!why.trim()) { toast('请填写作废原因'); return; }
        const u = await supa.from('agent_earnings')
          .update({ status: 'void', settle_note: why.trim().slice(0, 200) })
          .eq('id', r.id).eq('status', 'pending');   // 二次条件：不会把已结的行改成作废
        if (u.error) { toast(errText(u.error)); return; }
        toast('已作废'); loadEarnings(); loadAgents();
      }));
    } else ops.appendChild(el('span', 'sub',
      r.status === 'void' ? (r.settle_note || '已作废') : (r.settled_at ? fmtTime(r.settled_at) : '-')));
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}

function copyText(text) {
  const done = () => toast('已复制推广链接');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {});
  else {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中'); }
    document.body.removeChild(ta);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('.nav-item[data-view="agents"]');
  if (nav) nav.addEventListener('click', () => { loadAgents(); loadEarnings(); });
  const ab = document.querySelector('[data-action="add-agent"]');
  if (ab) ab.addEventListener('click', addAgent);
  const ef = $('earnFilter');
  if (ef) ef.addEventListener('change', loadEarnings);
});
