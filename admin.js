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
let memberCache = [];
// 提示框 / 单元格里的换行：统一用它，别在字符串里写 \n
const NL = String.fromCharCode(10);

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
  if (name === 'goods') { loadGoodsAdmin().then(() => { fillLkCats(); listingHistory(); }); lkSyncUI(); }
  if (name === 'cards') { loadGoodsForSelect().then(loadCards); }
  if (name === 'orders') loadOrders();
  if (name === 'settings') loadSiteSettings();
  if (name === 'members') { loadMemberSettings(); loadMembers(); }
  if (name === 'supplier') loadSupplier();
  if (name === 'wallet') { loadWalletSettings(); loadRecharges(); }
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
let goodsCardCount = {};
// 商品列表分页：一次渲染上千行会把浏览器卡死（第 20 步补）
let goodsPage = 0;
let goodsPageSize = 50;
function goodsPages(list) {
  const size = goodsPageSize > 0 ? goodsPageSize : 50;
  const n = list && list.length ? list.length : 0;
  return { size, pages: Math.max(1, Math.ceil(n / size)) };
}
function goodsStep(d) {
  const pg = goodsPages(goodsFilteredList());
  const n = Math.min(pg.pages - 1, Math.max(0, goodsPage + d));
  if (n === goodsPage) { toast(d < 0 ? `已经是第一页` : `已经是最后一页`); return; }
  goodsPage = n;
  renderGoodsAdmin();
}
function goodsSetSize(n) {
  goodsPageSize = Number(n) > 0 ? Number(n) : 50;
  goodsPage = 0;
  renderGoodsAdmin();
}

// 库存列：代发商品显示「对方库存 + 进价/毛利」，自营商品显示本店未售出卡密数。
// 以前这一列只数卡密，代发商品本店卡密恒为 0，看起来就像没有库存。
function stockCell(g, ownCount) {
  const sku = String(g.supplier_sku_id || "").trim();
  if (!sku) return el("td", null, String(ownCount || 0));
  const td = el("td");
  const q = Number(g.supplier_stock);
  const online = g.supplier_online !== false;
  let text = "不限量";
  let color = "#16a34a";
  if (!online) { text = "对方下架"; color = "#dc2626"; }
  else if (q === 0) { text = "缺货"; color = "#dc2626"; }
  else if (q > 0) { text = "剩 " + q; color = q <= 5 ? "#d97706" : "#16a34a"; }
  const big = el("b", null, text);
  big.style.cssText = "color:" + color + ";font-weight:700";
  td.appendChild(big);
  const cost = Number(g.supplier_cost) || 0;
  const price = Number(g.price) || 0;
  const tip = (cost > 0 ? `进价¥${money(cost)} · 一单赚¥${money(price - cost)}` : "进价未同步")
    + ` · SKU ${sku}`;
  const small = el("span", null, tip);
  small.style.cssText = "display:block;font-size:11px;color:"
    + (cost > 0 && price < cost ? "#dc2626" : "#94a3b8");
  td.appendChild(small);
  return td;
}

function goodsFilteredList() {
  const kw = (($("goodsFilter") && $("goodsFilter").value) || "").trim().toLowerCase();
  const fk = ($("goodsStockFilter") && $("goodsStockFilter").value) || "";
  return (goodsCache || []).filter((g) => {
    const sku = String(g.supplier_sku_id || "").trim();
    const q = Number(g.supplier_stock);
    if (fk === "drop" && !sku) return false;
    if (fk === "own" && sku) return false;
    if (fk === "oos" && !(sku && (q === 0 || g.supplier_online === false))) return false;
    if (fk === "low" && !(sku && q > 0 && q <= 5)) return false;
    if (!kw) return true;
    return `${g.name || ""} ${g.category || ""} ${sku}`.toLowerCase().includes(kw);
  });
}

function renderGoodsAdmin() {
  const tbody = document.querySelector("#goodsTable tbody");
  if (!tbody) return;
  tbody.textContent = "";
  const all = goodsCache || [];
  const list = goodsFilteredList();
  const drop = all.filter((g) => String(g.supplier_sku_id || "").trim()).length;
  const stat = $("goodsStat");
  if (stat) {
    stat.textContent = (list.length === all.length ? `共 ${all.length} 个商品` : `筛出 ${list.length} / 共 ${all.length} 个`)
      + `（代发 ${drop} · 本店卡密 ${all.length - drop}）`;
  }
  $("goodsEmpty").textContent = all.length ? "没有符合筛选条件的商品" : "还没有商品";
  $("goodsEmpty").style.display = list.length ? "none" : "block";
  const pg = goodsPages(list);
  if (goodsPage > pg.pages - 1) goodsPage = pg.pages - 1;
  if (goodsPage < 0) goodsPage = 0;
  const from = goodsPage * pg.size;
  const rows = list.slice(from, from + pg.size);
  goodsPagerUI(list, pg, from, rows.length);
  for (const g of rows) {
    const sku = String(g.supplier_sku_id || "").trim();
    const tr = el("tr");
    tr.appendChild(el("td", null, (g.cover || "🎁") + " " + g.name));
    tr.appendChild(el("td", null, g.category || "-"));
    tr.appendChild(el("td", null, "¥" + money(g.price)));
    tr.appendChild(stockCell(g, goodsCardCount[g.id] || 0));
    tr.appendChild(el("td", null, String(g.sales || 0)));
    const autoOff = Boolean(sku) && g.supplier_auto_off === true;
    const st = el("td", null, g.status === 1 ? "上架中" : (autoOff ? "缺货自动下架" : "已下架"));
    if (g.status !== 1) st.style.color = autoOff ? "#dc2626" : "#94a3b8";
    tr.appendChild(st);
    const ops = el("td");
    ops.appendChild(btn("btn btn-ghost btn-sm", "编辑", () => openGoodsModal(g)));
    ops.appendChild(document.createTextNode(" "));
    ops.appendChild(btn("btn btn-danger btn-sm", "删除", () => deleteGoods(g)));
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}

function goodsPagerUI(list, pg, from, shown) {
  const box = $("goodsPagerItem");
  if (box) box.style.display = list.length > pg.size ? "" : "none";
  const stat = $("goodsPageStat");
  if (stat) {
    stat.textContent = list.length
      ? `第 ${from + 1}-${from + shown} 个 / 共 ${list.length} 个 · 第 ${goodsPage + 1} / ${pg.pages} 页（每页 ${pg.size}）`
      : "";
  }
  const pv = document.querySelector('[data-action="goods-prev"]');
  const nx = document.querySelector('[data-action="goods-next"]');
  if (pv) pv.disabled = goodsPage <= 0;
  if (nx) nx.disabled = goodsPage >= pg.pages - 1;
}

async function loadGoodsAdmin() {
  const { data, error } = await supa.from("goods").select("*").order("created_at", { ascending: false }).limit(3000);
  if (error) { toast(errText(error)); return; }
  goodsCache = data || [];
  goodsLoaded = true;
  // 卡密归属一次取回来本地计数：逐行 count 在商品上百个时会把页面卡死
  const cardRows = await supa.from("cards").select("goods_id").eq("status", 0).limit(20000);
  goodsCardCount = {};
  for (const c of cardRows.data || []) goodsCardCount[c.goods_id] = (goodsCardCount[c.goods_id] || 0) + 1;
  renderGoodsAdmin();
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
  $('gDetail').value = g ? (g.detail || '') : '';
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
    detail: $('gDetail').value.trim(),
    supplier_sku_id: $('gSupplier').value.trim(),
  };
  if ($('gStatus')) payload.status = parseInt($('gStatus').value, 10);
  payload.supplier_auto_off = false; // 人工改过上架状态，就别再自动翻回来
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
  // settings.data 是一整块 jsonb：先读回来合并，免得把「会员推广」那几个键一起覆盖掉
  const { data: cur } = await supa.from('settings').select('data').eq('id', 'site').maybeSingle();
  const merged = Object.assign({}, (cur && cur.data) || {}, payload);
  const { error } = await supa.from('settings').update({ data: merged }).eq('id', 'site');
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
  if ($('supMinMarkup')) $('supMinMarkup').value = String(c.min_markup_pct === null || c.min_markup_pct === undefined ? 30 : c.min_markup_pct);
  if ($('supAutoDelist')) $('supAutoDelist').value = c.auto_delist === false ? '0' : '1';
  if ($('supSyncCost')) $('supSyncCost').value = c.sync_cost === true ? '1' : '0';
  const alert = $('supAlert');
  if (alert) {
    const lines = [];
    if (c.paused_reason) lines.push('🛑 ' + c.paused_reason);
    if (c.last_sync_note) lines.push('📦 ' + c.last_sync_note + '（' + (c.last_sync_at ? new Date(Number(c.last_sync_at)).toLocaleString() : '?') + '）');
    let oos = 0; let off = 0;
    try {
      const a = await supa.from('goods').select('id', { count: 'exact', head: true }).neq('supplier_sku_id', '').eq('supplier_stock', 0);
      const b2 = await supa.from('goods').select('id', { count: 'exact', head: true }).neq('supplier_sku_id', '').eq('status', 0).eq('supplier_auto_off', true);
      if (!a.error) oos = a.count || 0;
      if (!b2.error) off = b2.count || 0;
    } catch (e) { /* 新字段还没建时忽略 */ }
    const scanned = Number(c.sync_page) > 0
      ? '库存扫描进行中（第 ' + c.sync_page + ' 页）'
      : (Number(c.last_sync_at) ? '库存已扫完一轮' : '还没同步过库存，点「同步库存」');
    lines.push('📊 对方缺货 ' + oos + ' 个｜系统自动下架 ' + off + ' 个｜' + scanned);
    lines.push(c.sync_cost === true
      ? '🔧 同步范围：库存 + 进价（进价上涨会自动抬售价，最低加价率 ' + (Number(c.min_markup_pct) || 30) + '%）'
      : '🔧 同步范围：只同步库存，进价和售价都不动（要自动抬价就把「同步范围」切成同步库存 + 进价）');
    alert.textContent = lines.join('\n');
    alert.style.display = 'block';
    alert.style.borderLeft = c.paused_reason ? '3px solid #dc2626' : '3px solid #6366f1';
  }
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
  payload.min_markup_pct = Number($('supMinMarkup') ? $('supMinMarkup').value : 30) || 0;
  payload.auto_delist = $('supAutoDelist') ? $('supAutoDelist').value === '1' : true;
  payload.sync_cost = $('supSyncCost') ? $('supSyncCost').value === '1' : false;
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
// 库存同步：服务端一次只翻一页，这里循环点到 done，实时报进度
async function syncStock() {
  const b = document.querySelector('[data-action="sync-stock"]');
  const stat = $('supSyncStat');
  if (b) b.disabled = true;
  try {
    for (let i = 1; i <= 200; i++) {
      if (stat) stat.textContent = '同步中… 第 ' + i + ' 页';
      const data = await fnCall({ action: 'sync' });
      if (!data || data.ok !== true) throw new Error((data && data.error_message) || '返回异常');
      if (!data.sync) throw new Error("函数没返回同步结果：多半是 Edge Function 还是旧版，按 README 第 5 步重新粘贴部署");
      const s = data.sync;
      if (!s.ok) throw new Error(s.error_message || '同步中断');
      if (s.done) { if (stat) stat.textContent = s.note || '同步完成'; toast('库存同步完成'); break; }
    }
    await loadSupplier();
  } catch (e) {
    if (stat) stat.textContent = '失败：' + e.message;
    toast('同步失败：' + e.message);
  } finally {
    if (b) b.disabled = false;
  }
}

// 把对方的「商品说明 / 详情」一次性搬进本站商品表（不覆盖你手改过的说明）
async function syncDesc() {
  const b = document.querySelector('[data-action="sync-desc"]');
  const stat = $('supDescStat');
  if (!confirm('将翻一遍对方全部商品，把「商品说明」和「详情长文」写进本站商品。\n\n你自己改过的说明不会被覆盖。确定继续？')) return;
  if (b) { b.disabled = true; b.textContent = '同步中...'; }
  if (stat) stat.textContent = '正在翻页抓对方文案，约 30~60 秒…';
  try {
    const data = await fnCall({ action: 'syncdesc' });
    if (!data || data.ok !== true) throw new Error((data && data.error_message) || '返回异常：多半是 Edge Function 还是旧版，按 README 第 5 步重新粘贴部署');
    const wrote = (Number(data.applied_description) || 0) + (Number(data.applied_detail) || 0);
    const msg = '本次写入：说明 ' + (data.applied_description || 0) + ' 条、详情 ' + (data.applied_detail || 0) + ' 条'
      + '（对方有文案 ' + (data.with_text || 0) + ' / 共 ' + (data.skus || 0) + ' 个 SKU）'
      + (wrote === 0 ? NL + '没变化 = 之前已经同步过了，重复点不会覆盖，正常。' : '');
    if (stat) stat.textContent = msg;
    toast(wrote === 0 ? '已经同步过了，无需重复' : msg.replace(NL, ' '));
    if (data.truncated) toast('⚠️ 对方商品没翻完，可能有漏的，稍后再点一次');
  } catch (e) {
    if (stat) stat.textContent = '失败：' + e.message;
    toast('同步说明失败：' + e.message);
  } finally {
    if (b) { b.disabled = false; b.textContent = '同步对方说明'; }
  }
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
// 标题 -> 分类。规则顺序必须和 06-category.sql 里的 goods_cat_of 一字不差，
// 否则「批量建商品」分出来的类和「一键重归类」的结果会打架。
const CAT_RULES = [
  [/gmail/i, 'Gmail'],
  [/youtube|油管/i, 'YouTube'],
  [/google|谷歌/i, 'Google'],
  [/instagram|(^|[^a-z])ins([^a-z]|$)/i, 'Instagram'],
  [/facebook|脸书|(^|[^a-z])fb([^a-z]|$)/i, 'Facebook'],
  [/tiktok|抖音/i, 'TikTok'],
  [/telegram|(^|[^a-z])tg([^a-z]|$)/i, 'Telegram'],
  [/twitter/i, 'Twitter'],
  [/whatsapp/i, 'WhatsApp'],
  [/discord/i, 'Discord'],
  [/reddit/i, 'Reddit'],
  [/(^|[^a-z])signal([^a-z]|$)/i, 'Signal'],
  [/kakao/i, 'Kakao'],
  [/(^|[^a-z])line([^a-z]|$)|韩国/i, 'Line'],
  [/microsoft|outlook|hotmail|live\.com|office/i, 'Microsoft'],
  [/yahoo/i, 'Yahoo'],
  [/apple|苹果|app\s?store|itunes|(^|[^a-z])ios([^a-z]|$)/i, 'Apple'],
  [/amazon|亚马逊/i, 'Amazon'],
  [/netflix/i, 'Netflix'],
  [/chatgpt|openai|(^|[^a-z])gpt([^a-z]|$)/i, 'ChatGPT'],
  [/claude/i, 'Claude'],
  [/steam/i, 'Steam'],
  [/spotify|deezer/i, 'Spotify'],
  [/pubg|原神|游戏/i, '游戏'],
  [/接码|虚商|虚拟号码|手机号|号码/i, '号码'],
  [/邮箱|(^|[^a-z])email([^a-z]|$)|(^|[^a-z])mail([^a-z]|$)|(^|[^a-z])imap([^a-z]|$)/i, '邮箱'],
  [/会员|vip|premium/i, '会员'],
  [/人工/i, '人工服务'],
];
function guessCategory(title) {
  const t = String(title || '');
  for (const [re, name] of CAT_RULES) if (re.test(t)) return name;
  const m = t.match(/^[A-Za-z]{2,10}/);
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
    const stockCell = el('span', null, '库存' + (it.stock === undefined || it.stock === null ? '?' : it.stock));
    if (!Number(it.stock)) { stockCell.style.cssText = 'color:#dc2626;font-weight:700'; }
    row.appendChild(stockCell);
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
  $('gDesc').value = String(it.desc || '').trim() || '货源直发 · 付款后自动发货';
  $('gDetail').value = String(it.detail || '').trim();
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
    description: String(it.desc || '').trim() || '货源直发 · 付款后自动发货',
    detail: String(it.detail || '').trim(),
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
}

// 「一键建满」：判重和写库都在服务端做，一次点完剩下所有 SKU。
// 不用先在浏览器里拉清单，也不受商品列表只取 1000 行的限制。
async function autoBuild() {
  const stat = $('supBulkStat');
  const put = (x) => { if (stat) stat.textContent = x; };
  const kw = String((($('supFilter') && $('supFilter').value) || '')).trim();
  const onlyOnline = !($('supBuildOffline') && $('supBuildOffline').checked);
  const payload = { action: 'autobuild', dry: true, keyword: kw, markup_pct: markupPct() * 100, only_online: onlyOnline };
  put('正在问服务端还差多少…');
  let r = null;
  try { r = await fnCall(payload); } catch (e) { put(''); toast('预览失败：' + errText(e.message || e)); return; }
  if (!r || r.ok === false) { put(''); toast('预览失败：' + ((r && r.error_message) || '未知')); return; }
  if (!r.to_build) { put(`对方 ${r.supplier_skus} 个 SKU，本店已建 ${r.already_built} 个：已经建满`); toast('没有需要补建的商品'); return; }
  const lines = [
    `对方 SKU ${r.supplier_skus} 个，本店已建 ${r.already_built} 个`,
    `还差 ${r.to_build} 个要建`,
    `定价：进价 +${Math.round(Number(r.markup_pct))}%`,
    onlyOnline ? '跳过对方断货的（想一起建就勾「含对方断货」）' : '含对方断货的也一起建',
  ];
  if (kw) lines.push(`只建关键词：${kw}`);
  if (r.truncated) lines.push('注意：对方清单没翻完，这次只建已翻到的');
  for (const x of (r.sample || []).slice(0, 8)) lines.push(`  · ${x.name} 进价¥${x.cost} → 卖¥${x.retail}`);
  put(`待建 ${r.to_build} 个`);
  if (!confirm(lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10) + '确定现在建？建完自动按规则归类。')) return;
  const b = document.querySelector('[data-action="autobuild"]');
  if (b) b.disabled = true;
  put(`开始建 ${r.to_build} 个，别关页面…`);
  try {
    const go = await fnCall(Object.assign({}, payload, { dry: false }));
    if (!go || go.ok === false) { put(''); toast('失败：' + ((go && go.error_message) || '未知')); return; }
    put(`新建 ${go.created} 个${go.recategorized ? '（已自动归类）' : ''}`);
    toast(`建好 ${go.created} 个商品，去「商品管理」看`);
    try { await refreshSkuIndex(); } catch (e) { /* 刷新判重索引失败不影响已建结果 */ }
    await loadGoodsAdmin();
    renderCatalogList();
  } catch (e) {
    put(''); toast('执行失败：' + errText(e.message || e));
  } finally {
    if (b) b.disabled = false;
  }
}

// 手动跑一次代发巡检：没挂上 pg_cron 时用它应急，效果与定时器同。
async function runFulfill() {
  const b = document.querySelector('[data-action="run-fulfill"]');
  const stat = $("supFulfillStat");
  if (b) { b.disabled = true; b.textContent = "巡检中..."; }
  if (stat) stat.textContent = "";
  try {
    const data = await fnCall({ action: "fulfill" });
    if (!data || data.ok !== true) throw new Error((data && data.error_message) || "返回异常");
    if (data.skipped) {
      if (stat) stat.textContent = data.skipped;
      toast(data.skipped + "：请先把顶部「货源代发」切成开启并保存");
      return;
    }
    const r = data.processed || {};
    const keys = Object.keys(r);
    if (!keys.length) {
      if (stat) stat.textContent = "没有待代发的订单（需已付款 + 商品填了对方 SKU）";
      toast("没有待代发的订单");
      return;
    }
    if (stat) stat.textContent = "本次 " + keys.length + " 单：" + keys.map((k) => k + " -> " + r[k]).join("；");
    toast("已处理 " + keys.length + " 单，结果见下方");
  } catch (e) {
    if (stat) stat.textContent = "失败：" + e.message;
    toast("代发失败：" + e.message);
  } finally {
    if (b) { b.disabled = false; b.textContent = "立即代发（手动巡检）"; }
  }
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
    if (a === 'save-supplier') b.addEventListener('click', saveSupplier);
    if (a === 'pull-catalog') b.addEventListener('click', pullCatalog);
    if (a === 'run-fulfill') b.addEventListener('click', runFulfill);
    if (a === 'sync-stock') b.addEventListener('click', syncStock);
    if (a === 'bulk-goods') b.addEventListener('click', bulkGoods);
    if (a === 'autobuild') b.addEventListener('click', autoBuild);
    if (a === 'save-wallet') b.addEventListener('click', saveWalletSettings);
    if (a === 'refresh-recharge') b.addEventListener('click', loadRecharges);
    if (a === 'sync-desc') b.addEventListener('click', syncDesc);
    if (a === 'price-preview') b.addEventListener('click', () => priceRun(true));
    if (a === 'price-apply') b.addEventListener('click', () => priceRun(false));
    if (a === 'price-undo') b.addEventListener('click', priceUndo);
    if (a === 'listing-preview') b.addEventListener('click', () => listingRun(true));
    if (a === 'listing-apply') b.addEventListener('click', () => listingRun(false));
    if (a === 'listing-undo') b.addEventListener('click', listingUndo);
    if (a === 'goods-prev') b.addEventListener('click', () => goodsStep(-1));
    if (a === 'goods-next') b.addEventListener('click', () => goodsStep(1));
    if (a === 'save-members') b.addEventListener('click', saveMemberSettings);
  });
  const sf = $('supFilter');
  for (const id of ['goodsFilter', 'goodsStockFilter']) {
    const n = $(id);
    if (n) n.addEventListener(id === 'goodsFilter' ? 'input' : 'change', () => { goodsPage = 0; renderGoodsAdmin(); });
  }
  const gps = $('goodsPageSize');
  if (gps) gps.addEventListener('change', () => goodsSetSize(gps.value));
  if (sf) sf.addEventListener('input', renderCatalogList);
  const paScope = $('paScope');
  if (paScope) paScope.addEventListener('change', paSyncUI);
  const lkScope = $('lkScope');
  if (lkScope) lkScope.addEventListener('change', lkSyncUI);
  const lkTo = $('lkTo');
  if (lkTo) lkTo.addEventListener('change', lkSyncUI);
  for (const id of ['lkCat', 'lkKw']) { const n = $(id); if (n) n.addEventListener('change', lkSyncUI); }
  for (const id of ['paMode', 'paSign', 'paVal', 'paOnlyOn']) {
    const n = $(id);
    if (n) n.addEventListener('input', () => { paHintClear(); });
  }
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
  const mf = $('memFilter');
  if (mf) mf.addEventListener('input', renderMembers);
  const mr = $('memRank');
  if (mr) mr.addEventListener('change', renderMembers);
});

/* ================= 批量调价（可涨可跌，带预览 + 一键撤销） ================= */
// 数值语义：percent 传百分数（10 = 10%）；amount 传「分」（1.5 元 → 150）
function paNum() {
  const raw = Number(($('paVal') && $('paVal').value) || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return ($('paMode') && $('paMode').value === 'amount') ? Math.round(raw * 100) : raw;
}
function paUnit() { return ($('paMode') && $('paMode').value === 'amount') ? '元' : '%'; }
function paScopeKey() { return ($('paScope') && $('paScope').value) || 'all'; }
function paIds() { return goodsFilteredList().map((g) => Number(g.id)).filter((x) => x > 0); }
function paHintClear() { const s = $('priceStat'); if (s) s.textContent = ''; }
function fillPaCats() {
  const sel = $('paCat');
  if (!sel) return;
  const cats = [];
  for (const g of goodsCache || []) {
    const c = String(g.category || '').trim() || '未分类';
    if (cats.indexOf(c) < 0) cats.push(c);
  }
  cats.sort();
  const keep = sel.value;
  sel.textContent = '';
  for (const c of cats) {
    const o = el('option', null, c);
    o.value = c;
    sel.appendChild(o);
  }
  if (cats.indexOf(keep) >= 0) sel.value = keep;
}
function paSyncUI() {
  const sc = paScopeKey();
  const map = { paCatItem: sc === 'category', paKwItem: sc === 'keyword', paIdsItem: sc === 'pending' };
  for (const id in map) { const n = $(id); if (n) n.style.display = map[id] ? '' : 'none'; }
  if (sc === 'category') fillPaCats();
  if (sc === 'pending') {
    const h = $('paIdsHint');
    if (h) h.textContent = '将对当前列表里的 ' + paIds().length + ' 个商品调价（先用下方商品列表的搜索 / 筛选缩小范围）';
  }
  paHintClear();
}
function paPayload(dry) {
  const sc = paScopeKey();
  return {
    action: 'priceadjust',
    dry: dry === true,
    mode: ($('paMode') && $('paMode').value) || 'percent',
    sgn: ($('paSign') && Number($('paSign').value) < 0) ? -1 : 1,
    val: paNum(),
    scope: sc === 'pending' ? 'ids' : sc,
    kw: sc === 'keyword' ? String(($('paKw') && $('paKw').value) || '').trim() : '',
    cat: sc === 'category' ? String(($('paCat') && $('paCat').value) || '') : '',
    ids: sc === 'pending' ? paIds() : [],
    only_on: !($('paOnlyOn') && $('paOnlyOn').value === '0'),
  };
}
function paSample(data) {
  const s = Array.isArray(data.sample) ? data.sample : [];
  if (!s.length) {
    return Number(data.matched) ? '（命中的商品改前改后一样，不用动）'
      : '当前范围里一个商品都没命中：换个范围，或把「连已下架的一起调」选上。';
  }
  return '举几个例子（改前 → 改后）：' + NL
    + s.map((x) => '  ' + x.name + '：¥' + money(x.from) + ' → ¥' + money(x.to)).join(NL);
}
async function priceRun(dry) {
  const stat = $('priceStat');
  const box = $('paPreview');
  const val = paNum();
  if (!val) { toast('先填一个大于 0 的数值'); return; }
  if (dry !== true) {
    const scName = ($('paScope') && $('paScope').selectedOptions && $('paScope').selectedOptions[0])
      ? $('paScope').selectedOptions[0].textContent : '全部上架商品';
    const tip = '确定执行调价？' + NL + NL
      + '方式：' + (paPayload(false).sgn < 0 ? '下调 ' : '上调 ') + val + paUnit() + NL
      + '范围：' + scName + NL + NL
      + '这会真的改掉商品售价。调错了可以点「撤销上一次调价」还原。';
    if (!confirm(tip)) return;
  }
  const b1 = document.querySelector('[data-action="price-preview"]');
  const b2 = document.querySelector('[data-action="price-apply"]');
  if (b1) b1.disabled = true;
  if (b2) b2.disabled = true;
  if (stat) stat.textContent = dry ? '预览中…' : '调价中…';
  try {
    const data = await fnCall(paPayload(dry));
    if (!data || data.ok !== true) {
      throw new Error((data && data.error_message) || '返回异常：多半是代发函数还是旧版，按 README 第 5 步重新粘贴部署');
    }
    const line = (dry ? '预览：命中 ' : '已执行：命中 ') + (data.matched || 0) + ' 个，实际改动 ' + (data.changed || 0) + ' 个'
      + (Number(data.below_cost) > 0 ? '（⚠️ 其中 ' + data.below_cost + ' 个改完低于进货价）' : '');
    if (stat) stat.textContent = line;
    if (box) box.textContent = paSample(data) + (dry && Number(data.changed) ? NL + '看清楚就点「确认执行调价」。' : '');
    if (dry !== true) {
      toast('调价完成，改动 ' + (data.changed || 0) + ' 个商品');
      await loadGoodsAdmin();
      paSyncUI();
    } else if (!Number(data.changed)) {
      toast('没有商品会被改动，检查下数值和范围');
    }
  } catch (e) {
    if (stat) stat.textContent = '失败：' + e.message;
    toast('调价失败：' + e.message);
  } finally {
    if (b1) b1.disabled = false;
    if (b2) b2.disabled = false;
  }
}
async function priceUndo() {
  const stat = $('priceStat');
  try {
    if (stat) stat.textContent = '正在找上一次调价…';
    const list = await fnCall({ action: 'pricebatches' });
    if (!list || list.ok !== true) throw new Error((list && list.error_message) || '返回异常：代发函数需要重新部署');
    const live = (list.batches || []).filter((x) => !x.undone && Number(x.changed) > 0);
    if (!live.length) {
      if (stat) stat.textContent = '没有可撤销的调价记录';
      toast('没有可撤销的调价记录');
      return;
    }
    const b0 = live[0];
    const tip = '最近一次调价：' + b0.note + '（改了 ' + b0.changed + ' 个商品，' + fmtTime(b0.created_at) + '）' + NL + NL
      + '确定还原吗？你后来手改过价格的商品会自动跳过。';
    if (!confirm(tip)) return;
    const r = await fnCall({ action: 'priceundo', batch: b0.id });
    if (!r || r.ok !== true) throw new Error((r && r.error_message) || '撤销失败');
    if (stat) stat.textContent = '已撤销：还原 ' + r.restored + ' 个' + (Number(r.skipped) ? '，跳过 ' + r.skipped + ' 个（手改过）' : '');
    toast('撤销完成');
    await loadGoodsAdmin();
  } catch (e) {
    if (stat) stat.textContent = '撤销失败：' + e.message;
    toast('撤销失败：' + e.message);
  }
}

/* ================= 会员注册 / 推广（数据在 members 表） ================= */
function memberLink(code) { return SITE_URL + '?ref=' + encodeURIComponent(String(code || '')); }
async function loadMemberSettings() {
  const { data, error } = await supa.from('settings').select('data').eq('id', 'site').maybeSingle();
  if (error) { toast(errText(error)); return; }
  const s = (data && data.data) || {};
  if ($('memOpen')) $('memOpen').value = s.member_open === false ? '0' : '1';
  if ($('memSignup')) $('memSignup').value = Number(s.signup_bonus_fen || 0) / 100 || '';
  if ($('memInvite')) $('memInvite').value = Number(s.invite_bonus_fen || 0) / 100 || '';
}
async function saveMemberSettings() {
  const fen = (id) => {
    const raw = Number($(id) && $(id).value);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.max(0, Math.min(999900, Math.round(raw * 100)));
  };
  const payload = {
    member_open: ($('memOpen') && $('memOpen').value) !== '0',
    signup_bonus_fen: fen('memSignup'),
    invite_bonus_fen: fen('memInvite'),
  };
  const { data: cur, error: e1 } = await supa.from('settings').select('data').eq('id', 'site').maybeSingle();
  if (e1) { toast(errText(e1)); return; }
  const merged = Object.assign({}, (cur && cur.data) || {}, payload);
  const { error } = await supa.from('settings').update({ data: merged }).eq('id', 'site');
  const stat = $('memSetStat');
  if (error) {
    if (stat) stat.textContent = '保存失败';
    toast(errText(error));
    return;
  }
  if (stat) stat.textContent = '已保存 ' + fmtTime(Date.now());
  toast('注册设置已保存，前台刷新后生效');
}
function memberInviteCount() {
  const m = {};
  for (const r of memberCache || []) {
    const k = Number(r.ref_member || 0);
    if (k > 0) m[k] = (m[k] || 0) + 1;
  }
  return m;
}
function memberFilteredList() {
  const kw = String(($('memFilter') && $('memFilter').value) || '').trim().toLowerCase();
  const rk = ($('memRank') && $('memRank').value) || '';
  const cnt = memberInviteCount();
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return (memberCache || []).filter((m) => {
    if (kw && !((String(m.username || '') + ' ' + String(m.invite_code || '')).toLowerCase().includes(kw))) return false;
    if (rk === 'top' && !(Number(cnt[m.id]) > 0)) return false;
    if (rk === 'new' && !(Number(m.created_at) >= week)) return false;
    return true;
  });
}
function topInviter(cnt) {
  let best = null, bn = 0;
  for (const m of memberCache || []) {
    const c = Number(cnt[m.id] || 0);
    if (c > bn) { bn = c; best = m; }
  }
  return best ? best.username + '（' + bn + ' 人）' : '暂无';
}
async function loadMembers() {
  const { data, error } = await supa.from('members')
    .select('id,username,invite_code,ref_member,ref_agent,balance_fen,status,created_at,last_login,login_count')
    .order('id', { ascending: false }).limit(1000);
  if (error) { toast(errText(error)); return; }
  memberCache = data || [];
  renderMembers();
}
function renderMembers() {
  const tbody = document.querySelector('#membersTable tbody');
  if (!tbody) return;
  tbody.textContent = '';
  const cnt = memberInviteCount();
  const list = memberFilteredList();
  const stat = $('memStat');
  if (stat) stat.textContent = '共 ' + (memberCache || []).length + ' 人（筛出 ' + list.length + '）· 邀请最多：' + topInviter(cnt);
  const empty = $('membersEmpty');
  if (empty) { empty.textContent = (memberCache || []).length ? '没有符合条件的会员' : '还没有会员注册'; empty.style.display = list.length ? 'none' : 'block'; }
  for (const m of list.slice(0, 500)) {
    const tr = el('tr');
    const code = String(m.invite_code || '');
    const invited = Number(cnt[m.id] || 0);
    const link = el('td');
    link.appendChild(el('b', null, code));
    link.appendChild(document.createTextNode(' ' + memberLink(code) + ' '));
    link.appendChild(btn('btn btn-ghost btn-sm', '复制', () => copyText(memberLink(code))));
    if (Number(m.ref_member) > 0) link.appendChild(el('div', null, '↑ 由会员 #' + m.ref_member + ' 邀请'));
    else if (m.ref_agent) link.appendChild(el('div', null, '↑ 推广员码 ' + m.ref_agent));
    tr.appendChild(el('td', null, String(m.username || '')));
    tr.appendChild(link);
    tr.appendChild(el('td', null, invited + ' 人'));
    tr.appendChild(el('td', null, '¥' + money(m.balance_fen)));
    tr.appendChild(el('td', null, fmtTime(m.created_at)));
    tr.appendChild(el('td', null, fmtTime(m.last_login) + '（登录 ' + (m.login_count || 0) + ' 次）'));
    const on = Number(m.status) === 1;
    const st = el('td', null, on ? '正常' : '已禁用');
    if (!on) st.style.color = '#94a3b8';
    tr.appendChild(st);
    const ops = el('td');
    ops.appendChild(btn('btn btn-ghost btn-sm', '发奖励', () => giveBonus(m, 1)));
    ops.appendChild(document.createTextNode(' '));
    ops.appendChild(btn('btn btn-ghost btn-sm', '扣奖励', () => giveBonus(m, -1)));
    ops.appendChild(document.createTextNode(' '));
    ops.appendChild(btn(on ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm', on ? '禁用' : '启用', () => toggleMember(m)));
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  if (list.length > 500) {
    const tr = el('tr');
    const td = el('td', null, '…… 还有 ' + (list.length - 500) + ' 个没显示，用上方搜索缩小范围');
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}
function giveBonus(m, sgn) {
  const v = prompt((sgn > 0 ? '给 ' : '从 ') + m.username + (sgn > 0 ? ' 发放多少奖励金（元）？' : ' 扣回多少奖励金（元）？'), '5');
  if (v === null) return;
  const fen = Math.round(Number(v) * 100);
  if (!Number.isFinite(fen) || fen <= 0) { toast('金额不对'); return; }
  runMemberBonus(m, sgn * fen, Math.max(0, Number(m.balance_fen || 0) + sgn * fen));
}
async function runMemberBonus(m, delta, next) {
  const note = delta > 0 ? '后台手动发放' : '后台手动扣回';
  const { data, error } = await supa.rpc('rpc_wallet_adjust', { p_member_id: m.id, p_delta_fen: delta, p_note: note });
  let legacy = false;
  if (error) {
    // 找不到函数 = 还没执行 11-wallet.sql，退回直接改余额（能用，只是前台看不到这条流水）
    if (String(error.message || '').indexOf('rpc_wallet_adjust') < 0) { toast(errText(error)); return; }
    legacy = true;
  } else if (data && data.ok === true) {
    toast('余额已更新为 ¥' + money(data.balance_fen));
    await loadMembers();
    return;
  } else {
    toast((data && data.error) || '调整失败');
    return;
  }
  if (!legacy) return;
  const { error: e2 } = await supa.from('members').update({ balance_fen: next }).eq('id', m.id);
  if (e2) { toast(errText(e2)); return; }
  await supa.from('member_rewards').insert({
    member_id: m.id, kind: 'bonus', amount_fen: delta, from_member: 0,
    note: note, created_at: Date.now(),
  });
  toast('奖励金已更新（提示：执行 11-wallet.sql 后每笔都会有流水）');
  await loadMembers();
}
async function toggleMember(m) {
  const on = Number(m.status) === 1;
  if (on && !confirm('禁用「' + m.username + '」？该会员会立刻掉线，不能再用这个账号下单归因。')) return;
  const { error } = await supa.from('members').update({ status: on ? 0 : 1 }).eq('id', m.id);
  if (error) { toast(errText(error)); return; }
  toast(on ? '已禁用该会员' : '已启用该会员');
  await loadMembers();
}


/* ================= 钱包 / 充值（第 18 步） ================= */
let rechargeCache = [];
let memberNameCache = {};

async function payCall(body) {
  const res = await fetch(
    CFG.SUPA_URL.replace(/\/+$/, '') + '/functions/v1/alipay-pay',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { throw new Error('HTTP ' + res.status + '：' + txt.slice(0, 160)); }
}

function yuanToFen(id, maxFen) {
  const raw = Number($(id) && $(id).value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(0, Math.min(maxFen, Math.round(raw * 100)));
}
function fenToYuanText(fen) {
  const v = Number(fen) || 0;
  return v > 0 ? String(Math.round(v) / 100) : '';
}
async function loadWalletSettings() {
  const { data, error } = await supa.from('settings').select('data').eq('id', 'site').maybeSingle();
  if (error) { toast(errText(error)); return; }
  const s = (data && data.data) || {};
  if ($('walPayOpen')) $('walPayOpen').value = s.balance_pay_open === false ? '0' : '1';
  if ($('walChannel')) $('walChannel').value = s.recharge_channel === 'alipay' ? 'alipay' : 'manual';
  if ($('walMin')) $('walMin').value = fenToYuanText(s.recharge_min_fen || 100);
  if ($('walMax')) $('walMax').value = fenToYuanText(s.recharge_max_fen || 5000000);
  if ($('walPresets')) {
    const arr = Array.isArray(s.recharge_presets) ? s.recharge_presets : [];
    $('walPresets').value = arr.map((x) => Math.round(Number(x) / 100)).filter((x) => x > 0).join(',');
  }
  if ($('walNotice')) $('walNotice').value = s.recharge_notice || '';
}
async function saveWalletSettings() {
  const presets = String(($('walPresets') && $('walPresets').value) || '')
    .split(/[,，\s]+/).map((x) => Math.round(Number(x) * 100)).filter((x) => Number.isFinite(x) && x >= 100 && x <= 1000000);
  const minFen = yuanToFen('walMin', 100000000) || 100;
  let maxFen = yuanToFen('walMax', 100000000) || 5000000;
  if (maxFen < minFen) maxFen = minFen;
  const payload = {
    balance_pay_open: ($('walPayOpen') && $('walPayOpen').value) !== '0',
    recharge_channel: ($('walChannel') && $('walChannel').value) === 'alipay' ? 'alipay' : 'manual',
    recharge_min_fen: minFen,
    recharge_max_fen: maxFen,
    recharge_presets: presets.slice(0, 12),
    recharge_notice: String(($('walNotice') && $('walNotice').value) || '').slice(0, 600),
  };
  const { data: cur, error: e1 } = await supa.from('settings').select('data').eq('id', 'site').maybeSingle();
  if (e1) { toast(errText(e1)); return; }
  const merged = Object.assign({}, (cur && cur.data) || {}, payload);
  const { error } = await supa.from('settings').update({ data: merged }).eq('id', 'site');
  const stat = $('walSetStat');
  if (error) { if (stat) stat.textContent = '保存失败'; toast(errText(error)); return; }
  if (stat) stat.textContent = '已保存 ' + fmtTime(Date.now());
  toast('钱包设置已保存，前台刷新后生效');
}

async function loadRecharges() {
  const [r, m] = await Promise.all([
    supa.from('recharge_orders')
      .select('out_trade_no,member_id,amount_fen,channel,status,trade_no,note,created_at,paid_at')
      .order('created_at', { ascending: false }).limit(500),
    supa.from('members').select('id,username').limit(2000),
  ]);
  if (r.error) { toast(errText(r.error) + '（充值表还没建？请先执行 11-wallet.sql）'); return; }
  memberNameCache = {};
  for (const x of (m.data || [])) memberNameCache[x.id] = x.username;
  rechargeCache = r.data || [];
  renderRecharges();
}
function rechargeFilteredList() {
  const kw = String(($('rcFilter') && $('rcFilter').value) || '').trim().toLowerCase();
  const rank = ($('rcRank') && $('rcRank').value) || 'pending';
  return rechargeCache.filter((x) => {
    if (rank && x.status !== rank) return false;
    if (!kw) return true;
    return String(x.out_trade_no || '').toLowerCase().indexOf(kw) >= 0
      || String(memberNameCache[x.member_id] || '').toLowerCase().indexOf(kw) >= 0;
  });
}
const rcTag = (s) => ({ pending: '待入账', paid: '已入账', closed: '已关闭' }[s] || s);
function renderRecharges() {
  const tbody = document.querySelector('#rcTable tbody');
  if (!tbody) return;
  tbody.textContent = '';
  const list = rechargeFilteredList();
  const pend = rechargeCache.filter((x) => x.status === 'pending');
  const sum = pend.reduce((a, b) => a + (Number(b.amount_fen) || 0), 0);
  const stat = $('rcStat');
  if (stat) stat.textContent = '共 ' + rechargeCache.length + ' 单（筛出 ' + list.length + '）· 待入账 ' + pend.length + ' 单 ¥' + money(sum);
  const empty = $('rcEmpty');
  if (empty) { empty.textContent = rechargeCache.length ? '没有符合条件的充值单' : '还没有充值单'; empty.style.display = list.length ? 'none' : 'block'; }
  for (const r of list.slice(0, 300)) {
    const tr = el('tr');
    tr.appendChild(el('td', null, String(r.out_trade_no || '')));
    tr.appendChild(el('td', null, String(memberNameCache[r.member_id] || ('#' + r.member_id))));
    tr.appendChild(el('td', null, '¥' + money(r.amount_fen)));
    tr.appendChild(el('td', null, r.channel === 'alipay' ? '支付宝' : '人工'));
    const st = el('td', null, rcTag(r.status));
    if (r.status === 'pending') st.style.color = '#d97706';
    tr.appendChild(st);
    tr.appendChild(el('td', null, fmtTime(r.created_at) + (r.paid_at ? ' → 到账 ' + fmtTime(r.paid_at) : '')));
    tr.appendChild(el('td', null, String(r.note || r.trade_no || '')));
    const ops = el('td');
    if (r.status === 'pending') {
      ops.appendChild(btn('btn btn-primary btn-sm', '确认入账', () => confirmRecharge(r)));
      ops.appendChild(document.createTextNode(' '));
      if (r.channel === 'alipay') {
        ops.appendChild(btn('btn btn-ghost btn-sm', '查支付宝', () => queryAlipay(r)));
        ops.appendChild(document.createTextNode(' '));
      }
      ops.appendChild(btn('btn btn-danger btn-sm', '关闭', () => closeRecharge(r)));
    } else {
      ops.appendChild(el('span', null, r.status === 'paid' ? '已加到余额' : '—'));
    }
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  if (list.length > 300) {
    const tr = el('tr');
    const td = el('td', null, '…… 还有 ' + (list.length - 300) + ' 单没显示，用上方搜索缩小范围');
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}
async function confirmRecharge(r) {
  const who = String(memberNameCache[r.member_id] || ('#' + r.member_id));
  if (!confirm('确认「' + who + '」的充值单 ' + r.out_trade_no + '（¥' + money(r.amount_fen) + '）已经到账？' + NL +
    '确认后这笔钱会直接进他的余额，同一单号只会入账一次。')) return;
  const note = prompt('备注（可留空，例如支付宝流水号 / 转账时间）：', '') || '';
  const { data, error } = await supa.rpc('rpc_recharge_confirm', { p_out_trade_no: r.out_trade_no, p_note: note });
  if (error) { toast(errText(error)); return; }
  if (!data || data.ok !== true) { toast((data && data.error) || '入账失败'); return; }
  toast(data.credited === false ? '这笔单之前已经入过账，没有重复给钱' : '已入账，余额 ¥' + money(data.balance_fen));
  await loadRecharges();
}
async function closeRecharge(r) {
  if (!confirm('关闭充值单 ' + r.out_trade_no + '？关闭后这笔不会再入账。')) return;
  const { data, error } = await supa.rpc('rpc_recharge_close', { p_out_trade_no: r.out_trade_no });
  if (error) { toast(errText(error)); return; }
  toast(data && data.closed ? '已关闭' : '这笔单已经变了，刷新一下');
  await loadRecharges();
}
async function queryAlipay(r) {
  toast('正在向支付宝查这笔单…');
  try {
    const res = await payCall({ action: 'query', out_trade_no: r.out_trade_no });
    if (res && res.ok && res.status === 'paid') toast('支付宝已确认收款，正在入账');
    else toast('支付宝那边还没有这笔收款（' + ((res && (res.status || res.code)) || '未部署 alipay-pay') + '）');
  } catch (e) { toast(errText(e)); }
  await loadRecharges();
}

/* ================= 一键下架 / 一键上架（第 20 步） ================= */
const LK_SCOPE_TEXT = {
  oos: '对方缺货 / 断货的代发商品',
  all: '全部商品',
  pending: '当前筛选结果',
  category: '指定分类',
  keyword: '指定关键词',
};
function lkVal(id) { return ($(id) && $(id).value) || ''; }
function lkIds() { return goodsFilteredList().map((g) => Number(g.id)).filter((x) => x > 0); }
function fillLkCats() {
  const sel = $('lkCat');
  if (!sel) return;
  const cats = [];
  for (const g of goodsCache || []) {
    const c = String(g.category || '').trim() || '未分类';
    if (cats.indexOf(c) < 0) cats.push(c);
  }
  cats.sort();
  const keep = sel.value;
  sel.textContent = '';
  for (const c of cats) {
    const o = el('option', null, c);
    o.value = c;
    sel.appendChild(o);
  }
  if (keep && cats.indexOf(keep) >= 0) sel.value = keep;
}
function lkSyncUI() {
  const scope = lkVal('lkScope') || 'all';
  const show = (id, on) => { const n = $(id); if (n) n.style.display = on ? '' : 'none'; };
  show('lkCatItem', scope === 'category');
  show('lkKwItem', scope === 'keyword');
  show('lkIdsItem', scope === 'pending');
  if (scope === 'pending') {
    const h = $('lkIdsHint');
    if (h) h.textContent = '当前筛出 ' + lkIds().length + ' 个商品（改下面的搜索框 / 筛选就能变）';
  }
  const s = $('lkPreview');
  if (s) s.textContent = '';
}
function lkPayload(dry) {
  const scope = lkVal('lkScope') || 'all';
  return {
    p_to: Number(lkVal('lkTo')) === 1 ? 1 : 0,
    p_scope: scope,
    p_kw: scope === 'keyword' ? String(lkVal('lkKw') || '').trim() : '',
    p_cat: scope === 'category' ? lkVal('lkCat') : '',
    p_ids: scope === 'pending' ? lkIds() : [],
    p_dry: dry !== false,
    p_note: '',
  };
}
function lkCheck(payload) {
  if (payload.p_scope === 'keyword' && !payload.p_kw) { toast('请先填关键词'); return false; }
  if (payload.p_scope === 'category' && !payload.p_cat) { toast('请先选分类'); return false; }
  if (payload.p_scope === 'pending' && !payload.p_ids.length) { toast('当前筛选结果为空，请先在下面的商品列表里搜索 / 筛选'); return false; }
  if (payload.p_scope === 'pending' && payload.p_ids.length > 5000) { toast('一次最多 5000 个，请用搜索缩小范围'); return false; }
  return true;
}
function lkSample(data) {
  const rows = Array.isArray(data.sample) ? data.sample : [];
  if (!rows.length) return '';
  const on = (v) => (Number(v) === 1 ? '上架中' : '已下架');
  return NL + '举例：' + NL + rows.map((s) => '  #' + s.id + ' ' + s.name + '（' + on(s.from) + ' → ' + on(s.to) + '）').join(NL);
}
function lkSummary(data, payload) {
  const off = Number(payload.p_to) === 0;
  const lines = [];
  lines.push((off ? '下架' : '上架') + '：命中 ' + Number(data.matched || 0) + ' 个，实际会改动 ' + Number(data.changed || 0) + ' 个');
  lines.push('其中：代发商品 ' + Number(data.drop_cnt || 0) + ' 个 · 本店卡密商品 ' + Number(data.own_cnt || 0) + ' 个');
  if (!off && Number(data.still_oos || 0) > 0) {
    lines.push('注意：里面有 ' + Number(data.still_oos) + ' 个对方目前仍是缺货/断货，上架后下一轮库存同步会自动再把它们下架。');
  }
  if (Number(data.changed || 0) === 0) lines.push('已经是目标状态，没有需要改动的商品。');
  return lines.join(NL) + lkSample(data);
}
async function listingRun(dry) {
  // 无论按哪个按钮，第一次调用永远是 dry（只统计不动库），确认以后才真执行
  const payload = lkPayload(true);
  if (!lkCheck(payload)) return;
  const b1 = document.querySelector('[data-action="listing-preview"]');
  const b2 = document.querySelector('[data-action="listing-apply"]');
  const box = $('lkPreview');
  if (b1) b1.disabled = true;
  if (b2) b2.disabled = true;
  if (box) box.textContent = '正在统计…';
  try {
    const { data, error } = await supa.rpc('rpc_set_listing', payload);
    if (error) {
      const msg = String(error.message || '');
      if ((msg.indexOf('Could not find the function') >= 0 || msg.indexOf('PGRST202') >= 0) && box) {
        box.textContent = '还没执行 12-bulk-takedown.sql：去 Supabase SQL Editor 跑一遍（网址见 README 第 20 步）';
        return;
      }
      if (msg.indexOf('ADMIN_ONLY') >= 0 && box) { box.textContent = '只有站长账号能用这个功能，请重新登录后台'; return; }
      if (box) box.textContent = '失败：' + errText(error);
      toast(errText(error));
      return;
    }
    if (!data || data.ok !== true) { if (box) box.textContent = '没拿到结果，请刷新重试'; return; }
    const text = lkSummary(data, payload);
    if (box) box.textContent = text;
    const stat = $('lkStat');
    if (stat && !dry) stat.textContent = '刚执行：改动 ' + Number(data.changed || 0) + ' 个 · ' + fmtTime(Date.now());
    if (dry !== false) return;
    if (!confirm(text + NL + NL + '确定执行吗？（下架只是从前台隐藏，数据都在，可以一键撤销）')) return;
    const again = await supa.rpc('rpc_set_listing', lkPayload(false));
    if (again.error) { toast(errText(again.error)); return; }
    const d2 = again.data || {};
    toast(d2.ok === true ? ('已完成：改动 ' + Number(d2.changed || 0) + ' 个商品') : '执行失败，请刷新重试');
    if (box) box.textContent = lkSummary(d2, payload) + NL + '（已执行）';
    await loadGoodsAdmin();
    await listingHistory();
  } finally {
    if (b1) b1.disabled = false;
    if (b2) b2.disabled = false;
  }
}
async function listingHistory() {
  const stat = $('lkStat');
  if (!stat) return;
  const { data, error } = await supa.rpc('rpc_listing_batches', { p_limit: 5 });
  if (error || !Array.isArray(data) || !data.length) return;
  const last = data.filter((b) => b.undone !== true)[0] || data[0];
  const done = data.filter((b) => b.undone !== true).length;
  stat.textContent = '最近：' + (Number(last.to_status) === 0 ? '一键下架 ' : '一键上架 ') + Number(last.changed || 0) + ' 个（'
    + fmtTime(last.created_at) + '）' + (done ? ' · 可撤销 ' + done + ' 次' : ' · 已全部撤销');
}
async function listingUndo() {
  const { data, error } = await supa.rpc('rpc_listing_batches', { p_limit: 10 });
  if (error) { toast(errText(error) + '（先执行 12-bulk-takedown.sql）'); return; }
  const list = (Array.isArray(data) ? data : []).filter((b) => b.undone !== true);
  if (!list.length) { toast('没有可撤销的下架 / 上架批次'); return; }
  const last = list[0];
  const what = Number(last.to_status) === 0 ? '下架' : '上架';
  if (!confirm('撤销上一次「一键' + what + '」（' + Number(last.changed || 0) + ' 个商品，' + fmtTime(last.created_at) + '）？' +
    NL + '你后来手动改过状态的商品不会被覆盖。')) return;
  const r = await supa.rpc('rpc_listing_undo', { p_batch: last.id });
  if (r.error) { toast(errText(r.error)); return; }
  const d = r.data || {};
  toast('已还原 ' + Number(d.restored || 0) + ' 个' + (Number(d.skipped || 0) ? '，跳过 ' + Number(d.skipped) + ' 个（你手改过）' : ''));
  await loadGoodsAdmin();
  await listingHistory();
}
