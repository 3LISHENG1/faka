// 发卡商城 · 会员注册 / 登录 + 我的推广
// 只调 4 个白名单 RPC：rpc_member_flags / rpc_signup / rpc_login / rpc_me（+ 退出、改密码）。
// 卡密、订单、价格这些一律不经过这里；密码哈希在数据库里，浏览器拿不到。
'use strict';
(function () {
  const CFG = (typeof window !== 'undefined' && window.FAKA_CONFIG) || {};
  const NL = String.fromCharCode(10);
  const TOK = 'FAKA_MEMBER_TOKEN';
  const REF = 'FAKA_LAST_REF';
  const t = (s, v) => (window.FakaI18n ? window.FakaI18n.t(s, v) : String(s));

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

  /* ---------- 顶栏按钮 ---------- */
  function paintBtns() {
    document.querySelectorAll('[data-act="open-account"]').forEach((b) => {
      b.textContent = me ? (t('我的推广') + ' · ' + me.username) : (flags.member_open ? t('登录 / 注册') : t('登录'));
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
    const tk = token();
    if (tk) {
      try {
        const data = await rpc('rpc_me', { p_token: tk });
        if (data && data.ok === true) me = data;
        else setToken('');
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
    });
    document.querySelectorAll('[data-authtab]').forEach((b) => {
      b.addEventListener('click', () => { tab = b.getAttribute('data-authtab') === 'signup' ? 'signup' : 'login'; openAuth(); });
    });
    const pk = $('authPass2');
    if (pk) pk.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    if (window.FakaI18n) document.addEventListener('faka-lang', () => { paintBtns(); paintTab(); renderMe(); });
  }

  window.FakaMember = { route, restore, openAuth, me: () => me };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { bind(); restore(); });
  else { bind(); restore(); }
})();
