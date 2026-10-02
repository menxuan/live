// ============ 公共前端逻辑（jQuery）：会话 / RSA 加密请求 / 心跳 / 游客指纹 ============
$(function () {
  // ---------- 设备指纹（游客统计 + 游客喜好关键词用） ----------
  function fp() {
    var key = 'zbj_fp';
    var v = localStorage.getItem(key);
    if (!v) {
      var c = document.createElement('canvas'); c.width = 200; c.height = 40;
      var x = c.getContext('2d'); x.textBaseline = 'top'; x.font = '16px Arial'; x.fillText('zbj#' + Math.random(), 2, 2);
      v = 'fp_' + Math.random().toString(36).slice(2, 10) + (c.toDataURL().length % 997);
      localStorage.setItem(key, v);
      document.cookie = 'zbj_guest=' + v + ';path=/;max-age=31536000';
    }
    return v;
  }
  window.ZBJ_FP = fp();

  // ---------- 当前用户 ----------
  window.ME = null;
  window.refreshMe = function () {
    return $.get('/api/me').then(function (d) {
      if (d.ok) { window.ME = d; $('.js-username').text(d.username); $('.js-balance').text('¥ ' + d.balance); }
      return d;
    }).catch(function () { window.ME = null; });
  };

  // ---------- RSA 加密密码 ----------
  window.rsaPassword = async function (plain) {
    var d = await $.get('/api/pubkey');
    var key = await crypto.subtle.importKey('jwk', d.key, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    var ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(plain));
    return btoa(String.fromCharCode.apply(null, new Uint8Array(ct)));
  };

  // ---------- 心跳（在线状态 + 几点在线统计） ----------
  setInterval(function () { $.post('/api/heartbeat').catch(function () {}); }, 30000);
  $.post('/api/heartbeat').catch(function () {});

  // ---------- 设备信息随请求走（注册时用） ----------
  window.deviceInfo = function () {
    var ua = navigator.userAgent;
    var os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : 'Linux';
    return { os: os, ua: ua.slice(0, 200), fp: window.ZBJ_FP };
  };

  // ---------- 提示 ----------
  window.toast = function (msg, type) {
    var $t = $('<div class="toast ' + (type || '') + '">' + msg + '</div>').appendTo('body');
    setTimeout(function () { $t.addClass('show'); }, 10);
    setTimeout(function () { $t.removeClass('show'); setTimeout(function () { $t.remove(); }, 300); }, 2600);
  };

  refreshMe();
});
