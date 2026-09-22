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
  LOW_BALANCE: '余额不足，请先充值',
  PAY_CLOSED: '站长暂时关闭了余额支付',
  BAD_TOKEN: '登录状态已失效，请重新登录',
  ORDER_CLOSED: '订单已关闭，请重新下单',
  ORDER_EXPIRED: '订单已超时关闭，请重新下单',
  ORDER_EMAIL: '这个订单和下单邮箱对不上',
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
function hide(id) {
  if (id === 'resultModal') stopCardPolling();
  $(id).classList.remove('show');
}

/* ---------- 状态 ---------- */
let catalog = [];
let current = null;    // 当前选购的商品行
let qty = 1;
let order = null;      // rpc_create_order 返回的订单
let orderIsSupplier = false; // 这单走不走货源代发（代发要等对方出货，几秒到几分钟）
let resultCtx = null;        // 结果弹窗还需要的单号 + 邮箱（order 会被清空）
let cardTimer = null;        // 结果弹窗里自动刷新卡密的定时器
let cardTries = 0;           // 最多盯 3 分钟，之后靠订单查询
let pollTimer = null;
let currentCards = [];

/* ---------- 加载 ---------- */
async function loadSite() {
  const { data, error } = await supa.rpc('rpc_site_config');
  if (error) { console.error(error); return; }
  $('siteName').textContent = data.siteName || '发卡商城';
  try { localStorage.setItem('FAKA_SITE_NAME', $('siteName').textContent); } catch (e) { /* 无痕模式忽略 */ }
  $('announcement').textContent = data.announcement || '欢迎光临本店！';
  document.title = (data.siteName || '发卡商城') + ' - 自动发卡，秒到账';
  if (window.FakaI18n) window.FakaI18n.fixTitle();
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
  route();
}

/* ---------- 分类 / 搜索 / 排序 / 分页 ----------
   商品上千个，一次性全渲染会卡；这里只渲染前 shown 个，其余靠「加载更多」。
   分类和搜索都在内存里做，不再多打一次数据库。 */
const PAGE_SIZE = 60;
let shown = PAGE_SIZE;
let catKey = '';
let keyword = '';
let sortKey = 'new';
let viewMode = 'list';   // list = 分类表格（照货源站那种排布，默认）；grid = 卡片
let detailId = 0;        // 商品详情页 #/g/<id> 当前看的商品
let dQty = 1;            // 详情页里选的数量

function loadViewMode() {
  try { viewMode = localStorage.getItem('FAKA_VIEW') === 'grid' ? 'grid' : 'list'; }
  catch (e) { viewMode = 'list'; }   // 无痕模式：退回默认列表视图
  return viewMode;
}
function setViewMode(m) {
  viewMode = m === 'grid' ? 'grid' : 'list';
  try { localStorage.setItem('FAKA_VIEW', viewMode); } catch (e) { /* 忽略 */ }
  paintViewBtns();
  paint();
}
function paintViewBtns() {
  const l = $('viewListBtn');
  const g = $('viewGridBtn');
  if (l) l.classList.toggle('on', viewMode === 'list');
  if (g) g.classList.toggle('on', viewMode === 'grid');
}

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
  // 侧栏永远是「全部分类」，搜索只过滤右边列表，导航不会一搜就缩水
  const cats = categoryList(catalog);
  if (catKey && !cats.some((c) => c[0] === catKey)) catKey = '';
  const base = byKeyword();
  const list = catKey ? base.filter((g) => catOf(g) === catKey) : base;
  return { cats, base, list: sortedList(list) };
}

function chip(label, n, key, icon, sub) {
  const b = el('button', 'cat-item' + (catKey === key ? ' on' : ''));
  b.type = 'button';
  b.setAttribute('data-cat', key);
  b.appendChild(el('span', 'cat-icon', icon || '📦'));
  const box = el('span', 'cat-text');
  box.appendChild(el('b', null, label));
  box.appendChild(el('small', null, sub || (n ? n + ' 个商品' : '点击查看全部')));
  b.appendChild(box);
  return b;
}

// 分类图标取该分类里出现最多的封面 emoji；按「搜索后的全集」算，切分类时才不会跳
let iconCache = { key: '', map: new Map() };
function catIcons(base) {
  const m = new Map();
  for (const g of base) {
    const k = catOf(g);
    const cover = String(g.cover || '').trim() || '📦';
    if (!m.has(k)) m.set(k, new Map());
    const c = m.get(k);
    c.set(cover, (c.get(cover) || 0) + 1);
  }
  const out = new Map();
  for (const [k, c] of m) {
    out.set(k, [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  }
  return out;
}
function iconsOf() {
  const k = 'cat' + catalog.length;
  if (iconCache.key !== k) iconCache = { key: k, map: catIcons(catalog) };
  return iconCache.map;
}

function renderCats(cats, base) {
  const bar = $('catBar');
  bar.textContent = '';
  let total = 0;
  for (const c of cats) total += c[1];
  const icons = iconsOf();
  bar.appendChild(chip('全部商品', 0, '', '🗂️', total + ' 个商品'));
  for (const [name, n] of cats) bar.appendChild(chip(name, n, name, icons.get(name)));
}

// 按「分类首次出现的顺序」分组：全局排序仍然生效，只是同类商品被收进同一张表
function groupByCat(list) {
  const out = [];
  const idx = new Map();
  for (const g of list) {
    const k = catOf(g);
    if (!idx.has(k)) { idx.set(k, out.length); out.push([k, []]); }
    out[idx.get(k)][1].push(g);
  }
  return out;
}

// 库存列文案：代发看对方，自营看本店卡密
function stockCellText(g) {
  if (!supplierSku(g)) {
    const n = Number(g.stock) || 0;
    return { text: String(n), cls: n > 0 ? 'ok' : 'bad' };
  }
  if (!g.supplier_synced) return { text: '直发', cls: '' };
  if (g.supplier_online === false) return { text: '下架', cls: 'bad' };
  const q = Number(g.supplier_stock);
  if (q === 0) return { text: '0', cls: 'bad' };
  if (q > 0) return { text: String(q), cls: 'ok' };
  return { text: '不限量', cls: 'ok' };
}

function renderRow(g, icon) {
  const tr = el('tr');
  const cell = el('td', 'cell-name');
  const inbox = el('div', 'cell-in');
  inbox.appendChild(el('span', 'row-icon', icon || String(g.cover || '🎁').trim() || '📦'));
  const link = el('button', 'row-name', g.name);
  link.type = 'button';
  link.title = '查看商品介绍';
  link.addEventListener('click', () => goDetail(g));
  inbox.appendChild(link);
  cell.appendChild(inbox);
  tr.appendChild(cell);
  tr.appendChild(el('td', 'c-price', '¥' + money(g.price)));
  const st = stockCellText(g);
  tr.appendChild(el('td', 'c-stock' + (st.cls ? ' ' + st.cls : ''), st.text));
  tr.appendChild(el('td', 'c-sold', String(Number(g.sales) || 0)));
  const buy = el('td', 'c-buy');
  const info = stockInfo(g);
  const b = el('button', 'buy-link', info.sellable ? '购买' : '缺货');
  b.type = 'button';
  b.disabled = !info.sellable;
  b.addEventListener('click', () => openBuy(g));
  buy.appendChild(b);
  tr.appendChild(buy);
  return tr;
}

function renderTable(cat, items, icon) {
  const box = el('section', 'pcard');
  const head = el('div', 'pcard-head');
  head.appendChild(el('span', 'pcard-icon', icon || String((items[0] && items[0].cover) || '📦').trim() || '📦'));
  head.appendChild(el('h3', null, cat));
  head.appendChild(el('small', null, items.length + ' 个商品'));
  box.appendChild(head);
  const table = el('table', 'ptable');
  const thead = el('thead');
  const htr = el('tr');
  for (const [cls, label] of [['th-name', '商品名称'], ['c-price', '价格'], ['c-stock', '库存'], ['c-sold', '已售'], ['c-buy', '购买']]) {
    htr.appendChild(el('th', cls, label));
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const g of items) tbody.appendChild(renderRow(g, icon));
  table.appendChild(tbody);
  box.appendChild(table);
  return box;
}

function paint() {
  const grid = $('goodsGrid');
  const moreRow = $('moreRow');
  const count = $('shopCount');
  grid.textContent = '';
  grid.className = viewMode === 'grid' ? 'grid' : 'rows';
  if (!catalog.length) {
    grid.appendChild(el('div', 'empty', '暂无在售商品'));
    $('catBar').textContent = '';
    if (count) count.textContent = '';
    if (moreRow) moreRow.style.display = 'none';
    return;
  }
  const cur = currentList();
  renderCats(cur.cats, cur.base);
  if (!cur.list.length) {
    grid.appendChild(el('div', 'empty', '没有匹配的商品，换个关键词试试'));
    if (count) count.textContent = '共 0 个';
    if (moreRow) moreRow.style.display = 'none';
    return;
  }
  const visible = cur.list.slice(0, shown);
  if (viewMode === 'grid') {
    for (const g of visible) grid.appendChild(renderCard(g));
  } else {
    const icons = iconsOf();
    for (const [cat, items] of groupByCat(visible)) grid.appendChild(renderTable(cat, items, icons.get(cat)));
  }
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

/* ---------- 下单提示文案（详情页与下单弹窗共用这一份，改这里就够） ---------- */
const TG_USER = 'abjb1';
const TG_URL = 'https://t.me/' + TG_USER;
const NOTICE = [
  { t: '所有商品只用来社交和沟通贸易，不做其他违法活动。' },
  { t: '下单后在「订单查询」里查看卡密（订单号 + 下单邮箱）。' },
  { tg: true },
  { t: '登录两小时内不要改密码；长久使用请一定要改密码、邮箱和手机！' },
  { t: '※ 非账号密码错误一概不退号，购买前请少量测试，一账号一 IP 登录！', hot: true },
  { t: '※ 质保 24 小时内的首次登录，没技术不要囤号，囤号被风控不售后。', hot: true },
  { t: '防被骗：全部交易只走网站平台，勿私下交易。' },
  { t: '虚拟商品一经发出概不退换；单次可买 1~10 件。' },
];
function tgLink() {
  const a = document.createElement('a');
  a.className = 'tg';
  a.textContent = '@' + TG_USER;
  a.href = TG_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
function noticeBlock(mini, extraCls) {
  const box = el('div', 'notice' + (mini ? ' mini' : '') + (extraCls ? ' ' + extraCls : ''));
  box.appendChild(el('h4', null, '购买须知'));
  const ol = document.createElement('ol');
  for (const n of NOTICE) {
    const li = document.createElement('li');
    if (n.hot) li.className = 'hot';
    if (n.tg) {
      li.appendChild(document.createTextNode('客服 TG：'));
      li.appendChild(tgLink());
    } else {
      li.textContent = n.t;
    }
    ol.appendChild(li);
  }
  box.appendChild(ol);
  return box;
}

/* ---------- 库存：自营看本店卡密，代发看对方库存（rpc_catalog 一并带出） ---------- */
function supplierSku(g) {
  return String((g && g.supplier_sku_id) || '').trim();
}

// supplier_stock：-1=不限量/未知，0=缺货；supplier_online=false = 对方已停售。
// 进价不下发到浏览器，这里只拿得到「还有多少」和「能不能买」。
function stockInfo(g) {
  if (!supplierSku(g)) {
    const n = Number(g.stock) || 0;
    return { text: n > 0 ? `库存 ${n} 张` : '⚠️ 已售罄', low: n <= 3, sellable: n > 0, max: Math.min(n, 10) };
  }
  if (!g.supplier_synced) {
    return { text: '货源直发 · 付款后自动发货', low: false, sellable: true, max: 10 };
  }
  if (g.supplier_online === false) return { text: '⚠️ 货源已下架', low: true, sellable: false, max: 0 };
  const q = Number(g.supplier_stock);
  if (q === 0) return { text: '⚠️ 暂时缺货', low: true, sellable: false, max: 0 };
  if (q > 0) {
    return { text: q <= 3 ? `仅剩 ${q} 件 · 货源直发` : `库存 ${q} 件 · 货源直发`, low: q <= 3, sellable: true, max: Math.min(q, 10) };
  }
  return { text: '库存充足 · 货源直发', low: false, sellable: true, max: 10 };
}

function renderCard(g) {
  const box = el('div', 'goods-card');

  if (g.category) box.appendChild(el('span', 'goods-category', g.category));
  box.appendChild(el('div', 'goods-cover', g.cover || '🎁'));
  const nm = el('div', 'goods-name', g.name);
  nm.title = '查看商品详情';
  nm.style.cursor = 'pointer';
  nm.addEventListener('click', () => goDetail(g));
  box.appendChild(nm);
  box.appendChild(el('div', 'goods-desc', g.description || '暂无介绍'));

  const meta = el('div', 'goods-meta');
  const price = el('span', 'goods-price');
  price.appendChild(el('small', null, '¥'));
  price.appendChild(document.createTextNode(money(g.price)));
  meta.appendChild(price);
  meta.appendChild(el('span', 'goods-sold', `已售 ${Number(g.sales) || 0}`));
  box.appendChild(meta);

  const info = stockInfo(g);
  box.appendChild(el('div', 'goods-stock' + (info.low ? ' low' : ''), info.text));

  const btn = el('button', 'btn btn-primary btn-block', info.sellable ? '立即购买' : '暂时缺货');
  btn.disabled = !info.sellable;
  btn.type = 'button';
  btn.addEventListener('click', () => openBuy(g));
  box.appendChild(btn);
  return box;
}

/* ---------- 商品介绍：长文案自动按小节拆（账号格式 / 使用建议 / 注意事项 / 售后说明 …） ---------- */
function infoBlock(label, text, pre) {
  const box = el('div', 'info-block');
  box.appendChild(el('div', 'info-label', label));
  box.appendChild(el('div', 'info-value' + (pre ? ' pre' : ''), text));
  return box;
}

const SEC_NAMES = ['商品名称', '商品说明', '商品详情', '商品介绍', '产品介绍', '账号格式', '卡密格式', '使用建议', '使用说明',
  '注意事项', '售后说明', '售后服务', '购买须知', '下单须知', '发货说明', '交付方式', '交付说明', '温馨提示',
  '常见问题', '服务保障', '基本信息', '价格说明', '购买说明', '使用须知'];

// 小标题标记：先记住「整行被 <hN> 或 <p><strong> 包住」的行，那才是对方自己标的标题
const MARK = String.fromCharCode(0xE000);
const stripTags = (x) => String(x).replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').trim();

// 对方文案可能是 HTML 或 Markdown，先洗成纯文本；换行保留，前台用 pre-line 显示
function cleanText(raw) {
  const out = String(raw || '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lvl, inner) => MARK + stripTags(inner) + MARK + String.fromCharCode(10))
    // 「<b>格式：账号----密码…</b>」这种整行加粗的格式说明，直接归成「账号格式」小节
    .replace(/<(strong|b)[^>]*>\s*(?:账号|卡密|登录|帐号)?格式[：:]([^<]{1,120})<\/\1>/gi,
      (m, tag, body) => MARK + '账号格式' + MARK + String.fromCharCode(10) + body)
    .replace(/<(strong|b)[^>]*>([^<]{1,24})<\/\1>(?=\s*(?:<br|<\/p|\s*$))/gi, (m, tag, inner) => MARK + stripTags(inner) + MARK)
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|ul|ol|tr|pre|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/\x60([^\x60]+)\x60/g, '$1')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, String.fromCharCode(39)).replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, String.fromCharCode(10)).replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, String.fromCharCode(10, 10)).trim();
  // 「卡密格式：账号----密码----2fa」这类纯文本格式行单独提成账号格式小节，正文只留格式本身
  return out.split(String.fromCharCode(10)).map((line) => {
    if (line.indexOf(MARK) >= 0) return line;
    const m = /^#*\s*(?:账号|卡密|登录|帐号)?格式\s*[：:]\s*(\S.{0,119})$/.exec(line);
    if (!m) return line;
    return MARK + '账号格式' + MARK + String.fromCharCode(10) + m[1].trim();
  }).join(String.fromCharCode(10));
}

// 一行是不是小标题：短、没句读、命中已知词或「XX格式/建议/说明…」这类后缀
function isHeading(line) {
  // 带标记的行是对方自己标的标题（<hN> / <p><strong>），放宽到 24 字
  const marked = new RegExp('^' + MARK + '([\\s\\S]*?)' + MARK + '$').exec(line.trim());
  if (marked) {
    const mt = stripTags(marked[1]).replace(/[：:]\s*$/, '').trim();
    // 整行加粗也可能是被强调的句子（带句读或太长），那种不算小节标题
    if (!mt || mt.length > 20 || /[。，、；！？,()（）]/.test(mt)) return '';
    return mt;
  }
  const t = line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  if (!t || t.length > 16) return '';
  if (/[。！？；，,.!?;:]$/.test(t)) return '';
  // 「绑定信息：支持邮箱或手机号登录」这种「标签：正文」行不是标题，认了会吃掉冒号后面的字
  if (/[：:]/.test(t) && !/[：:]\s*$/.test(t)) return '';
  const plain = t.replace(/[：:].*$/, '').trim();
  if (SEC_NAMES.indexOf(plain) >= 0) return plain;
  if (/^(以下|如下|详见|参见|请查看|请阅读|注[：:]|解释|备注)/.test(plain)) return '';
  if (/^[一-龥A-Za-z0-9（）()、/ +&-]{2,8}$/.test(plain)
    && /(格式|建议|说明|须知|事项|提示|问题|保障|规则|要求|流程|方式|售后|介绍|详情|描述|信息|优势|特点)$/.test(plain)) return plain;
  return '';
}

function parseSections(raw) {
  const text = cleanText(raw);
  if (!text) return [];
  const out = [];
  let cur = { title: '商品说明', lines: [] };
  let started = false;   // 出现过真小标题：这种小节即使没正文也要留痕，见下面 keep 的并回处理
  for (const line of text.split(String.fromCharCode(10))) {
    const h = isHeading(line);
    if (h) {
      if (started || cur.lines.join('').trim()) out.push(cur);
      started = true;
      cur = { title: h, lines: [] };
    } else {
      cur.lines.push(line.replace(/^#+\s*/, '').split(MARK).join('').trim());
    }
  }
  if (started || cur.lines.join('').trim()) out.push(cur);
  const flat = out.map((x) => ({ title: x.title, body: x.lines.join(String.fromCharCode(10)).trim() }));
  // 格式类小节只留第一行格式说明，后面的正文挪到商品说明，标题不被长句污染
  const only = [];
  for (const x of flat) {
    const hit = x.title === '账号格式' || x.title === '卡密格式';
    const at = hit ? x.body.indexOf(String.fromCharCode(10)) : -1;
    if (at < 0) { only.push(x); continue; }
    only.push({ title: x.title, body: x.body.slice(0, at).trim() });
    const rest = x.body.slice(at + 1).trim();
    if (rest) only.push({ title: '商品说明', body: rest });
  }
  // 同名小节合并（对方常出现两段「注意事项」），顺序按第一次出现
  const keep = [];
  for (const x of only) {
    if (x.body) { keep.push(x); continue; }
    const lastT = keep.length ? keep[keep.length - 1].title : '';
    // 只有标题没有正文：并进上一节；但格式小节不收留，另开商品说明，避免污染账号格式
    if (keep.length && lastT !== '账号格式' && lastT !== '卡密格式') keep[keep.length - 1].body += String.fromCharCode(10) + x.title;
    else keep.push({ title: '商品说明', body: x.title });
  }
  const merged = new Map();
  for (const x of keep) {
    if (!merged.has(x.title)) merged.set(x.title, x);
    else { const prev = merged.get(x.title); prev.body = prev.body + String.fromCharCode(10) + x.body; }
  }
  return [...merged.values()];
}

/* ---------- 商品详情页：一个商品一个独立页面，地址是 #/g/<id> ---------- */
function findGoods(id) {
  for (const g of catalog) if (Number(g.id) === id) return g;
  return null;
}
function goDetail(g) { location.hash = '#/g/' + g.id; }

function route() {
  const m = /^#\/g\/(\d+)$/.exec(location.hash || '');
  // #/me 之类由会员模块自己画，它接管时这里直接返回
  if (window.FakaMember && window.FakaMember.route(location.hash || '')) return;
  const wrap = $('shopWrap');
  const view = $('detailView');
  if (!m) {
    detailId = 0;
    if (view) { view.style.display = 'none'; view.textContent = ''; }
    if (wrap) wrap.style.display = '';
    paint();
    return;
  }
  if (detailId !== Number(m[1])) { detailId = Number(m[1]); dQty = 1; }
  if (wrap) wrap.style.display = 'none';
  if (view) view.style.display = '';
  renderDetail();
  window.scrollTo(0, 0);
}

function renderDetail() {
  const box = $('detailView');
  box.textContent = '';
  if (!catalog.length) { box.appendChild(el('div', 'empty', '正在加载商品...')); return; }
  const g = findGoods(detailId);

  const crumb = el('div', 'crumb');
  const home = el('button', 'crumb-link', '全部商品');
  home.type = 'button';
  home.addEventListener('click', () => { location.hash = ''; });
  crumb.appendChild(home);
  if (g && g.category) {
    crumb.appendChild(el('span', 'crumb-sep', '›'));
    const cat = el('button', 'crumb-link', g.category);
    cat.type = 'button';
    cat.addEventListener('click', () => { catKey = g.category; location.hash = ''; });
    crumb.appendChild(cat);
  }
  if (g) { crumb.appendChild(el('span', 'crumb-sep', '›')); crumb.appendChild(el('span', 'crumb-cur', g.name)); }
  box.appendChild(crumb);

  if (!g) {
    box.appendChild(el('div', 'empty', '该商品不存在，或已下架'));
    const back = el('button', 'btn btn-primary btn-block', '返回商品列表');
    back.type = 'button';
    back.addEventListener('click', () => { location.hash = ''; });
    box.appendChild(back);
    return;
  }

  const sku = supplierSku(g);
  const info = stockInfo(g);
  const st = stockCellText(g);

  // 头图 + 标题
  const hero = el('div', 'dhero');
  hero.appendChild(el('span', 'dcover', g.cover || '🎁'));
  if (g.category) hero.appendChild(el('span', 'dbadge', g.category));
  const head = el('div', 'dhead');
  head.appendChild(el('h1', null, g.name));
  head.appendChild(el('div', 'dtags', sku ? '货源直发 · 付款后自动发货' : '本店卡密 · 付款后立即发放'));
  hero.appendChild(head);
  box.appendChild(hero);

  // 购买面板
  const buy = el('div', 'dbuy');
  const r1 = el('div', 'dbuy-row');
  r1.appendChild(el('span', 'dbuy-label', '商品价格'));
  const pv = el('span', 'dbuy-price');
  pv.appendChild(el('small', null, '¥'));
  pv.appendChild(document.createTextNode(money(g.price)));
  r1.appendChild(pv);
  r1.appendChild(el('span', 'dbuy-sold', '已售 ' + (Number(g.sales) || 0)));
  buy.appendChild(r1);

  const r2 = el('div', 'dbuy-row');
  r2.appendChild(el('span', 'dbuy-label', '库存状态'));
  const pills = el('span', 'dbuy-pills');
  // 「下架 / 直发 / 不限量」这类文字不加单位，只有纯数字才加「件 / 张」
  const qtyText = /^[0-9]+$/.test(st.text) ? st.text + (sku ? '件' : '张') : st.text;
  const p1 = el('span', 'pill ' + (info.sellable ? 'ok' : 'bad'), qtyText);
  pills.appendChild(p1);
  pills.appendChild(el('span', 'pill', sku ? '自动发货' : '本店库存'));
  r2.appendChild(pills);
  buy.appendChild(r2);

  dQty = Math.min(Math.max(1, dQty), Math.max(1, info.max));
  const r3 = el('div', 'dbuy-row');
  r3.appendChild(el('span', 'dbuy-label', '购买数量'));
  const step = el('span', 'qty-row');
  const minus = el('button', 'qty-btn', '−');
  minus.type = 'button';
  const num = el('span', 'qty-num', String(dQty));
  const plus = el('button', 'qty-btn', '+');
  plus.type = 'button';
  const setQty = (v) => {
    dQty = Math.min(Math.max(1, v), Math.max(1, info.max));
    num.textContent = String(dQty);
    total.textContent = '¥ ' + money(g.price * dQty);
  };
  minus.addEventListener('click', () => setQty(dQty - 1));
  plus.addEventListener('click', () => setQty(dQty + 1));
  step.appendChild(minus); step.appendChild(num); step.appendChild(plus);
  r3.appendChild(step);
  buy.appendChild(r3);

  const r4 = el('div', 'dbuy-row');
  r4.appendChild(el('span', 'dbuy-label', '订单金额'));
  const total = el('span', 'dbuy-total', '¥ ' + money(g.price * dQty));
  r4.appendChild(total);
  buy.appendChild(r4);

  const go = el('button', 'btn btn-primary btn-block', info.sellable ? '立即购买' : '暂时缺货');
  go.type = 'button';
  go.disabled = !info.sellable;
  go.addEventListener('click', () => openBuy(g, dQty));
  buy.appendChild(go);
  box.appendChild(buy);

  // 商品介绍
  const card = el('div', 'dcard');
  card.appendChild(el('h3', null, '商品介绍'));
  card.appendChild(infoBlock('商品名称', String(g.name || '')));
  let desc = String(g.description || '').trim();
  if (desc === '货源直发 · 付款后自动发货') desc = '';   // 批量建商品留下的占位文案，不是真说明
  const detail = String(g.detail || '').trim();
  const blocks = [];
  if (desc) blocks.push({ title: '商品说明', body: desc });
  const extra = [];
  for (const x of parseSections(detail)) {
    if (x.title === '商品名称') {
      // 这一节通常就是商品名本身（顶部已显示），但对方常把警告语塞在同一节里，不能丢
      for (const l of x.body.split(String.fromCharCode(10))) {
        if (l.trim() && l.trim() !== String(g.name || '').trim()) extra.push(l.trim());
      }
      continue;
    }
    // 详情里也有一段「商品说明」时改叫「商品详情」，别出现两个同名小节
    blocks.push({ title: x.title === '商品说明' && desc ? '商品详情' : x.title, body: x.body });
  }
  if (extra.length) {
    const head = blocks.length && blocks[0].title === '商品说明' ? blocks.shift() : null;
    const BRK = String.fromCharCode(10);
    blocks.unshift({ title: '商品说明', body: [head ? head.body : '', extra.join(BRK)].filter(Boolean).join(BRK + BRK) });
  }
  if (!blocks.length) blocks.push({ title: '商品说明', body: '卖家暂未填写说明' });
  for (const x of blocks) card.appendChild(infoBlock(x.title, x.body, true));
  card.appendChild(infoBlock('发货方式', sku
    ? '货源直发：付款后系统自动向货源方下单，卡密回传后发到你的邮箱'
    : '本店卡密：付款后立即发放'));
  card.appendChild(noticeBlock(false));   // 取代原来那条单行「购买须知」，小节数量不变
  box.appendChild(card);
}
/* ---------- 购买 ---------- */
function openBuy(g, presetQty) {
  current = g;
  qty = Math.min(Math.max(1, Math.floor(Number(presetQty) || 1)), maxQty(g));
  $('qtyNum').textContent = String(qty);
  $('buyEmail').value = localStorage.getItem('FAKA_EMAIL') || '';
  const sum = $('buySummary');
  sum.textContent = '';
  sum.appendChild(el('div', 'cover', g.cover || '🎁'));
  const info = el('div');
  info.appendChild(el('div', 'name', g.name));
  info.appendChild(el('div', 'sub', `单价 ¥${money(g.price)} / 张`));
  sum.appendChild(info);
  const hint = $('buyStockHint');
  const sinfo = stockInfo(g);
  if (hint) hint.textContent = supplierSku(g)
    ? (sinfo.max >= 10 ? '（货源直发，单次 1~10 件）' : `（货源仅剩 ${sinfo.max} 件，单次最多 ${sinfo.max} 件）`)
    : `（剩余库存 ${Number(g.stock) || 0} 张）`;
  const bn = $('buyNotice');
  if (bn) { bn.textContent = ''; bn.appendChild(noticeBlock(true)); }   // 每次打开都重渲染，切语言也不会残留旧文案
  updateTotal();
  show('buyModal');
  $('buyEmail').focus();
}

// 单次最多买几件：代发商品受对方库存限制（以前按本店卡密算，代发商品恒为 1 件）
function maxQty(g) {
  return Math.max(1, Math.min(10, stockInfo(g).max || 1));
}
function changeQty(d) {
  if (!current) return;
  qty = Math.min(Math.max(1, qty + d), maxQty(current));
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
    orderIsSupplier = !!supplierSku(current);   // 商品带了对方 sku = 这单会自动发给货源方
    localStorage.setItem('FAKA_EMAIL', email);
    hide('buyModal');
    openPayModal();
    loadCatalog();
  } finally {
    btn.disabled = false;
    btn.textContent = '立即下单';
  }
}

/* ---------- 余额支付（第 18 步：先充值，再用余额买东西） ---------- */
const MEM = () => window.FakaMember || null;
const memberToken = () => { try { return localStorage.getItem('FAKA_MEMBER_TOKEN') || ''; } catch (e) { return ''; } };
function drawBalance(m) {
  const num = $('balanceNum');
  const pay = $('balancePayBtn');
  const rc = $('goRechargeBtn');
  const flags = (m && m.walletFlags) ? (m.walletFlags() || {}) : {};
  if (flags.balance_pay_open === false) {
    const row = $('balanceRow');
    if (row) row.style.display = 'none';
    return;
  }
  const bal = m && m.balanceFen ? m.balanceFen() : 0;
  const need = Number((order && order.amount) || 0);
  if (num) num.textContent = '¥' + money(bal);
  if (pay) {
    pay.disabled = bal < need;
    pay.textContent = pay.disabled ? '余额不足，先去充值' : ('用余额支付 ¥' + money(need));
  }
  if (rc) rc.style.display = (pay && pay.disabled) ? '' : 'none';
}
function paintBalanceRow() {
  const row = $('balanceRow');
  if (!row) return;
  const m = MEM();
  if (!m || !order || !memberToken()) { row.style.display = 'none'; return; }
  row.style.display = '';
  drawBalance(m);
  // 后台悄悄把余额拉最新（第一次进弹窗时可能还没拉到）
  if (m.refreshWallet) Promise.resolve(m.refreshWallet()).then(() => drawBalance(m)).catch(() => { /* 拉不到就用本地这份 */ });
}
async function balancePay() {
  const m = MEM();
  if (!m || !order) return;
  const tk = memberToken();
  if (!tk) { toast('请先登录后再用余额支付'); return; }
  const need = Number(order.amount || 0);
  if (m.balanceFen() < need) { toast('余额不足，请先充值'); return; }
  if (!confirm('确认用余额支付 ¥' + money(need) + ' ？')) return;
  const b = $('balancePayBtn');
  if (b) { b.disabled = true; b.textContent = '支付中...'; }
  try {
    const { data, error } = await supa.rpc('rpc_pay_order_by_balance', {
      p_token: tk, p_order_id: order.order_id, p_email: order.email,
    });
    if (error) { toast(errText(error)); return; }
    if (!data || data.ok !== true) { toast(errText({ message: (data && data.error) || 'BAD_AMOUNT' })); return; }
    if (m.refreshWallet) m.refreshWallet();
    stopPolling();
    hide('payModal');
    deliver(data);
    order = null;   // 必须等 deliver 读完 email 再清
    loadCatalog();
  } finally {
    if (b) { b.disabled = false; b.textContent = '用余额支付，秒发货'; }
  }
}

/* ---------- 支付（等待回调，不在本地判定成功） ---------- */
function openPayModal() {
  $('payAmount').textContent = money(order.amount);
  $('payOrderId').textContent = order.order_id;
  $('payGoodsName').textContent = order.goods_name;
  $('payQty').textContent = `${order.qty} 张`;
  $('payStatus').textContent = '等待支付结果…';
  paintBalanceRow();
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
function paintCards(cards) {
  currentCards = Array.isArray(cards) ? cards : [];
  const list = $('cardList');
  list.textContent = '';
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
  $('copyAllBtn').style.display = currentCards.length ? 'block' : 'none';
}

function setResultHead(title, icon, bg, color) {
  const ttl = $('resultTitle');
  const ico = $('resultIcon');
  if (ttl) ttl.textContent = title;
  if (ico) { ico.textContent = icon; ico.style.background = bg; ico.style.color = color; }
}

function hintLine(text) {
  const list = $('cardList');
  list.insertBefore(el('div', 'hint-line', text), list.firstChild);
}

function stopCardPolling() {
  if (cardTimer) { clearInterval(cardTimer); cardTimer = null; }
}

/* 货源方出货要时间：结果弹窗自己盯 3 分钟，卡密一到就地刷出来 */
async function fetchCards(quiet) {
  if (!resultCtx || !resultCtx.email) return;
  const { data, error } = await supa.rpc('rpc_order_lookup', {
    p_order_id: resultCtx.order_id, p_email: resultCtx.email,
  });
  if (error) { if (!quiet) toast(errText(error)); return; }
  if (!data || data.found === false) { if (!quiet) toast('订单还在处理中，稍等半分钟再点'); return; }
  const cards = Array.isArray(data.cards) ? data.cards : [];
  if (cards.length) {
    stopCardPolling();
    paintCards(cards);
    setResultHead('卡密已自动发货，请及时复制保存', '✓', '#e8f9ef', '');
    const rb = $('refreshCardsBtn');
    if (rb) rb.style.display = 'none';
    toast('卡密已到，请复制保存');
  } else if (!quiet) {
    toast('货源方还在出货，再等一分钟');
  }
}

function startCardPolling() {
  stopCardPolling();
  cardTries = 0;
  cardTimer = setInterval(() => {
    cardTries += 1;
    if (cardTries > 18) { stopCardPolling(); return; }
    fetchCards(true);
  }, 10000);
}

function deliver(data) {
  resultCtx = { order_id: data.order_id, email: (order && order.email) || '' };
  const cards = Array.isArray(data.cards) ? data.cards : [];
  $('resultOrderId').textContent = data.order_id;
  paintCards(cards);
  const rb = $('refreshCardsBtn');
  if (cards.length) {
    setResultHead('卡密已自动发货，请及时复制保存', '✓', '#e8f9ef', '');
    if (rb) rb.style.display = 'none';
    stopCardPolling();
  } else if (orderIsSupplier) {
    // 代发单：系统已经自动把订单发给货源方了，只是对方出卡密要几秒到几分钟
    setResultHead('已收款，货源方正在出货', '…', '#fff7e6', '#b76e00');
    hintLine('系统已自动向货源方下单，一般 1~5 分钟内出卡密。这个窗口会自动刷新，也可稍后用订单号查询。');
    if (rb) rb.style.display = 'block';
    startCardPolling();
  } else {
    setResultHead('已收款，卡密待补发', '…', '#fff7e6', '#b76e00');
    hintLine('该商品本店暂无现货卡密，订单已登记为待补发，通常几分钟内自动到货；请稍后用订单号查询。');
    if (rb) rb.style.display = 'none';
    stopCardPolling();
  }
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
    m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'payModal') hide(m.id); }));

  $('qtyMinus').addEventListener('click', () => changeQty(-1));
  $('qtyPlus').addEventListener('click', () => changeQty(1));
  $('submitOrderBtn').addEventListener('click', submitOrder);
  $('payRefreshBtn').addEventListener('click', () => refreshPayStatus(false));
  document.querySelectorAll('[data-act="balance-pay"]').forEach((b) =>
    b.addEventListener('click', balancePay));
  // 充值到账以后重画一次支付弹窗里的余额
  document.addEventListener('faka-wallet', () => { if ($('payModal') && $('payModal').classList.contains('show')) paintBalanceRow(); });
  $('copyAllBtn').addEventListener('click', () => copyText(currentCards.join('\n'), null));
  // 按钮在 index.html 里；万一只传了 js 没传 html，也不能连累后面的事件绑定
  const rcb = $('refreshCardsBtn');
  if (rcb) rcb.addEventListener('click', () => fetchCards(false));
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

  const vl = $('viewListBtn');
  if (vl) vl.addEventListener('click', () => setViewMode('list'));
  const vg = $('viewGridBtn');
  if (vg) vg.addEventListener('click', () => setViewMode('grid'));
  window.addEventListener('hashchange', route);
  // 语言切换：中文是原文，切英文时重画一遍最稳（避免把已经翻过的再翻一次）
  document.addEventListener('faka-lang', () => { loadSite().then(route); });
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
  const hn = $('homeNotice');
  if (hn) hn.appendChild(noticeBlock(true, 'home'));   // 声明要放在第一屏，不能只藏在详情页和页脚
  loadViewMode();
  bind();
  paintViewBtns();
  await loadSite();
  loadCatalog();
});
