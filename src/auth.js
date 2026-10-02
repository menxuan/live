// ============ 认证：注册 / 登录 / 会话 / RSA 密钥管理 ============
import { json, ok, fail, now, uid, sha256, hmac, hmacVerify, aesEncrypt, aesDecrypt, rsaGenerate, rsaDecrypt, parseCookies, setCookie, need, isPhone, isEmail, clampStr, parseUA } from './util.js';

const SESSION_COOKIE = 'zbj_session';

// ---------- RSA 密钥对（首次启动生成，私钥只存服务端 KV） ----------
export async function getRsaKeys(env) {
  let stored = await env.DB.get('sys:rsa');
  if (!stored) {
    const pair = await rsaGenerate();
    stored = JSON.stringify(pair);
    await env.DB.put('sys:rsa', stored);
  }
  return JSON.parse(stored);
}

export async function handlePubkey(env) {
  const keys = await getRsaKeys(env);
  return json({ ok: true, key: keys.pub });
}

// ---------- 会话签发 / 校验 ----------
export async function issueSession(env, uidVal, keepOnline) {
  const exp = now() + (keepOnline ? 30 * 86400 : Number(env.SESSION_TTL || 7200)) * 1000;
  const payload = `${uidVal}.${exp}`;
  const sig = await hmac(env.SECRET, payload);
  return { value: `${payload}.${sig}`, exp };
}

export async function verifySession(env, req) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return { uid: null, guestId: cookies['zbj_guest'] || null };
  const parts = raw.split('.');
  if (parts.length !== 3) return { uid: null, guestId: cookies['zbj_guest'] || null };
  const [u, exp, sig] = parts;
  // 时间戳校验：过期即失效
  if (Number(exp) < now()) return { uid: null, guestId: cookies['zbj_guest'] || null };
  if (!(await hmacVerify(env.SECRET, `${u}.${exp}`, sig))) return { uid: null, guestId: cookies['zbj_guest'] || null };
  const user = await getUser(env, u);
  if (!user || user.banned) return { uid: null, guestId: cookies['zbj_guest'] || null };
  return { uid: u, user, guestId: cookies['zbj_guest'] || null };
}

// ---------- 用户存取 ----------
export async function getUser(env, id) {
  const raw = await env.DB.get(`user:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function putUser(env, user) {
  await env.DB.put(`user:${user.uid}`, JSON.stringify(user));
}

export async function findUserBy(env, field, value) {
  const id = await env.DB.get(`${field}:${value}`);
  return id ? getUser(env, id) : null;
}

// 注册统计增量（大屏用）
async function bumpStat(env, key, delta = 1, bucket = null) {
  const k = bucket ? `${key}:${bucket}` : key;
  const cur = Number(await env.DB.get(k) || 0) + delta;
  await env.DB.put(k, String(cur));
  return cur;
}

// 画像预聚合：性别 / 年龄 / 城市 / 设备
export async function profileStats(env, user, delta = 1) {
  const jobs = [];
  if (user.gender) jobs.push(bumpStat(env, 'stats:gender:' + user.gender, delta));
  if (user.birthday) {
    const age = Math.floor((now() - new Date(user.birthday).getTime()) / 31557600000);
    const seg = age < 18 ? 'u18' : age < 25 ? 'a18_24' : age < 35 ? 'a25_34' : age < 45 ? 'a35_44' : 'a45';
    jobs.push(bumpStat(env, 'stats:age:' + seg, delta));
  }
  if (user.city) jobs.push(bumpStat(env, 'stats:city:' + user.city, delta));
  if (user.device && user.device.os) jobs.push(bumpStat(env, 'stats:device:' + user.device.os, delta));
  jobs.push(bumpStat(env, 'stats:type:' + (user.role || 'user'), delta));
  await Promise.all(jobs);
}

// ---------- 注册 ----------
export async function handleRegister(env, req) {
  const body = await req.json().catch(() => null);
  if (!body) return fail('请求格式错误');
  const missing = need(body, ['phone', 'email', 'username', 'password', 'gender', 'birthday', 'city', 'agree']);
  if (missing) return fail('缺少字段：' + missing);
  if (body.agree !== true && body.agree !== 'true') return fail('请先阅读并同意用户协议');
  if (!isPhone(body.phone)) return fail('手机号格式不正确');
  if (!isEmail(body.email)) return fail('邮箱格式不正确');
  const username = clampStr(body.username, 20);
  if (username.length < 2) return fail('用户名至少 2 个字符');
  const password = String(body.password);
  if (password.length < 6) return fail('密码至少 6 位');

  // 密码是 RSA 加密传输的，先解密
  const keys = await getRsaKeys(env);
  let plain;
  try { plain = await rsaDecrypt(keys.priv, password); }
  catch { return fail('密码传输校验失败，请刷新页面重试'); }
  if (plain.length < 6) return fail('密码至少 6 位');

  if (await findUserBy(env, 'phone', body.phone)) return fail('该手机号已注册');
  if (await findUserBy(env, 'email', body.email)) return fail('该邮箱已注册');
  if (await findUserBy(env, 'username', username)) return fail('该用户名已被占用');

  const salt = uid('s');
  const id = uid('u');
  const ua = parseUA(req.headers.get('User-Agent'));
  const user = {
    uid: id,
    phoneEnc: await aesEncrypt(env.SECRET, body.phone),       // 敏感字段加密存储
    emailEnc: await aesEncrypt(env.SECRET, body.email),
    phoneTail: body.phone.slice(-4),                           // 后台脱敏展示
    username,
    passHash: await sha256(salt + ':' + plain),
    passEnc: await aesEncrypt(env.SECRET, plain),              // 后台可查（需求要求）
    salt,
    gender: ['男', '女', '保密'].includes(body.gender) ? body.gender : '保密',
    birthday: clampStr(body.birthday, 10),
    city: clampStr(body.city, 30),
    tags: Array.isArray(body.tags) ? body.tags.map(t => clampStr(t, 12)).slice(0, 8) : [],
    role: 'user',                    // user | streamer | cs | admin
    realname: null,                  // { name, idcardEnc, status: pending|approved|rejected }
    avatar: '',
    bio: '',
    balance: 0,
    giftValue: 0,                    // 累计被打赏价值 -> 头衔等级
    banned: false,
    chatBanned: false, dmBanned: false,
    dnd: false,                      // 免打扰
    device: { ...ua, fp: clampStr(body.fp, 64) },
    createdAt: now(),
    lastSeen: now(),
    keepOnline: false,
  };

  await putUser(env, user);
  await env.DB.put(`phone:${body.phone}`, id);
  await env.DB.put(`email:${body.email}`, id);
  await env.DB.put(`username:${username}`, id);
  await profileStats(env, user, 1);
  await bumpStat(env, 'stats:total');
  await bumpStat(env, 'stats:new:' + new Date().toISOString().slice(0, 10));

  // 设备指纹登记（游客转正）
  if (user.device.fp) await env.DB.put(`device:${user.device.fp}`, id);

  const sess = await issueSession(env, id, false);
  const resp = ok({ uid: id, username, role: 'user' });
  resp.headers.append('Set-Cookie', setCookie(SESSION_COOKIE, sess.value, Math.floor((sess.exp - now()) / 1000)));
  return resp;
}

// ---------- 登录 ----------
export async function handleLogin(env, req) {
  const body = await req.json().catch(() => null);
  if (!body) return fail('请求格式错误');
  const account = clampStr(body.account, 60);
  const keys = await getRsaKeys(env);
  let plain;
  try { plain = await rsaDecrypt(keys.priv, String(body.password)); }
  catch { return fail('密码传输校验失败，请刷新页面重试'); }

  let user = await findUserBy(env, 'username', account)
    || await findUserBy(env, 'phone', account)
    || await findUserBy(env, 'email', account);
  if (!user) return fail('账号或密码错误', 401);
  if (user.banned) return fail('该账号已被封禁', 403);
  if (user.passHash !== await sha256(user.salt + ':' + plain)) return fail('账号或密码错误', 401);

  user.lastSeen = now();
  user.keepOnline = !!body.keepOnline;
  await putUser(env, user);

  const sess = await issueSession(env, user.uid, user.keepOnline);
  const ua = parseUA(req.headers.get('User-Agent'));
  user.device = { ...user.device, ...ua };
  await putUser(env, user);

  const resp = ok({
    uid: user.uid, username: user.username, role: user.role,
    avatar: user.avatar, balance: user.balance,
  });
  resp.headers.append('Set-Cookie', setCookie(SESSION_COOKIE, sess.value, Math.floor((sess.exp - now()) / 1000)));
  return resp;
}

// ---------- 登出 ----------
export async function handleLogout() {
  const resp = ok();
  resp.headers.append('Set-Cookie', setCookie(SESSION_COOKIE, '', 0));
  return resp;
}

// ---------- 当前登录态 ----------
export async function handleMe(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  return ok({
    uid: user.uid, username: user.username, role: user.role, avatar: user.avatar,
    bio: user.bio, gender: user.gender, city: user.city, balance: user.balance,
    realnameStatus: user.realname ? user.realname.status : 'none',
    canLive: user.role === 'streamer' || user.role === 'admin',
    chatBanned: user.chatBanned, dmBanned: user.dmBanned, dnd: user.dnd,
    giftValue: user.giftValue, lastSeenText: null,
  });
}

// ---------- 修改资料（头像 / 用户名 / 简介） ----------
export async function handleProfile(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const body = await req.json().catch(() => null);
  if (!body) return fail('请求格式错误');
  if (body.username && body.username !== user.username) {
    const name = clampStr(body.username, 20);
    if (name.length < 2) return fail('用户名至少 2 个字符');
    if (await findUserBy(env, 'username', name)) return fail('该用户名已被占用');
    await env.DB.delete(`username:${user.username}`);
    await env.DB.put(`username:${name}`, user.uid);
    user.username = name;
  }
  if (body.bio !== undefined) user.bio = clampStr(body.bio, 200);
  if (body.avatar !== undefined) user.avatar = clampStr(body.avatar, 200000); // 小图 base64
  if (body.gender !== undefined && ['男', '女', '保密'].includes(body.gender)) {
    await profileStats(env, user, -1);
    user.gender = body.gender;
    await profileStats(env, user, 1);
  }
  if (body.city !== undefined) {
    await profileStats(env, user, -1);
    user.city = clampStr(body.city, 30);
    await profileStats(env, user, 1);
  }
  if (body.dnd !== undefined) user.dnd = !!body.dnd;
  await putUser(env, user);
  return ok({ username: user.username, bio: user.bio, avatar: user.avatar, dnd: user.dnd });
}

// ---------- 实名认证（申请直播权限） ----------
export async function handleRealname(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const body = await req.json().catch(() => null);
  if (!body) return fail('请求格式错误');
  const name = clampStr(body.name, 20);
  const idcard = clampStr(body.idcard, 30);
  if (!name || !/(^\d{15}$)|(^\d{17}[\dXx]$)/.test(idcard)) return fail('姓名或身份证号格式不正确');
  user.realname = {
    name, idcardEnc: await aesEncrypt(env.SECRET, idcard),
    idcardTail: idcard.slice(-4), status: 'pending', at: now(),
  };
  await putUser(env, user);
  return ok({ status: 'pending' });
}

// ---------- 心跳 / 在线状态 ----------
export async function handleHeartbeat(env, req) {
  const { user, guestId } = await verifySession(env, req);
  const hour = new Date().getHours();
  const day = new Date().toISOString().slice(0, 10);
  // 在线小时曲线：同一小时同一用户只计一次
  if (user) {
    const mark = await env.DB.get(`hb:${day}:${hour}:${user.uid}`);
    if (!mark) {
      await env.DB.put(`hb:${day}:${hour}:${user.uid}`, '1', { expirationTtl: 86400 * 40 });
      await bumpStat(env, 'stats:hourly', 1, `${day}:${hour}`);
    }
    user.lastSeen = now();
    await putUser(env, user);
  } else if (guestId) {
    const mark = await env.DB.get(`hb:${day}:${hour}:g:${guestId}`);
    if (!mark) {
      await env.DB.put(`hb:${day}:${hour}:g:${guestId}`, '1', { expirationTtl: 86400 * 40 });
      await bumpStat(env, 'stats:hourly', 1, `${day}:${hour}`);
    }
  }
  return ok({ t: now() });
}

// ---------- 用户公开信息（他人主页用） ----------
export async function handleUserInfo(env, req, id) {
  const u = await getUser(env, id);
  if (!u) return fail('用户不存在', 404);
  return ok({
    uid: u.uid, username: u.username, avatar: u.avatar, bio: u.bio,
    gender: u.gender, city: u.city, role: u.role,
    level: giftLevel(u.giftValue).level, levelName: giftLevel(u.giftValue).name,
    online: (now() - (u.lastSeen || 0)) < 90000,
    lastSeenText: (now() - (u.lastSeen || 0)) < 90000 ? '在线' : agoText(u.lastSeen),
  });
}

// ---------- 送礼头衔等级：1-10灰 10-20蓝 20-30绿 30-40金 40-50紫 50+红 ----------
export function giftLevel(value) {
  const lv = Math.min(60, Math.floor(Math.sqrt(Math.max(0, value) / 100)) + 1);
  let name, color;
  if (lv < 10) { name = '灰色头衔'; color = '#9ca3af'; }
  else if (lv < 20) { name = '蓝色头衔'; color = '#3b82f6'; }
  else if (lv < 30) { name = '绿色头衔'; color = '#22c55e'; }
  else if (lv < 40) { name = '金色头衔'; color = '#f59e0b'; }
  else if (lv < 50) { name = '紫色头衔'; color = '#a855f7'; }
  else { name = '红色头衔'; color = '#ef4444'; }
  return { level: lv, name, color };
}

// 供其他模块使用
export { bumpStat, SESSION_COOKIE };
