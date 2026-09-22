// 发卡商城 · 中英双语（前台）
// 思路：中文是「原文」，切到 English 时按词典把页面上的文字换掉。
// 商品名、对方货源文案属于数据，不做机器翻译，保持原样。
(function () {
  'use strict';

  const EN = {
    // ---- 顶部 / 侧栏 / 工具条 ----
    "发卡商城": "Card Shop",
    "欢迎光临本店！": "Welcome to our store!",
    "订单查询": "Order lookup",
    "管理后台": "Admin",
    "2FA 验证码": "2FA codes",
    "查询订单": "Look up order",
    "登录 / 注册": "Sign in / Sign up",
    "商品分类": "Categories",
    "商品列表": "Products",
    "全部商品": "All products",
    "全部分类": "All categories",
    "未分类": "Uncategorized",
    "加载更多": "Load more",
    "正在加载...": "Loading…",
    "正在加载商品...": "Loading products…",
    "列表视图": "List view",
    "卡片视图": "Gallery view",
    "最新上架": "Newest first",
    "销量优先": "Best selling",
    "价格从低到高": "Price: low to high",
    "价格从高到低": "Price: high to low",
    "搜索你想要的商品，例如 Gmail、苹果、会员": "Search products, e.g. Gmail, Apple, VIP",
    "暂无在售商品": "No products on sale yet",
    "没有匹配的商品，换个关键词试试": "No matching products — try another keyword",
    "点击查看全部": "View all",
    "查看商品介绍": "View details",
    "查看商品详情": "View details",
    "商品名称": "Product",
    "价格": "Price",
    "库存": "Stock",
    "已售": "Sold",
    "购买": "Buy",
    "缺货": "Out of stock",
    "数量": "Quantity",
    "金额": "Amount",
    "状态": "Status",
    "商品": "Product",
    "直发": "Direct",
    "下架": "Off sale",
    "不限量": "Unlimited",
    "自动发货": "Auto delivery",
    "本店库存": "Our stock",
    "本店卡密": "Our own keys",
    "货源直发": "Direct from supplier",
    "付款后自动发货": "delivered automatically after payment",
    "付款后立即发放": "sent right after payment",
    "库存充足": "In stock",
    "暂时缺货": "Out of stock",
    "⚠️ 暂时缺货": "⚠️ Out of stock",
    "⚠️ 已售罄": "⚠️ Sold out",
    "⚠️ 货源已下架": "⚠️ Supplier off sale",

    // ---- 商品详情页 ----
    "该商品不存在，或已下架": "This product does not exist or is off sale.",
    "返回商品列表": "Back to products",
    "商品价格": "Price",
    "库存状态": "Availability",
    "购买数量": "Quantity",
    "订单金额": "Order total",
    "立即购买": "Buy now",
    "商品介绍": "Product description",
    "商品说明": "Description",
    "发货说明": "Shipping",
    "商品详情": "More details",
    "商品描述": "Description",
    "产品介绍": "Product description",
    "发货方式": "Delivery",
    "购买须知": "Before you buy",
    "所有商品只用来社交和沟通贸易，不做其他违法活动。": "All items are for social networking and trade communication only. Any unlawful use is prohibited.",
    "下单后在「订单查询」里查看卡密（订单号 + 下单邮箱）。": "After paying, find your keys under Order lookup using your order ID plus the email you entered.",
    "客服 TG：": "Support on TG: ",
    "登录两小时内不要改密码；长久使用请一定要改密码、邮箱和手机！": "Do not change the password within the first two hours of logging in. For long-term use you must change the password, email and phone.",
    "※ 非账号密码错误一概不退号，购买前请少量测试，一账号一 IP 登录！": "No refunds for anything other than wrong credentials. Test with a small quantity first, and use one IP per account.",
    "※ 质保 24 小时内的首次登录，没技术不要囤号，囤号被风控不售后。": "Warranty covers the first login within 24 hours only. Do not stockpile accounts unless you know what you are doing - risk-control bans on stockpiled accounts are not covered.",
    "防被骗：全部交易只走网站平台，勿私下交易。": "Avoid fraud: all transactions go through this website only. Never deal privately.",
    "虚拟商品一经发出概不退换；单次可买 1~10 件。": "Virtual goods are non-refundable once delivered. 1-10 pieces per order.",
    "没看到卡密？稍后用订单号 + 下单邮箱在「订单查询」里随时查看。客服 TG：": "Keys not showing yet? Look them up later under Order lookup with your order ID and email. Support on TG: ",
    "所有商品只用来社交和沟通贸易，不做其他违法活动。全部交易只走本站平台，勿私下交易。": "All items are for social networking and trade communication only - no unlawful use. All transactions go through this site only, never privately.",
    "下单须知": "Ordering notes",
    "账号格式": "Account format",
    "卡密格式": "Card format",
    "账号说明": "Account notes",
    "使用建议": "Tips",
    "使用说明": "How to use",
    "使用须知": "Usage notes",
    "注意事项": "Please note",
    "售后说明": "After sales",
    "售后服务": "After sales",
    "温馨提示": "Reminder",
    "重要提示": "Important",
    "常见问题": "FAQ",
    "服务保障": "Guarantee",
    "基本信息": "Basic info",
    "价格说明": "Pricing",
    "购买说明": "Buying guide",
    "交付方式": "Delivery method",
    "交付说明": "Delivery",
    "中文语言设置": "Language setting",
    "微软邮箱需要手机接码": "Outlook accounts need SMS receiving",
    "卖家暂未填写说明": "The seller has not written a description yet.",
    "暂无介绍": "No description yet",
    "货源直发：付款后系统自动向货源方下单，卡密回传后发到你的邮箱":
      "Direct from supplier: after payment the system orders automatically and the card keys are emailed to you.",
    "本店卡密：付款后立即发放": "Our own stock: keys are sent right after payment.",
    "虚拟商品一经发出概不退换；单次可买 1~10 件，卡密会发到下单邮箱，也可在「订单查询」用订单号 + 邮箱随时查看。":
      "Digital goods cannot be returned once delivered. 1-10 items per order. Keys go to your email, and you can look the order up anytime with the order ID + email under Order lookup.",
    "本站商品均为虚拟商品，一经售出概不退换":
      "All items are digital goods and cannot be returned once delivered.",

    // ---- 下单 / 支付 / 卡密 ----
    "确认购买": "Confirm purchase",
    "合计": "Total",
    "立即下单": "Place order",
    "下单中...": "Placing order…",
    "接收邮箱（用于查询订单，请填写你本人的邮箱）": "Delivery email (used to look up this order - please use your own)",
    "例如：you@example.com": "e.g. you@example.com",
    "（货源直发，单次 1~10 件）": "(direct from supplier, 1-10 per order)",
    "订单支付": "Payment",
    "订单编号": "Order ID",
    "等待支付结果…": "Waiting for payment…",
    "我已完成支付，刷新状态": "I have paid - refresh status",
    "订单处理中…": "Processing your order…",
    "查询过于频繁，请稍后手动点「我已支付」刷新": "Checking too often - tap I have paid to refresh later",
    "购买成功": "Payment received",
    "卡密已自动发货，请及时复制保存": "Your keys are ready - copy and save them now",
    "一键复制全部卡密": "Copy all keys",
    "复制": "Copy",
    "已复制": "Copied",
    "✓ 已复制": "✓ Copied",
    "复制失败，请手动选择": "Copy failed - please select the text manually",
    "该商品本店暂无现货卡密，订单已登记为待补发，通常几分钟内自动到货；请稍后用订单号查询。":
      "This item is out of stock right now. Your order is queued and usually fills itself within a few minutes - please check again with your order ID.",
    "已收款，卡密待补发": "Paid - keys pending",
    "已收款，货源方正在出货": "Paid - your supplier is delivering now",
    "系统已自动向货源方下单，一般 1~5 分钟内出卡密。这个窗口会自动刷新，也可稍后用订单号查询。":
      "We have already placed this order with our supplier automatically. Keys usually arrive within 1-5 minutes. This window refreshes itself, or look it up later with your order ID.",
    "刷新卡密（货源方出货中）": "Refresh keys (delivery in progress)",
    "卡密已到，请复制保存": "Your keys have arrived - copy and save them",
    "货源方还在出货，再等一分钟": "Still being delivered - please wait another minute",
    "订单还在处理中，稍等半分钟再点": "Order still processing - please wait a moment before tapping again",
    "卡密发放中，请稍后再查。": "Keys are being delivered - please check again shortly.",
    "支付完成后这里会显示卡密。": "Your keys will appear here after payment.",
    "⏳ 待支付": "⏳ Unpaid",
    "✅ 已支付": "✅ Paid",
    "❌ 已关闭": "❌ Closed",
    "下单时生成的订单编号": "The order ID you got when ordering",
    "下单时填写的邮箱": "The email you used to order",
    "请填写订单编号和下单邮箱": "Please fill in the order ID and email",
    "查询中...": "Searching…",
    "查询次数过多，请一小时后再试": "Too many lookups - please try again in an hour",
    "未找到匹配的订单（订单编号与邮箱需完全一致）": "No matching order (order ID and email must match exactly)",
    "订单号：": "Order ID: ",
    "下单邮箱": "Order email",
    "（剩余库存 - 张）": "(stock: - left)",

    // ---- 报错文案 ----
    "购买数量不合法（1~10 张）": "Quantity must be between 1 and 10",
    "请填写正确的邮箱": "Please enter a valid email address",
    "你在途的待支付订单过多，请先完成支付或稍后再试": "You have too many unpaid orders - pay or wait, then try again",
    "库存不足，暂时无法下单": "Not enough stock to place this order",
    "该商品已下架": "This product is no longer on sale",
    "未找到订单": "Order not found",
    "网络异常，请重试": "Network problem - please retry",
    "操作失败，请稍后重试": "Something went wrong - please retry",
    "请先编辑站点根目录下的 config.js，填写 Supabase 接口地址":
      "Please edit config.js in the site root and fill in your Supabase URL / key",

    // ---- 会员 / 推广 ----
    "会员登录": "Member sign in",
    "会员注册": "Create account",
    "登录": "Sign in",
    "注册": "Sign up",
    "退出登录": "Sign out",
    "用户名": "Username",
    "密码": "Password",
    "确认密码": "Confirm password",
    "新密码": "New password",
    "原密码": "Current password",
    "邀请码": "Invite code",
    "邀请码（选填）": "Invite code (optional)",
    "我的推广": "My referrals",
    "我的账号": "My account",
    "已邀请": "Invited",
    "奖励金": "Reward balance",
    "我的邀请链接": "My referral link",
    "我的邀请码": "My invite code",
    "复制推广链接": "Copy referral link",
    "注册成功": "Welcome aboard",
    "登录成功": "Signed in",
    "已退出登录": "Signed out",
    "请先登录或注册": "Please sign in or create an account first",
    "4-20 位字母、数字或下划线": "4-20 letters, digits or underscore",
    "至少 6 位": "at least 6 characters",
    "两次输入的密码不一样": "The two passwords do not match",
    "用户名或密码不正确": "Username or password is wrong",
    "该用户名已被注册": "This username is taken",
    "注册已关闭": "Registration is currently closed",
    "账号已被禁用": "This account has been disabled",
    "尝试次数过多，请 10 分钟后再试": "Too many attempts - try again in 10 minutes",
    "请填写用户名和密码": "Please fill in username and password",
    "用户名只能用字母、数字、下划线、点或减号（4-20 位）":
      "Username may only contain letters, digits, _ . - (4-20 chars)",
    "密码至少 6 位": "Password must be at least 6 characters",
    "原密码不对": "Current password is wrong",
    "密码已修改": "Password updated",
    "朋友给你的 8 位邀请码": "The 8-character code a friend gave you",
    "还没有账号？注册一个": "No account yet? Create one",
    "已有账号？去登录": "Already registered? Sign in",
    "把链接发给朋友，他注册后你就能拿到奖励金":
      "Send this link to a friend - once they register, the reward lands in your balance",
    "你还没有邀请到人": "You have not invited anyone yet",
    "暂无奖励记录": "No rewards yet",
    "通过你注册的人": "People who signed up through you",
    "奖励记录": "Reward history",
    "返回首页": "Back to store",
    "登录后即可查看": "Sign in to see it",
    "注册送": "Sign-up gift",
    "邀请奖励": "Invite reward",
    "修改密码": "Change password",
    "注册时间": "Joined",
    "最近登录": "Last sign-in",
    "提交": "Submit",
    "取消": "Cancel",
    "提交中...": "Submitting…",
    "今天注册的人太多了，请明天再试": "Today’s sign-ups are full — please try tomorrow",
    "登录状态已失效，请重新登录": "Your session expired — please sign in again",
    "请先在站点根目录的 config.js 里填好 Supabase 地址": "Please fill in your Supabase URL / key in config.js first",
    // ---- 第 18 步：钱包 / 充值 ----
    "我的钱包": "My wallet",
    "账户余额": "Balance",
    "当前余额": "Current balance",
    "可用余额": "available",
    "充值余额": "Recharge balance",
    "充值单号": "Recharge order no.",
    "选择金额": "Choose an amount",
    "其他金额（元）": "Other amount (CNY)",
    "也可以自己填": "Or type your own",
    "生成充值单": "Create recharge order",
    "我已完成支付": "I have paid",
    "关闭": "Close",
    "还在等待到账": "Still waiting for credit",
    "已到账": "Credited",
    "充值已到账": "Recharge credited",
    "收支明细": "Transactions",
    "暂无记录": "No records yet",
    "累计充值": "Total recharged",
    "累计消费": "Total spent",
    "充值到账": "Recharge",
    "余额消费": "Purchase",
    "退款": "Refund",
    "人工调整": "Manual adjustment",
    "用余额支付，秒发货": "Pay with balance — instant delivery",
    "余额不够？去充值": "Not enough? Recharge first",
    "余额不足，请先充值": "Not enough balance — please recharge first",
    "余额不足，先去充值": "Not enough balance — recharge first",
    "请先选一个金额": "Please pick an amount first",
    "金额范围": "Amount range",
    "请先登录后再用余额支付": "Please sign in before paying with balance",
    "打开支付宝付款": "Open Alipay to pay",
    "用另一台设备扫码": "Scan with another device",
    "打开支付宝 App → 扫一扫，对准上面的二维码付款": "Open the Alipay app → Scan, and point it at the code above",
    "这个码只对应本单，30 分钟内有效；关掉重开会换一张新码": "This code is for this order only and expires in 30 minutes; reopening generates a new one",
    "手机上打不开？点这里直接在支付宝里打开": "Can't scan on this device? Tap here to open it in Alipay",
    "二维码组件没加载，请用上面的链接付款": "The QR component didn't load — please use the link above to pay",
    "支付宝收款二维码": "Alipay payment QR code",
    "付款成功后这个页面会自动到账，不用手动刷新": "You will be credited automatically after payment — no need to refresh",
    "站长在后台点「确认入账」后，余额会立刻到账": "Your balance updates as soon as the store owner confirms the payment",
    "请把 ¥": "Please transfer ¥",
    "，并把上面的充值单号发给站长": " and send the recharge order no. above to the store owner",
    "余额功能还没开通：请到 Supabase 执行 11-wallet.sql": "Wallet is not set up yet — please run 11-wallet.sql in Supabase",
    "充值金额不合法": "Invalid recharge amount",
    "没找到这笔充值单": "Recharge order not found",
    "站长暂时关闭了余额支付": "Balance payment is temporarily disabled by the store owner",
    "订单已关闭，请重新下单": "This order is closed — please place a new one",
    "订单已超时关闭，请重新下单": "This order timed out — please place a new one",
    "这个订单和下单邮箱对不上": "This order does not match the checkout email",
    "在途待支付的单子太多了，请先完成支付或稍后再试": "You have too many unpaid orders — please pay one first or try again later",
    "支付中...": "Processing…",
    "请转账 ¥{amt}，并把上面的充值单号发给站长": "Please transfer ¥{amt} and send the recharge order no. above to us",
  "支付宝下单失败：{err}": "Alipay order failed: {err}",
  "请稍后重试，或联系站长处理": "Please try again in a moment, or contact us for help.",
    "中文": "中文",
  };

  // 带数字 / 变量的句子：用规则翻，规则只认「整行」，避免误伤商品名
  const RX = [
    [/^(\d+) 个商品$/, (m) => m[1] + (Number(m[1]) === 1 ? " item" : " items")],
    [/^共 (\d+) 个商品$/, (m) => "Total " + m[1] + " products"],
    [/^共 (\d+) 个$/, (m) => m[1] + " items"],
    [/^已显示 (\d+) 个$/, (m) => "showing " + m[1]],
    [/^筛出 (\d+) \/ 共 (\d+) 个$/, (m) => "filtered " + m[1] + " of " + m[2]],
    [/^搜索「([\s\S]*)」$/, (m) => "Search " + m[1]],
    [/^已售 (\d+)$/, (m) => "Sold " + m[1]],
    [/^库存 (\d+) 张$/, (m) => "Stock: " + m[1]],
    [/^库存 (\d+) 件$/, (m) => "Stock: " + m[1]],
    [/^仅剩 (\d+) 件$/, (m) => "Only " + m[1] + " left"],
    [/^(\d+)\s*[张件]$/, (m) => m[1] + " pcs"],
    [/^单价 ¥([\d.,]+) \/ 张$/, (m) => "Unit price ¥" + m[1] + " each"],
    [/^（剩余库存 (\d+) 张）$/, (m) => "(" + m[1] + " left in stock)"],
    [/^（货源仅剩 (\d+) 件，单次最多 (\d+) 件）$/, (m) => "(only " + m[1] + " left, max " + m[2] + " per order)"],
    [/^等待支付结果…（([\s\S]*) 前有效）$/, (m) => "Waiting for payment… (valid until " + m[1] + ")"],
    [/^已邀请 (\d+) 人$/, (m) => "Invited " + m[1]],
    [/^共 (\d+) 人$/, (m) => m[1] + " people"],
    [/^¥([\d.,]+) 奖励金$/, (m) => "¥" + m[1] + " reward balance"],
    [/^请转账 ¥([\d.,]+) ?，并把上面的充值单号发给站长$/, (m) => "Please transfer ¥" + m[1] + " and send the recharge order no. above to us"],
    [/^用余额支付 ¥([\d.,]+)$/, (m) => "Pay with balance: ¥" + m[1]],
    [/^确认用余额支付 ¥([\d.,]+) ？$/, (m) => "Pay ¥" + m[1] + " from your balance?"],
    [/^我的钱包 · ([\s\S]*)$/, (m) => "My wallet · " + m[1]],
    [/^¥([\d.,]+) 可用余额$/, (m) => "¥" + m[1] + " available"],
    [/^已到账 ¥([\d.,]+)$/, (m) => "Credited ¥" + m[1]],
    [/^金额范围 ¥([\d.,]+) ~ ¥([\d.,]+)$/, (m) => "Amount range: ¥" + m[1] + " – ¥" + m[2]],
    [/^¥([\d.,]+) 累计充值$/, (m) => "¥" + m[1] + " recharged"],
    [/^¥([\d.,]+) 累计消费$/, (m) => "¥" + m[1] + " spent"],
    [/^登录 · (.*)$/, (m) => "Signed in as " + m[1]],
  ];

  const EN2ZH = {};
  for (const k in EN) if (!(EN[k] in EN2ZH)) EN2ZH[EN[k]] = k;

  let lang = "zh";
  try {
    const saved = localStorage.getItem("FAKA_LANG");
    if (saved === "en" || saved === "zh") lang = saved;
    else if (!saved && typeof navigator !== "undefined"
      && /^en\b/i.test(String(navigator.language || ""))) lang = "en";
  } catch (e) { /* 拿不到就用中文 */ }

  const SEP = /(\s[｜·]\s)/;

  function one(s) {
    if (!s) return s;
    if (lang === "en") {
      if (EN[s] !== undefined) return EN[s];
      for (const r of RX) { const m = r[0].exec(s); if (m) return r[1](m); }
      return s;
    }
    return EN2ZH[s] !== undefined ? EN2ZH[s] : s;
  }
  // 组合句（「货源直发 · 付款后自动发货」）拆段翻，翻不动的段保持原样
  function tr(s) {
    const t = String(s == null ? "" : s);
    if (!t.trim()) return t;
    const hit = one(t);
    if (hit !== t) return hit;
    if (!SEP.test(t)) return t;
    return t.split(SEP).map((p) => (SEP.test(p) ? p : one(p))).join("");
  }

  function walk(root) {
    if (!root) return;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      for (let c = cur.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const src = c.data;
          const out = tr(src);
          if (out !== src) { try { c.data = out; } catch (e) { /* 只读节点忽略 */ } }
        } else if (c.nodeType === 1) {
          const tag = String(c.tagName || "").toUpperCase();
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") continue;
          if (c.getAttribute) {
            for (const at of ["placeholder", "title", "aria-label"]) {
              const v = c.getAttribute(at);
              if (v) { const nv = tr(v); if (nv !== v) c.setAttribute(at, nv); }
            }
          }
          stack.push(c);
        }
      }
    }
  }

  let timer = null;
  function schedule(root) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; walk(root || document.body); }, 0);
  }

  let watching = false;
  function observe() {
    if (watching || typeof MutationObserver !== "function" || !document.body) return;
    watching = true;
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "childList" && m.addedNodes && m.addedNodes.length) { schedule(m.target); continue; }
        if (m.type === "characterData") {
          const n = m.target;
          const out = tr(n.data);
          if (out !== n.data) { try { n.data = out; } catch (e) { /* 忽略 */ } }
          continue;
        }
        if (m.type === "attributes") {
          const v = m.target.getAttribute && m.target.getAttribute(m.attributeName);
          if (v) { const nv = tr(v); if (nv !== v) m.target.setAttribute(m.attributeName, nv); }
        }
      }
    }).observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["placeholder", "title", "aria-label"],
    });
  }

  function paintBtn() {
    if (typeof document === "undefined" || !document.querySelectorAll) return;
    document.querySelectorAll("[data-act='toggle-lang']").forEach((b) => {
      b.textContent = lang === "en" ? "中文" : "EN";
      b.setAttribute("title", lang === "en" ? "切换英文 / Switch language" : "Switch language");
    });
    if (document.documentElement) document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  }

  const api = {
    lang: () => lang,
    tr: (s) => tr(s),
    t: (s, vars) => {
      let out = lang === "en" && EN[s] !== undefined ? EN[s] : String(s);
      if (vars) out = out.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
      return out;
    },
    fixTitle: () => {
      if (typeof document === "undefined") return;
      const now = String(document.title || "");
      const want = lang === "en"
        ? now.replace(/\s*-\s*自动发卡，秒到账$/, " - instant card delivery")
        : now.replace(/\s*-\s*instant card delivery$/, " - 自动发卡，秒到账");
      if (want && want !== now) document.title = want;
    },
    apply: (root) => { walk(root || document.body); api.fixTitle(); },
    set: (v) => {
      lang = v === "en" ? "en" : "zh";
      try { localStorage.setItem("FAKA_LANG", lang); } catch (e) { /* 无痕模式忽略 */ }
      if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
        try { document.dispatchEvent(new Event("faka-lang")); } catch (e) { /* 老浏览器忽略 */ }
      }
      paintBtn();
      api.apply();
    },
    toggle: () => api.set(lang === "en" ? "zh" : "en"),
    boot: () => { paintBtn(); observe(); api.apply(); },
  };
  window.FakaI18n = api;

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("[data-act='toggle-lang']") : null;
      if (b) api.toggle();
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => api.boot());
    else api.boot();
  }
})();
