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
// 发卡商城 · 接口配置
// 这里只放「可公开」的 publishable key。
// ⚠️ 绝不要把 service_role / secret key 写进本文件——它会随 Pages 公开，
//    拿到它等于绕过 RLS 拥有全库读写。
window.FAKA_CONFIG = {
  SUPA_URL: 'https://tbrndvwxwvtvyjpsqnuj.supabase.co',
  SUPA_KEY: 'sb_publishable_KKpYWmXKbGED-gL85Q4Rpw_RMzcXipK',
};
