/* 2FA / TOTP 验证码生成器 —— 全部计算在本机浏览器里完成。
   安全约定：本页不请求任何接口，密钥只存在本机 localStorage，
   不进 URL、不进日志、不发往服务器。 */
'use strict';

/* 防点击劫持。GitHub Pages 不支持自定义响应头，而 frame-ancestors 只能通过 HTTP 头生效
   （写进 <meta> 浏览器会直接忽略），所以只能在前端自检：
   发现自己被别的网站用 iframe 套进去时，立刻把外层窗口跳回本站真实地址；
   跳不动（浏览器策略拦）就把页面清空，不给套壳站留任何可点的东西。
   同源嵌入放行：否则本地预览、后台里自己嵌自己都会被误杀。 */
if (window.top !== window.self) {
  var fakaSameOrigin = false;
  try { fakaSameOrigin = window.top.location.hostname === window.location.hostname; } catch (e) { fakaSameOrigin = false; }
  if (!fakaSameOrigin) {
    try { window.top.location.replace(window.location.href); } catch (e) { /* 被跨源策略拦掉是预期，下面兜底 */ }
    document.addEventListener('DOMContentLoaded', function () {
      document.documentElement.innerHTML = '<title>禁止嵌入</title><body style="font:16px/1.8 system-ui;padding:48px">本站不允许被其他网站嵌入显示，请直接打开官网。</body>';
    });
  }
}

/* ==LOGIC-START== */
const B32ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STORE_KEY = 'FAKA_TOTP_KEYS';

// Base32 解码（RFC 4648）。容忍空格、连字符、大小写和末尾 = 填充。
function b32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s\-|=]/g, '');
  if (!clean) return { bytes: null, error: '请输入密钥' };
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32ALPHABET.indexOf(clean[i]);
    if (idx < 0) {
      return { bytes: null, error: '密钥含非法字符「' + clean[i] + '」，Base32 只用 A-Z 和 2-7' };
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < 10) return { bytes: null, error: '密钥太短（至少 16 位 Base32）' };
  return { bytes: new Uint8Array(out), error: '' };
}

// 直接粘 otpauth://totp/... 也能用：把 secret / 位数 / 周期 / 算法一次解析出来
function parseOtpauth(text) {
  const t = String(text || '').trim();
  if (!/^otpauth:\/\/(totp|hotp)\//i.test(t)) return null;
  const qs = t.indexOf('?') >= 0 ? t.slice(t.indexOf('?') + 1) : '';
  const p = {};
  qs.split('&').forEach((kv) => {
    if (!kv) return;
    const i = kv.indexOf('=');
    const k = (i < 0 ? kv : kv.slice(0, i)).toLowerCase();
    const v = i < 0 ? '' : kv.slice(i + 1);
    try { p[k] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { p[k] = v; }
  });
  // otpauth://totp/<issuer>:<account>?... —— 先剥掉 scheme 和类型，再取标签
  const m = t.match(/^otpauth:\/\/(?:totp|hotp)\/([^?]*)/i);
  let label = '';
  try { label = decodeURIComponent(m ? m[1] : ''); } catch (e) { label = m ? m[1] : ''; }
  // 标签可能是 'Gmail:buyer@x.com'（取账户名前的 issuer）也可能只有 'Telegram'
  label = (label.indexOf(':') > 0 ? label.slice(0, label.indexOf(':')) : label).trim();
  return {
    secret: p.secret || '',
    name: p.issuer || label || '',
    digits: p.secret ? Number(p.digits) || 0 : 0,
    period: p.secret ? Number(p.period) || 0 : 0,
    algo: p.secret ? String(p.algorithm || '').toUpperCase() : '',
    type: /^otpauth:\/\/hotp\//i.test(t) ? 'hotp' : 'totp',
  };
}

const ALGO_MAP = { 'SHA-1': 'SHA-1', SHA1: 'SHA-1', 'SHA-256': 'SHA-256', SHA256: 'SHA-256', 'SHA-512': 'SHA-512', SHA512: 'SHA-512' };
function normAlgo(a) { return ALGO_MAP[String(a || '').toUpperCase()] || 'SHA-1'; }

// HMAC 计数器 → 一次性口令（RFC 4226 截断）
async function hotp(bytes, counter, digits, algo) {
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: { name: algo } }, false, ['sign']);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % Math.pow(10, digits)).padStart(digits, '0');
}

async function totpOf(bytes, seconds, digits, period, algo) {
  const p = period > 0 ? period : 30;
  return hotp(bytes, Math.floor(seconds / p), digits, algo);
}

// 剩余秒数：决定环形进度和「还有几秒刷新」
function secondsLeft(seconds, period) {
  const p = period > 0 ? period : 30;
  return p - (Math.floor(seconds) % p);
}

const fmtCode = (c) => (c.length === 8 ? c.slice(0, 4) + ' ' + c.slice(4) : c.replace(/(.{3})(?=.)/g, '$1 '));
const maskSecret = (s) => {
  const t = String(s || '').replace(/\s/g, '').toUpperCase();
  if (t.length <= 8) return '•'.repeat(t.length);
  return t.slice(0, 4) + '•'.repeat(Math.min(16, t.length - 8)) + t.slice(-4);
};

// 存储读写：把 localStorage 当参数传进来，方便单测
function loadKeys(store) {
  let raw = '';
  try { raw = store.getItem(STORE_KEY) || ''; } catch (e) { return []; }
  if (!raw) return [];
  let arr = null;
  try { arr = JSON.parse(raw); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter((k) => k && typeof k.secret === 'string' && k.secret)
    .slice(0, 200)
    .map((k) => ({
      id: String(k.id || ''),
      name: String(k.name || '').slice(0, 40),
      secret: String(k.secret).toUpperCase().replace(/[\s\-|=]/g, '').slice(0, 256),
      digits: [6, 8].indexOf(Number(k.digits)) >= 0 ? Number(k.digits) : 6,
      period: [15, 30, 60].indexOf(Number(k.period)) >= 0 ? Number(k.period) : 30,
      algo: normAlgo(k.algo),
    }));
}
function saveKeys(store, list) {
  try { store.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}
/* ==LOGIC-END== */

/* ---------- 以下全是本机 DOM 逻辑，不发任何网络请求 ---------- */
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
let toastTimer = null;
function toast(msg) {
  const t = $('tkToast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function copyText(text, okMsg) {
  const done = () => toast(okMsg || ('已复制 ' + text));
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中'); }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
const RING_C = 2 * Math.PI * 19;
function paintRing(circle, secs, period) {
  if (!circle) return;
  circle.style.strokeDasharray = RING_C.toFixed(1);
  circle.style.strokeDashoffset = (RING_C * (1 - secs / period)).toFixed(1);
  circle.style.stroke = secs <= 5 ? '#ef4444' : '#635bff';
}

let keys = [];
let reveal = {};       // id -> true 时显示完整密钥
let live = null;       // 当前输入框算出来的结果

// 解析输入：otpauth 链接优先，其次纯 Base32
function readInput() {
  const raw = $('tkSecret').value.trim();
  if (!raw) return { error: '', empty: true };
  const o = parseOtpauth(raw);
  if (o) {
    if (o.type === 'hotp') return { error: '这是计数器型（HOTP）密钥，本页只支持时间型 TOTP' };
    if (o.digits) $('tkDigits').value = String(o.digits);
    if (o.period) $('tkPeriod').value = String(o.period);
    if (o.algo) $('tkAlgo').value = o.algo;
    if (o.name && !$('tkName').value.trim()) $('tkName').value = o.name.slice(0, 40);
    return decode(o.secret);
  }
  return decode(raw);
}
function decode(secret) {
  const d = b32Decode(secret);
  if (d.error) return { error: d.error };
  return {
    error: '',
    // 存下来的是真正的密钥：粘贴 otpauth:// 链接时不能把整条链接当密钥存
    secret: String(secret).toUpperCase().replace(/[\s\-|=]/g, ''),
    bytes: d.bytes,
    digits: [6, 8].indexOf(Number($('tkDigits').value)) >= 0 ? Number($('tkDigits').value) : 6,
    period: [15, 30, 60].indexOf(Number($('tkPeriod').value)) >= 0 ? Number($('tkPeriod').value) : 30,
    algo: normAlgo($('tkAlgo').value),
  };
}

async function refreshLive() {
  const box = $('tkLive');
  const codeEl = $('tkLiveCode');
  const wrap = $('tkLiveWrap');
  const errEl = $('tkLiveErr');
  const r = readInput();
  if (r.empty) {
    // 输入框是空的（刚保存完会被清空）：收起实时区，别去算 HMAC
    live = null;
    if (wrap) wrap.style.visibility = 'hidden';
    box.classList.remove('on');
    errEl.textContent = '';
    errEl.style.display = 'none';
    $('tkSaveBtn').disabled = true;
    return;
  }
  if (r.error) {
    live = null;
    if (wrap) wrap.style.visibility = 'hidden';
    box.classList.remove('on');
    errEl.textContent = r.error ? '⚠️ ' + r.error : '';
    errEl.style.display = r.error ? 'block' : 'none';
    $('tkSaveBtn').disabled = true;
    return;
  }
  errEl.style.display = 'none';
  $('tkSaveBtn').disabled = false;
  const now = Math.floor(Date.now() / 1000);
  const code = await totpOf(r.bytes, now, r.digits, r.period, r.algo);
  live = Object.assign({ code }, r);
  codeEl.textContent = fmtCode(code);
  codeEl.dataset.code = code;
  $('tkLiveSecs').textContent = secondsLeft(now, r.period) + 's';
  paintRing($('tkLiveRing'), secondsLeft(now, r.period), r.period);
  box.classList.add('on');
  if (wrap) wrap.style.visibility = 'visible';
}

function itemNode(k) {
  const row = el('div', 'tk-item');
  const main = el('div', 'tk-item-main');
  main.appendChild(el('div', 'tk-item-name', k.name || '未命名密钥'));
  const code = el('div', 'tk-item-code', '······');
  code.title = '点击复制验证码';
  main.appendChild(code);
  const sec = el('div', 'tk-item-secret', reveal[k.id] ? k.secret : maskSecret(k.secret));
  main.appendChild(sec);
  row.appendChild(main);

  const side = el('div', 'tk-item-side');
  const ring = el('span', 'tk-ring');
  ring.innerHTML = '<svg viewBox="0 0 44 44" width="34" height="34">'
    + '<circle class="ring-bg" cx="22" cy="22" r="19"></circle>'
    + '<circle class="ring-fg" cx="22" cy="22" r="19" transform="rotate(-90 22 22)"></circle></svg>'
    + '<b class="tk-secs"></b>';
  side.appendChild(ring);
  row.appendChild(side);

  const ops = el('div', 'tk-item-ops');
  const eye = el('button', 'tk-mini', reveal[k.id] ? '隐藏密钥' : '显示密钥');
  eye.type = 'button';
  eye.addEventListener('click', () => { reveal[k.id] = !reveal[k.id]; renderList(); });
  const del = el('button', 'tk-mini tk-danger', '删除');
  del.type = 'button';
  del.addEventListener('click', async () => {
    if (!confirm('删除「' + (k.name || '未命名密钥') + '」？删掉后本机不再保存它的密钥。')) return;
    keys = keys.filter((x) => x.id !== k.id);
    saveKeys(localStorage, keys);
    renderList();
    toast('已删除');
  });
  ops.appendChild(eye);
  ops.appendChild(del);
  row.appendChild(ops);

  row._k = k;
  row._code = code;
  row._sec = sec;
  row._ring = ring.querySelector('.ring-fg');
  row._secs = ring.querySelector('.tk-secs');
  code.addEventListener('click', () => { if (row._real) copyText(row._real); });
  return row;
}

let listNodes = [];
function renderList() {
  const list = $('tkList');
  list.textContent = '';
  listNodes = [];
  if (!keys.length) {
    list.appendChild(el('div', 'tk-empty', '还没有保存的密钥。上面输入密钥 → 点「保存2FA」即可长期管理多个。'));
    $('tkClearBtn').style.display = 'none';
    return;
  }
  $('tkClearBtn').style.display = '';
  for (const k of keys) {
    const n = itemNode(k);
    listNodes.push(n);
    list.appendChild(n);
  }
  refreshList();
}
async function refreshList() {
  const now = Math.floor(Date.now() / 1000);
  for (const row of listNodes) {
    const k = row._k;
    const d = b32Decode(k.secret);
    if (d.error) {
      row._code.textContent = '密钥无效';
      row._code.classList.add('bad');
      row._secs.textContent = '';
      continue;
    }
    const code = await totpOf(d.bytes, now, k.digits, k.period, k.algo);
    row._real = code;
    row._code.textContent = fmtCode(code);
    row._code.classList.remove('bad');
    const left = secondsLeft(now, k.period);
    row._secs.textContent = left + 's';
    paintRing(row._ring, left, k.period);
  }
}

async function saveCurrent() {
  const r = readInput();
  if (!r || r.error) { toast('先填写正确的密钥'); return; }
  const name = $('tkName').value.trim().slice(0, 40) || '未命名密钥';
  const dup = keys.find((k) => k.secret === r.secret);
  if (dup) { toast('这个密钥已经保存过了（' + (dup.name || '未命名') + '）'); return; }
  keys.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    secret: r.secret,
    digits: r.digits,
    period: r.period,
    algo: r.algo,
  });
  if (!saveKeys(localStorage, keys)) { toast('本机存储不可用，没能保存'); return; }
  $('tkSecret').value = '';
  $('tkName').value = '';
  live = null;
  $('tkLiveWrap').style.visibility = 'hidden';
  $('tkLive').classList.remove('on');
  renderList();
  refreshLive();
  toast('已保存到本机浏览器');
}

function bind() {
  const tick = async () => {
    try {
      await refreshLive();
      await refreshList();
    } catch (e) {
      $('tkWarn').textContent = '生成失败：' + (e && e.message ? e.message : e);
      $('tkWarn').style.display = 'block';
    }
  };
  let deb = null;
  ['tkSecret', 'tkName', 'tkDigits', 'tkPeriod', 'tkAlgo'].forEach((id) => {
    const n = $(id);
    n.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(tick, 150); });
    n.addEventListener('change', tick);
  });
  $('tkSecret').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } });
  $('tkSaveBtn').addEventListener('click', saveCurrent);
  $('tkSaveBtn').disabled = true;
  $('tkLiveWrap').addEventListener('click', () => { if (live) copyText(live.code); });
  $('tkAdvBtn').addEventListener('click', () => {
    const box = $('tkAdv');
    const open = box.style.display === 'none';
    box.style.display = open ? 'flex' : 'none';
    $('tkAdvBtn').textContent = open ? '高级选项 ▴' : '高级选项 ▾';
  });
  $('tkClearBtn').addEventListener('click', () => {
    if (!keys.length) return;
    if (!confirm('清除本机保存的全部 ' + keys.length + ' 个密钥？此操作不可撤销，请先确认你在手机验证器里也有备份。')) return;
    keys = [];
    saveKeys(localStorage, keys);
    renderList();
    toast('已清除');
  });
  setInterval(tick, 1000);
  tick();
}

document.addEventListener('DOMContentLoaded', () => {
  if (!window.crypto || !window.crypto.subtle) {
    $('tkWarn').textContent = '⚠️ 当前浏览器不支持 Web Crypto（需要 https 打开）。请改用 Chrome / Edge / Safari，或在手机验证器 App 里生成。';
    $('tkWarn').style.display = 'block';
    $('tkSecret').disabled = true;
    $('tkSaveBtn').disabled = true;
    return;
  }
  try {
    const sn = localStorage.getItem('FAKA_SITE_NAME');
    if (sn && sn.length <= 40) {
      $('tkSiteName').textContent = sn;
      $('tkHome').textContent = '← ' + sn;
      document.title = '2FA 验证码 - ' + sn;
    }
  } catch (e) { /* 无痕模式忽略 */ }
  keys = loadKeys(localStorage);
  renderList();
  bind();
});