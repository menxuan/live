// ============ 授权自检：所有页面必须最先引入；校验失败直接清空页面 ============
// 部署时把 LICENSE_USERID / LICENSE_KEY 换成管理员在后台发放的授权信息。
(function () {
  var LICENSE_USERID = 'owner';      // ← 管理员发放的授权用户ID
  var LICENSE_KEY = 'local';          // ← 管理员发放的密钥（与后台授权记录一致）
  var CONTACT = 'WX：byz0325L,QQ:2857936445';

  function b64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }

  async function hmacSign(key, text) {
    var k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  }

  function lockout(extra) {
    document.documentElement.innerHTML =
      '<head><meta charset="utf-8"><title>未授权</title></head><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0f1e;color:#fff;font-family:sans-serif;">' +
      '<div style="text-align:center;"><h1 style="color:#f43f5e;">你的系统未授权，请联系管理员授权</h1>' +
      '<p>' + (extra || '') + '</p><p>联系方式：' + CONTACT + '</p></div></body>';
  }

  window.addEventListener('DOMContentLoaded', async function () {
    try {
      var ts = Date.now();
      var domain = location.hostname;
      var sign = await hmacSign(LICENSE_KEY, LICENSE_USERID + ':' + ts + ':' + domain);
      var r = await fetch('/api/license/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: LICENSE_USERID, key: LICENSE_KEY, domain: domain, ts: ts, sign: sign }),
      });
      var d = await r.json();
      if (!d.ok) {
        lockout(d.expireAt ? ('到期时间：' + new Date(d.expireAt).toLocaleString('zh-CN')) : '');
        return;
      }
      window.LICENSE_OK = true;
      document.dispatchEvent(new Event('license:ok'));
    } catch (e) { lockout(''); }
  });
})();
