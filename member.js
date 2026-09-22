// 发卡商城 · 会员注册 / 登录 + 我的推广
// 只调 4 个白名单 RPC：rpc_member_flags / rpc_signup / rpc_login / rpc_me（+ 退出、改密码）。
// 卡密、订单、价格这些一律不经过这里；密码哈希在数据库里，浏览器拿不到。
'use strict';
(function () {
  const CFG = (typeof window !== 'undefined' && window.FAKA_CONFIG) || {};
  const NL = String.fromCharCode(10);
  const TOK = 'FAKA_MEMBER_TOKEN';
  const REF = 'FAKA_LAST_REF';
  const t = (s, v) => {
    if (window.FakaI18n) return window.FakaI18n.t(s, v);
    let out = String(s);
    if (v) out = out.replace(/\{([a-zA-Z0-9_]+)\}/g, (x, k) => (v[k] === undefined ? x : String(v[k])));
    return out;
  };

  const $ = (id) => document.getElementById(id);
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
  function money(fen) { return ((Number(fen) || 0) / 100).toFixed(2); }
  function fmt(ts) {
    if (!ts) return '-';
    const d = new Date(Number(ts));
    const p = (n) => String(n).length > 1 ? String(n) : '0' + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  let toastTimer = null;
  function toast(msg) {
    const n = $('toast');
    if (!n) return;
    n.textContent = msg;
    n.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => n.classList.remove('show'), 2600);
  }
  function show(id) { const n = $(id); if (n) n.classList.add('show'); }
  function hide(id) { const n = $(id); if (n) n.classList.remove('show'); }

  let supa = null;
  function client() {
    if (supa) return supa;
    if (!CFG.SUPA_URL || !CFG.SUPA_KEY || !window.supabase) return null;
    supa = window.supabase.createClient(CFG.SUPA_URL, CFG.SUPA_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return supa;
  }
  async function rpc(name, args) {
    const c = client();
    if (!c) throw new Error('NO_CLIENT');
    const r = await c.rpc(name, args || {});
    if (r.error) throw new Error(String(r.error.message || r.error));
    return r.data;
  }

  const ERR = {
    BAD_USER: '用户名只能用字母、数字、下划线、点或减号（4-20 位）',
    BAD_PASS: '密码至少 6 位',
    USER_TAKEN: '该用户名已被注册',
    SIGNUP_CLOSED: '注册已关闭',
    SIGNUP_BUSY: '今天注册的人太多了，请明天再试',
    BAD_LOGIN: '用户名或密码不正确',
    TOO_MANY_TRIES: '尝试次数过多，请 10 分钟后再试',
    BAD_OLD_PASS: '原密码不对',
    BAD_TOKEN: '登录状态已失效，请重新登录',
    NO_CLIENT: '请先在站点根目录的 config.js 里填好 Supabase 地址',
    LOW_BALANCE: '余额不足，请先充值',
    PAY_CLOSED: '站长暂时关闭了余额支付',
    BAD_AMOUNT: '充值金额不合法',
    NOT_FOUND: '没找到这笔充值单',
    ORDER_NOT_FOUND: '未找到订单',
    ORDER_CLOSED: '订单已关闭，请重新下单',
    ORDER_EMAIL: '这个订单和下单邮箱对不上',
    ORDER_EXPIRED: '订单已超时关闭，请重新下单',
    TOO_MANY_PENDING: '在途待支付的单子太多了，请先完成支付或稍后再试',
  };
  const errOf = (e) => {
    const m = String((e && e.message) || e || '');
    for (const k in ERR) if (m.indexOf(k) >= 0) return t(ERR[k]);
    if (m.indexOf('NetworkError') >= 0 || m.indexOf('Failed to fetch') >= 0) return t('网络异常，请重试');
    return t('操作失败，请稍后重试');
  };

  let me = null;          // rpc_me 的结果
  let meBusy = false;     // renderMe 正在向后端要最新数据
  let flags = { member_open: true, signup_bonus_fen: 0, invite_bonus_fen: 0 };
  let tab = 'login';

  function token() { try { return localStorage.getItem(TOK) || ''; } catch (e) { return ''; } }
  function setToken(v) { try { if (v) localStorage.setItem(TOK, v); else localStorage.removeItem(TOK); } catch (e) { /* 无痕模式忽略 */ } }
  function refCode() {
    try {
      const q = new URLSearchParams(location.search).get('ref');
      const clean = (q || '').trim().toUpperCase();
      if (/^[A-Z0-9]{6,16}$/.test(clean)) { localStorage.setItem(REF, clean); return clean; }
      return localStorage.getItem(REF) || '';
    } catch (e) { return ''; }
  }
  const linkOf = (code) => location.href.replace(/[#?].*$/, '') + '?ref=' + encodeURIComponent(code || '');

  /* ---------- 钱包 / 充值 ---------- */
  let wallet = null;      // rpc_wallet_info 的结果（余额 + 流水）
  let wal = {
    balance_pay_open: true, recharge_channel: 'manual',
    recharge_min_fen: 100, recharge_max_fen: 5000000,
    recharge_presets: [1000, 3000, 5000, 10000, 30000, 50000], recharge_notice: '',
  };
  let rcNo = '';          // 当前正在等的充值单号
  let rcPick = 0;         // 点选的快捷金额
  let rcTimer = null;     // 轮询定时器
  let rcTick = 0;
  let rcBusy = false;
  let walBusy = false;

  const rcAmount = () => {
    const custom = Math.round(Number(($('rcCustom') && $('rcCustom').value) || 0) * 100);
    if (Number.isFinite(custom) && custom > 0) return custom;
    return rcPick;
  };
  function paintRcAmounts() {
    const box = $('rcAmounts');
    if (!box) return;
    box.textContent = '';
    const list = (Array.isArray(wal.recharge_presets) && wal.recharge_presets.length ? wal.recharge_presets : [1000, 3000, 5000, 10000, 30000, 50000]).slice(0, 12);
    for (const fen of list) {
      const b = el('button', 'btn' + (rcPick === Number(fen) ? ' on' : ''), '¥' + money(fen));
      b.type = 'button';
      b.addEventListener('click', () => {
        rcPick = Number(fen);
        const c = $('rcCustom'); if (c) c.value = '';
        paintRcAmounts();
      });
      box.appendChild(b);
    }
  }
  function rcSay(text, bad) {
    const m = $('rcMsg');
    if (!m) { if (text) toast(text); return; }
    m.textContent = String(text || '');
    m.style.display = text ? '' : 'none';
    m.style.color = bad ? '#c0392b' : '';
  }
  function openRecharge() {
    if (!me) { openAuth('login'); return; }
    stopRcPoll();
    rcNo = ''; rcPick = 0; rcTick = 0;
    const bal = $('rcBalance');
    if (bal) bal.textContent = '¥' + money(balanceFen());
    const cus = $('rcCustom'); if (cus) cus.value = '';
    const notice = $('rcNotice');
    if (notice) {
      const s = String(wal.recharge_notice || '');
      notice.textContent = s;
      notice.style.display = s ? '' : 'none';
    }
    const body = $('rcBody'); if (body) body.textContent = '';
    rcSay('');
    const go = $('rcGoBtn'); if (go) { go.disabled = false; go.textContent = t('生成充值单'); }
    paintRcAmounts();
    show('rechargeModal');
  }
  async function rechargeStart() {
    if (rcBusy) return;
    const fen = rcAmount();
    if (!fen) { rcSay(t('请先选一个金额'), true); return; }
    if (fen < Number(wal.recharge_min_fen || 100) || fen > Number(wal.recharge_max_fen || 5000000)) {
      rcSay(t('金额范围') + ' ¥' + money(wal.recharge_min_fen) + ' ~ ¥' + money(wal.recharge_max_fen), true);
      return;
    }
    rcBusy = true;
    const go = $('rcGoBtn'); if (go) go.disabled = true;
    try {
      const d = await rpc('rpc_recharge_start', { p_token: token(), p_amount_fen: fen });
      if (!d || d.ok !== true) { rcSay(errOf({ message: (d && d.error) || 'BAD_AMOUNT' }), true); return; }
      rcNo = String(d.out_trade_no || '');
      rcTick = 0;
      await renderRcStep(d);
      const btn2 = $('rcGoBtn'); if (btn2) btn2.textContent = t('我已完成支付');
      startRcPoll();
    } catch (e) { rcSay(errOf(e), true); }
    rcBusy = false; if (go) go.disabled = false;
  }
  async function renderRcStep(d) {
    const body = $('rcBody');
    if (!body) return;
    body.textContent = '';
    const no = el('div', 'rc-no');
    no.appendChild(el('div', null, t('充值单号') + '：'));
    no.appendChild(el('b', null, String(d.out_trade_no)));
    no.appendChild(el('div', null, t('金额') + ' ¥' + money(d.amount_fen)));
    body.appendChild(no);
    // 支付宝渠道：问 Edge Function 要收银台链接。拿不到码就报错，绝不静默退回人工文案
    const wantAlipay = d.channel === 'alipay' || d.channel === 'alipay_qr';
    let pay = null;
    if (wantAlipay) {
      const wait = el('div', 'me-note', t('正在连接支付宝，最多需要 30 秒，请稍候…'));
      body.appendChild(wait);
      pay = await payFn({ action: 'create', out_trade_no: d.out_trade_no,
        mode: d.channel === 'alipay_qr' ? 'qr' : 'page' });
      if (wait.parentNode) wait.parentNode.removeChild(wait);
    }
    if (pay && pay.ok === true && pay.mode === 'alipay' && (pay.qr_url || pay.pay_url)) {
      if (pay.qr_url) {
        const wrap = el('div', 'rc-qrbox');
        fakaQr(wrap, String(pay.qr_url));
        wrap.appendChild(el('div', 'me-note', t('打开支付宝 App → 扫一扫，对准上面的二维码付款')));
        wrap.appendChild(el('div', 'me-note', t('这个码只对应本单，30 分钟内有效；关掉重开会换一张新码')));
        body.appendChild(wrap);
      }
      if (pay.pay_url) {
        const go = el('a', 'btn btn-primary btn-block');
        go.textContent = t('打开支付宝付款');
        go.href = String(pay.pay_url);
        go.target = '_blank'; go.rel = 'noopener noreferrer';
        body.appendChild(go);
      } else if (pay.qr_url) {
        const alt = el('a', 'btn btn-ghost btn-block');
        alt.textContent = t('手机上打不开？点这里直接在支付宝里打开');
        alt.href = String(pay.qr_url); alt.target = '_blank'; alt.rel = 'noopener noreferrer';
        body.appendChild(alt);
      }
      body.appendChild(el('div', 'me-note', t('付款成功后这个页面会自动到账，不用手动刷新')));
    } else if (wantAlipay) {
      const err = pay && pay.error ? String(pay.error)
        : (pay && pay.ok === true ? 'NO_QR_URL' : 'NETWORK');
      const msg = t('支付宝下单失败：{err}', { err: err });
      rcSay(msg, true);
      // rcMsg 会被 4 秒一次的轮询覆盖，错误必须同时钉在弹窗正文里才看得见
      body.appendChild(el('div', 'me-note', msg));
      body.appendChild(el('div', 'me-note', t('请稍后重试，或联系站长处理')));
    } else {
      body.appendChild(el('div', 'me-note', t('请转账 ¥{amt}，并把上面的充值单号发给站长', { amt: money(d.amount_fen) })));
      body.appendChild(el('div', 'me-note', t('站长在后台点「确认入账」后，余额会立刻到账')));
    }
  }
  // 用自托管的 qr.js（qrcode-generator, MIT）把支付宝返回的 qr_code 画成可扫的码
  function fakaQr(box, text) {
    if (!box || !text) return false;
    if (typeof qrcode !== 'function') {
      box.appendChild(el('div', 'me-note', t('二维码组件没加载，请用上面的链接付款')));
      return false;
    }
    let qr = null;
    try { qr = qrcode(0, 'M'); qr.addData(String(text)); qr.make(); } catch (e) { return false; }
    const n = qr.getModuleCount();
    const quiet = 2;
    const cell = Math.max(4, Math.min(8, Math.floor(240 / (n + quiet * 2))));
    const size = (n + quiet * 2) * cell;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    cv.setAttribute('aria-label', t('支付宝收款二维码'));
    cv.style.cssText = 'display:block;margin:12px auto 6px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;image-rendering:pixelated';
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#0f172a';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
    box.appendChild(cv);
    return true;
  }
  async function payFn(payload) {
    const opt = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
    // 支付宝网关最坏要等 2 x 12 秒，再叠上函数冷启动；浏览器侧再兜一个 35 秒上限，
    // 绝不让「生成充值单」按钮无限灰着而不给任何解释。
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        opt.signal = AbortSignal.timeout(35000);
      }
    } catch (e) { /* 老浏览器没这个 API，忽略即可 */ }
    let res = null;
    try { res = await fetch(CFG.SUPA_URL.replace(/\/+$/, '') + '/functions/v1/alipay-pay', opt); }
    catch (e) { return { ok: false, mode: 'manual', error: 'NETWORK' }; }
    if (!res || typeof res.text !== 'function') return { ok: false, mode: 'manual', error: 'NETWORK' };
    let txt = '';
    try { txt = await res.text(); } catch (e) { return { ok: false, mode: 'manual', error: 'NETWORK' }; }
    // status 可能拿不到（测试桩就没有），所以只在明确不是 200 时才判定失败
    if (typeof res.status === 'number' && res.status !== 200) {
      return { ok: false, mode: 'manual', error: 'HTTP_' + res.status };
    }
    try { return JSON.parse(txt); } catch (e) { return { ok: false, mode: 'manual', error: 'BAD_JSON' }; }
  }
  function startRcPoll() {
    stopRcPoll();
    rcTimer = setInterval(() => { rcTick++; rcPoll(true); }, 4000);
    rcPoll(false);
  }
  function stopRcPoll() { if (rcTimer) { clearInterval(rcTimer); rcTimer = null; } }
  async function rcPoll(silent) {
    if (!rcNo || !token()) return;
    // 支付宝渠道偶尔回调进不来：每 12 秒主动去查一次单补账
    if (rcTick > 0 && rcTick % 3 === 0) await payFn({ action: 'query', out_trade_no: rcNo });
    let d = null;
    try { d = await rpc('rpc_recharge_status', { p_token: token(), p_out_trade_no: rcNo }); }
    catch (e) { if (!silent) rcSay(errOf(e), true); return; }
    if (!d || d.ok !== true) { if (!silent) rcSay(errOf({ message: d && d.error || 'NOT_FOUND' }), true); return; }
    if (d.status === 'paid') {
      stopRcPoll();
      rcSay(t('已到账') + ' ¥' + money(d.amount_fen), false);
      const bal = $('rcBalance'); if (bal) bal.textContent = '¥' + money(d.balance_fen);
      await loadWallet(true);
      toast(t('充值已到账'));
      const go = $('rcGoBtn'); if (go) go.textContent = t('关闭');
      return;
    }
    if (!silent) rcSay(t('还在等待到账') + '…', false);
  }

  async function loadWallet(force) {
    if (!token()) { wallet = null; return null; }
    if (walBusy && !force) return wallet;
    walBusy = true;
    try {
      const d = await rpc('rpc_wallet_info', { p_token: token() });
      if (d && d.ok === true) wallet = d;
      if (me) me.balance_fen = Number((wallet && wallet.balance_fen) != null ? wallet.balance_fen : me.balance_fen);
    } catch (e) { /* 没执行 11-wallet.sql 时这里会失败，不影响登录 */ }
    walBusy = false;
    paintBtns();
    try { document.dispatchEvent(new Event('faka-wallet')); } catch (e) { /* 老浏览器忽略 */ }
    return wallet;
  }
  const balanceFen = () => Number((wallet && wallet.balance_fen) != null ? wallet.balance_fen : ((me && me.balance_fen) || 0));
  async function loadWalFlags() {
    try {
      const f = await rpc('rpc_wallet_flags', {});
      if (f && f.ok !== false) wal = Object.assign(wal, f);
    } catch (e) { /* 老版本没有这个函数就按默认值 */ }
  }


  const RC_KIND = {
    recharge: '充值到账', consume: '余额消费', refund: '退款', admin: '人工调整', bonus: '奖励金',
  };
  function walletCard() {
    const card = el('div', 'dcard');
    const h = el('h3', null, t('我的钱包') + ' · ¥' + money(balanceFen()));
    card.appendChild(h);
    const row = el('div', 'me-pills');
    row.appendChild(el('span', 'pill ok', '¥' + money(balanceFen()) + ' ' + t('可用余额')));
    row.appendChild(el('span', 'pill', t('累计充值') + ' ¥' + money((wallet && wallet.recharged_fen) || 0)));
    row.appendChild(el('span', 'pill', t('累计消费') + ' ¥' + money((wallet && wallet.spent_fen) || 0)));
    card.appendChild(row);
    card.appendChild(btn('btn btn-primary', t('充值余额'), openRecharge));
    if (!wallet) card.appendChild(el('div', 'me-note', t('余额功能还没开通：请到 Supabase 执行 11-wallet.sql')));
    const tx = (wallet && Array.isArray(wallet.tx)) ? wallet.tx : [];
    card.appendChild(el('div', 'me-sub', t('收支明细')));
    if (!tx.length) card.appendChild(el('div', 'me-note', t('暂无记录')));
    for (const r of tx.slice(0, 20)) {
      const line = el('div', 'me-line');
      const amt = Number(r.amount) || 0;
      line.appendChild(el('span', null, (amt >= 0 ? '+' : '-') + money(Math.abs(amt)) + ' ' + t(RC_KIND[r.kind] || r.kind || '')));
      line.appendChild(el('small', null, fmt(r.at) + (r.ref ? ' · ' + String(r.ref) : '')));
      card.appendChild(line);
    }
    return card;
  }

  function rechargeGo() {
    if (rcNo) {
      const paid = wallet && (wallet.tx || []).some((x) => String(x.ref || '') === rcNo);
      if (paid) { hide('rechargeModal'); return; }
      rcPoll(false);
      return;
    }
    rechargeStart();
  }

  /* ---------- 顶栏按钮 ---------- */
  function paintBtns() {
    document.querySelectorAll('[data-act="open-account"]').forEach((b) => {
      b.textContent = me
        ? (t('我的钱包') + ' · ' + me.username + ' · ¥' + money(balanceFen()))
        : (flags.member_open ? t('登录 / 注册') : t('登录'));
    });
  }

  /* ---------- 登录 / 注册弹窗 ---------- */
  function paintTab() {
    const isReg = tab === 'signup';
    document.querySelectorAll('[data-authtab]').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-authtab') === tab);
    });
    const ti = $('authTitleText');
    if (ti) ti.textContent = isReg ? t('会员注册') : t('会员登录');
    const show = (id, on) => { const n = $(id); if (n) n.style.display = on ? '' : 'none'; };
    show('authRefItem', isReg);
    show('authPass2Item', isReg);
    const swap = $('authSwap');
    if (swap) {
      swap.textContent = isReg ? t('已有账号？去登录') : t('还没有账号？注册一个');
      swap.style.display = (isReg || flags.member_open) ? '' : 'none';
    }
    const go = $('authBtn');
    if (go) go.textContent = isReg ? t('注册') : t('登录');
    const hint = $('authHint');
    if (hint) {
      if (!isReg) hint.textContent = '';
      else {
        const bits = [];
        if (Number(flags.signup_bonus_fen) > 0) bits.push(t('注册送') + ' ¥' + money(flags.signup_bonus_fen));
        if (Number(flags.invite_bonus_fen) > 0) bits.push(t('邀请奖励') + ' ¥' + money(flags.invite_bonus_fen));
        hint.textContent = bits.join(' · ');
      }
    }
  }
  function openAuth(mode) {
    if (mode) tab = mode;
    if (tab === 'signup' && !flags.member_open) tab = 'login';
    paintTab();
    const mg = $('authMsg');
    if (mg) { mg.textContent = ''; mg.className = 'auth-msg'; }
    const r = $('authRef');
    if (r && !r.value) r.value = refCode();
    show('authModal');
    const first = $('authUser');
    if (first) setTimeout(() => { try { first.focus(); } catch (e) { /* 忽略 */ } }, 60);
  }
  function setMsg(text, bad) {
    const m = $('authMsg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'auth-msg' + (bad ? ' bad' : '');
  }
  async function submitAuth() {
    const b = $('authBtn');
    const user = String(($('authUser') && $('authUser').value) || '').trim();
    const pass = String(($('authPass') && $('authPass').value) || '');
    if (!user || !pass) { setMsg(t('请填写用户名和密码'), true); return; }
    if (tab === 'signup') {
      const p2 = String(($('authPass2') && $('authPass2').value) || '');
      if (pass !== p2) { setMsg(t('两次输入的密码不一样'), true); return; }
    }
    if (b) { b.disabled = true; b.textContent = t('提交中...'); }
    try {
      const data = tab === 'signup'
        ? await rpc('rpc_signup', { p_user: user, p_pass: pass, p_ref: String(($('authRef') && $('authRef').value) || '').trim() })
        : await rpc('rpc_login', { p_user: user, p_pass: pass });
      if (!data || data.ok !== true || !data.token) throw new Error(tab === 'signup' ? 'USER_TAKEN' : 'BAD_LOGIN');
      setToken(data.token);
      me = data;
      await loadWallet(true).catch(() => { /* 没跑 11-wallet.sql 也不影响登录 */ });
      paintBtns();
      hide('authModal');
      if (tab === 'signup') { try { localStorage.removeItem(REF); } catch (e) { /* 忽略 */ } }
      toast(tab === 'signup' ? t('注册成功') : t('登录成功'));
      const au = $('authUser'); const ap = $('authPass'); const ap2 = $('authPass2');
      if (au) au.value = '';
      if (ap) ap.value = '';
      if (ap2) ap2.value = '';
      renderMe();
    } catch (e) {
      setMsg(errOf(e), true);
    } finally {
      if (b) { b.disabled = false; paintTab(); }
    }
  }
  async function doLogout() {
    const tk = token();
    if (tk) { try { await rpc('rpc_logout', { p_token: tk }); } catch (e) { /* 本地照样退出 */ } }
    setToken('');
    me = null;
    wallet = null;
    stopRcPoll();
    paintBtns();
    toast(t('已退出登录'));
    location.hash = '';
  }
  async function changePass() {
    const o = prompt(t('原密码') + ':');
    if (o === null) return;
    const n1 = prompt(t('新密码') + '（' + t('至少 6 位') + '）:');
    if (n1 === null) return;
    try {
      const data = await rpc('rpc_change_pass', { p_token: token(), p_old: o, p_new: n1 });
      if (!data || data.ok !== true) throw new Error('BAD_OLD_PASS');
      setToken(String(data.token || ''));
      toast(t('密码已修改'));
    } catch (e) { toast(errOf(e)); }
  }
  function copy(text) {
    const done = () => toast(t('已复制'));
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {});
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast(t('复制失败，请手动选择')); }
      document.body.removeChild(ta);
    }
  }

  /* ---------- 我的推广页 #/me ---------- */
  function kvCard(title, rows) {
    const card = el('div', 'dcard');
    card.appendChild(el('h3', null, title));
    for (const r of rows) {
      const row = el('div', 'me-kv');
      row.appendChild(el('span', 'me-k', r[0]));
      row.appendChild(el('span', 'me-v', r[1]));
      card.appendChild(row);
    }
    return card;
  }
  async function renderMe() {
    const box = $('meView');
    if (!box) return;
    if (token() && !meBusy) {
      meBusy = true;
      try {
        const fresh = await rpc('rpc_me', { p_token: token() });
        if (fresh && fresh.ok === true) me = fresh;
      } catch (e) { /* 断网就先用本地这份 */ }
      meBusy = false;
    }
    box.textContent = '';
    const crumb = el('div', 'crumb');
    const home = el('button', 'crumb-link', t('全部商品'));
    home.addEventListener('click', () => { location.hash = ''; });
    crumb.appendChild(home);
    crumb.appendChild(el('span', 'crumb-sep', '›'));
    crumb.appendChild(el('span', 'crumb-cur', t('我的推广')));
    box.appendChild(crumb);

    if (!me) {
      const card = el('div', 'dcard');
      card.appendChild(el('h3', null, flags.member_open ? t('登录 / 注册') : t('会员登录')));
      card.appendChild(el('div', 'me-note', t('登录后即可查看')));
      card.appendChild(btn('btn btn-primary', t('登录'), () => openAuth('login')));
      if (flags.member_open) {
        card.appendChild(document.createTextNode(' '));
        card.appendChild(btn('btn btn-ghost', t('注册'), () => openAuth('signup')));
      }
      box.appendChild(card);
      return;
    }
    box.appendChild(kvCard(t('我的账号'), [
      [t('用户名'), String(me.username || '')],
      [t('我的邀请码'), String(me.invite_code || '')],
      [t('注册时间'), fmt(me.created_at)],
      [t('奖励金'), '¥' + money(me.balance_fen)],
    ]));

    box.appendChild(walletCard());

    const card = el('div', 'dcard');
    card.appendChild(el('h3', null, t('我的推广')));
    const link = el('div', 'me-link');
    link.appendChild(el('code', null, linkOf(me.invite_code)));
    link.appendChild(btn('btn btn-ghost btn-sm', t('复制推广链接'), () => copy(linkOf(me.invite_code))));
    card.appendChild(link);
    card.appendChild(el('div', 'me-note', t('把链接发给朋友，他注册后你就能拿到奖励金')));
    const stat = el('div', 'me-pills');
    stat.appendChild(el('span', 'pill ok', t('已邀请') + ' ' + (Number(me.ref_count) || 0)));
    stat.appendChild(el('span', 'pill', '¥' + money(me.balance_fen) + ' ' + t('奖励金')));
    card.appendChild(stat);

    const invited = Array.isArray(me.invited) ? me.invited : [];
    card.appendChild(el('div', 'me-sub', t('通过你注册的人')));
    if (!invited.length) card.appendChild(el('div', 'me-note', t('你还没有邀请到人')));
    for (const p of invited) {
      const row = el('div', 'me-line');
      row.appendChild(el('span', null, String(p.name || '')));
      row.appendChild(el('small', null, fmt(p.at)));
      card.appendChild(row);
    }
    const rewards = Array.isArray(me.rewards) ? me.rewards : [];
    card.appendChild(el('div', 'me-sub', t('奖励记录')));
    if (!rewards.length) card.appendChild(el('div', 'me-note', t('暂无奖励记录')));
    for (const r of rewards) {
      const row = el('div', 'me-line');
      row.appendChild(el('span', null, String(r.note || r.kind || '')));
      row.appendChild(el('small', null, (Number(r.amount) >= 0 ? '+' : '') + money(r.amount) + ' · ' + fmt(r.at)));
      card.appendChild(row);
    }
    box.appendChild(card);

    const ops = el('div', 'dcard');
    ops.appendChild(btn('btn btn-ghost', t('修改密码'), changePass));
    ops.appendChild(document.createTextNode(' '));
    ops.appendChild(btn('btn btn-danger', t('退出登录'), doLogout));
    box.appendChild(ops);
  }

  function route(hash) {
    const box = $('meView');
    const wrap = $('shopWrap');
    const view = $('detailView');
    if (String(hash || '') === '#/me') {
      if (wrap) wrap.style.display = 'none';
      if (view) { view.style.display = 'none'; view.textContent = ''; }
      if (box) { box.style.display = ''; renderMe(); }
      return true;
    }
    if (box) { box.style.display = 'none'; box.textContent = ''; }
    return false;
  }

  /* ---------- 启动 ---------- */
  async function restore() {
    try {
      const f = await rpc('rpc_member_flags', {});
      if (f && f.ok !== false) flags = Object.assign(flags, f);
    } catch (e) { /* 拿不到就按默认：开放注册、无奖励 */ }
    await loadWalFlags();
    const tk = token();
    if (tk) {
      try {
        const data = await rpc('rpc_me', { p_token: tk });
        if (data && data.ok === true) me = data;
        else setToken('');
        await loadWallet(true);
      } catch (e) { setToken(''); }
    }
    paintBtns();
    paintTab();
    if (String(location.hash || '') === '#/me') renderMe();
  }

  function bind() {
    document.addEventListener('click', (e) => {
      const t2 = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t2) return;
      const act = t2.getAttribute('data-act');
      if (act === 'open-account') { if (me) location.hash = '#/me'; else openAuth('login'); }
      if (act === 'auth-submit') submitAuth();
      if (act === 'auth-swap') openAuth(tab === 'signup' ? 'login' : 'signup');
      if (act === 'open-recharge') openRecharge();
      if (act === 'recharge-start') rechargeGo();
    });
    document.querySelectorAll('[data-authtab]').forEach((b) => {
      b.addEventListener('click', () => { tab = b.getAttribute('data-authtab') === 'signup' ? 'signup' : 'login'; openAuth(); });
    });
    const cus = $('rcCustom');
    if (cus) cus.addEventListener('input', () => { rcPick = 0; paintRcAmounts(); });
    const pk = $('authPass2');
    if (pk) pk.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    if (window.FakaI18n) document.addEventListener('faka-lang', () => { paintBtns(); paintTab(); renderMe(); paintRcAmounts(); });
  }

  window.FakaMember = {
    route, restore, openAuth, me: () => me, openRecharge, balanceFen,
    rechargeGo, walletFlags: () => wal, walletInfo: () => wallet, refreshWallet: () => loadWallet(true),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { bind(); restore(); });
  else { bind(); restore(); }
})();
