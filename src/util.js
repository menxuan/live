// ============ 工具与加密（Web Crypto，无外部依赖） ============

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function ok(data = {}) { return json({ ok: true, ...data }); }
export function fail(msg, status = 400, extra = {}) { return json({ ok: false, msg, ...extra }, status); }

export const now = () => Date.now();
export const b64encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function uid(prefix = 'u') {
  return prefix + '_' + now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- 哈希 / HMAC ----------
export async function sha256(text) {
  return b64encode(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64encode(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

export async function hmacVerify(secret, text, sig) {
  const expect = await hmac(secret, text);
  return expect === sig;
}

// ---------- AES-GCM（敏感字段落库加密：身份证/手机号等） ----------
async function aesKey(secret) {
  const raw = await sha256(secret + ':aes');
  return crypto.subtle.importKey('raw', b64decode(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function aesEncrypt(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(text));
  return b64encode(iv) + '.' + b64encode(ct);
}

export async function aesDecrypt(secret, payload) {
  try {
    const [iv, ct] = payload.split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(iv) }, await aesKey(secret), b64decode(ct));
    return dec.decode(pt);
  } catch { return null; }
}

// ---------- RSA-OAEP（密码传输非对称加密；私钥只存服务端 KV） ----------
export async function rsaGenerate() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']
  );
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { pub, priv };
}

export async function rsaDecrypt(privJwk, b64) {
  const priv = await crypto.subtle.importKey('jwk', JSON.parse(privJwk), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, b64decode(b64));
  return dec.decode(pt);
}

// ---------- cookie ----------
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(name, value, maxAge, secure = true) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}; HttpOnly`;
}

// ---------- 输入校验 ----------
export function need(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') return f;
  }
  return null;
}

export const isPhone = (s) => /^1[3-9]\d{9}$/.test(s);
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const clampStr = (s, n) => String(s || '').trim().slice(0, n);

// ---------- 时间友好显示：几分钟/小时/天/年前 ----------
export function agoText(ts) {
  if (!ts) return '从未上线';
  const diff = now() - ts;
  if (diff < 60000) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  if (d < 365) return d + ' 天前';
  return Math.floor(d / 365) + ' 年前';
}

// ---------- 设备解析（服务端复核，前端也会传） ----------
export function parseUA(ua) {
  ua = ua || '';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '其他';
  const browser = /MicroMessenger/.test(ua) ? '微信内置' : /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '其他';
  const type = (os === 'iOS' || os === 'Android') ? '手机' : '电脑';
  return { os, browser, type };
}
