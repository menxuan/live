// ============ 业务接口：好友 / 私信 / 图文视频 / 审核 / 礼物钱包 / 提现 / 客服 / 管理 / 大屏统计 ============
import { ok, fail, now, uid, clampStr, need } from './util.js';
import { getUser, putUser, verifySession, findUserBy, giftLevel, bumpStat } from './auth.js';

const DAY = () => new Date().toISOString().slice(0, 10);
const mod = (n) => `mod:${n}`; // 审核设置 KV key

async function getSetting(env, key, def) {
  const v = await env.DB.get(mod(key));
  return v === null ? def : JSON.parse(v);
}
async function setSetting(env, key, val) {
  await env.DB.put(mod(key), JSON.stringify(val));
}

// ---------- 内容审核：AI 优先，人工兜底 ----------
export async function reviewContent(env, text) {
  const auto = await getSetting(env, 'autoReview', true);       // AI 自动审核开关
  const manual = await getSetting(env, 'manualReview', true);   // 人工审核开关
  if (manual) return { pass: null, reason: '待人工审核' };      // 人工审核开启时全部进队列
  if (auto && env.AI_REVIEW_URL) {
    try {
      const r = await fetch(env.AI_REVIEW_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.AI_REVIEW_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: '你需要对下方内容合规性进行判断，如果存在侮辱性，低俗色情，赌博，政治敏感，涉及机密，涉及毒品和非法内容，一律输出违规，否则输出合规，不要思考和输出其他内容，只要输出这两个字' },
          { role: 'user', content: String(text).slice(0, 2000) },
        ] }),
      });
      const verdict = (await r.text()).trim();
      return verdict.includes('违规') ? { pass: false, reason: 'AI 判定违规' } : { pass: true };
    } catch { return { pass: null, reason: 'AI 审核不可用，转人工' }; }
  }
  return { pass: true }; // 两者都关 = 不审核直接发布
}

// 通用关键词频率统计（游客喜好）
async function logKeywords(env, text) {
  const words = String(text || '').match(/[\u4e00-\u9fa5A-Za-z0-9_]{2,12}/g) || [];
  const day = DAY();
  for (const w of [...new Set(words)].slice(0, 20)) {
    await bumpStat(env, 'stats:kw', 1, `${day}:${w}`);
  }
}

// ============ 好友 ============
export async function handleFriendAdd(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const body = await req.json();
  const target = await getUser(env, body.uid);
  if (!target) return fail('用户不存在');
  if (target.uid === user.uid) return fail('不能添加自己');
  await env.DB.put(`friend:${user.uid}:${target.uid}`, JSON.stringify({ at: now() }));
  await env.DB.put(`friend:${target.uid}:${user.uid}`, JSON.stringify({ at: now() }));
  return ok();
}

export async function handleFriendList(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const list = await env.DB.list({ prefix: `friend:${user.uid}:` });
  const out = [];
  for (const k of list.keys) {
    const u = await getUser(env, k.name.split(':')[2]);
    if (!u) continue;
    const online = (now() - (u.lastSeen || 0)) < 90000;
    out.push({
      uid: u.uid, username: u.username, avatar: u.avatar, dnd: u.dnd,
      online, status: online ? (u.dnd ? 'dnd' : 'online') : 'offline',
      lastSeenText: online ? '在线' : new Date(u.lastSeen || 0).toLocaleString('zh-CN'),
    });
  }
  return ok({ list: out });
}

// ============ 私信 / 系统信箱 ============
export async function handleDmSend(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  if (user.dmBanned) return fail('你已被限制私信功能', 403);
  const body = await req.json();
  const to = await getUser(env, body.to);
  if (!to) return fail('用户不存在');
  if (to.dnd) return fail('对方开启了免打扰，无法发起私信', 403);
  const msg = {
    id: uid('m'), from: user.uid, to: to.uid, type: 'text',
    text: clampStr(body.text, 500), at: now(), read: false,
  };
  await env.DB.put(`dm:${to.uid}:${msg.id}`, JSON.stringify(msg));
  await env.DB.put(`dm:${user.uid}:${msg.id}`, JSON.stringify(msg));
  await logKeywords(env, msg.text);
  return ok({ id: msg.id });
}

export async function handleDmList(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const list = await env.DB.list({ prefix: `dm:${user.uid}:` });
  const msgs = [];
  for (const k of list.keys.slice(-200)) msgs.push(JSON.parse(await env.DB.get(k.name)));
  msgs.sort((a, b) => b.at - a.at);
  return ok({ list: msgs });
}

// ============ 图文 / 视频发布（抖音式） ============
export async function handlePostCreate(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const body = await req.json();
  const text = clampStr(body.text, 1000);
  if (!text && !body.image) return fail('内容不能为空');
  const verdict = await reviewContent(env, text + ' ' + (body.title || ''));
  const post = {
    id: uid('p'), author: user.uid, text,
    image: clampStr(body.image, 700000),   // 小图 base64，KV 单值限制内
    video: clampStr(body.video, 700000),   // 裁剪后的短视频 base64
    music: clampStr(body.music, 200),
    status: verdict.pass === null ? 'pending' : (verdict.pass ? 'approved' : 'rejected'),
    reason: verdict.reason || '', forwards: 0, likes: 0, at: now(),
  };
  await env.DB.put(`post:${post.id}`, JSON.stringify(post));
  await env.DB.put(`posts:${user.uid}:${post.id}`, '1');
  await bumpStat(env, 'stats:posts:' + post.status);
  if (post.status === 'pending') {
    await env.DB.put(`review:post:${post.id}`, JSON.stringify({ id: post.id, kind: 'post', at: now() }));
  }
  await logKeywords(env, text);
  return ok({ id: post.id, status: post.status, reason: post.reason });
}

export async function handlePostFeed(env, req) {
  const list = await env.DB.list({ prefix: 'post:' });
  const out = [];
  for (const k of list.keys.slice(-100).reverse()) {
    const p = JSON.parse(await env.DB.get(k.name));
    if (p.status !== 'approved' && p.status !== undefined) { if (p.status !== 'approved') continue; }
    const a = await getUser(env, p.author);
    out.push({ ...p, authorName: a ? a.username : '未知', authorAvatar: a ? a.avatar : '' });
    if (out.length >= 30) break;
  }
  return ok({ list: out });
}

export async function handlePostAction(env, req, id, action) {
  const p = JSON.parse(await env.DB.get(`post:${id}`) || 'null');
  if (!p) return fail('内容不存在', 404);
  if (action === 'forward') { p.forwards = (p.forwards || 0) + 1; await env.DB.put(`post:${id}`, JSON.stringify(p)); }
  if (action === 'like') { p.likes = (p.likes || 0) + 1; await env.DB.put(`post:${id}`, JSON.stringify(p)); }
  return ok({ forwards: p.forwards, likes: p.likes });
}

// ============ 曝光卡 ============
export async function handleExposureBuy(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const price = 100; // 元
  if (user.balance < price) return fail('余额不足，请联系管理员充值');
  user.balance -= price;
  await putUser(env, user);
  const day = DAY();
  await bumpStat(env, 'stats:exposure', 1, day);
  // 生成曝光推送：在线非房主直播用户可见
  await env.DB.put(`exposure:${day}:${uid('x')}`, JSON.stringify({ uid: user.uid, username: user.username, at: now() }), { expirationTtl: 86400 });
  return ok({ balance: user.balance });
}

// ============ 提现 ============
export async function handleWithdraw(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const body = await req.json();
  const amount = Math.floor(Number(body.amount));
  if (!amount || amount < 1) return fail('提现金额不正确');
  if (user.balance < amount) return fail('余额不足');
  const w = { id: uid('w'), uid: user.uid, username: user.username, amount, status: 'pending', at: now(), note: '' };
  await env.DB.put(`withdraw:${w.id}`, JSON.stringify(w));
  await bumpStat(env, 'stats:withdraw:pending');
  await env.DB.put(`inbox:${user.uid}:${uid('n')}`, JSON.stringify({ text: `你的提现申请 ¥${amount} 已提交，等待审核对账。`, at: now() }));
  return ok({ id: w.id });
}

// ============ 客服工单（排队路由：空闲在线客服 → 顺序排队 → 最高管理员） ============
export async function handleTicketCreate(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const body = await req.json();
  const text = clampStr(body.text, 500);
  if (!text) return fail('请描述你的问题');
  // 选客服：在线、非忙碌
  const csList = await env.DB.list({ prefix: 'user:' });
  let chosen = null, fallback = null;
  for (const k of csList.keys) {
    const u = JSON.parse(await env.DB.get(k.name));
    if (u.role === 'cs' && !u.banned) {
      if (!fallback) fallback = u;
      const busy = await env.DB.get(`csbusy:${u.uid}`);
      const online = (now() - (u.lastSeen || 0)) < 90000;
      if (online && !busy) { chosen = u; break; }
    }
  }
  if (!chosen) chosen = fallback;
  let assignRole = chosen ? 'cs' : 'admin';
  const t = {
    id: uid('t'), uid: user.uid, username: user.username,
    assignee: chosen ? chosen.uid : 'admin', assignRole,
    text, status: 'open', at: now(), rating: null, comment: '',
  };
  await env.DB.put(`ticket:${t.id}`, JSON.stringify(t));
  await env.DB.put(`ticketu:${user.uid}:${t.id}`, '1');
  return ok({ id: t.id, assignRole });
}

export async function handleTicketList(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  let prefix = user.role === 'admin' ? 'ticket:' : `ticketu:${user.uid}:`;
  const list = await env.DB.list({ prefix });
  const out = [];
  for (const k of list.keys.slice(-50).reverse()) {
    const raw = await env.DB.get(k.name);
    if (!raw) { // ticketu 索引
      const t = JSON.parse(await env.DB.get(`ticket:${k.name.split(':')[2]}`) || 'null');
      if (t) out.push(t);
    } else out.push(JSON.parse(raw));
  }
  return ok({ list: out });
}

export async function handleTicketRate(env, req, id) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const t = JSON.parse(await env.DB.get(`ticket:${id}`) || 'null');
  if (!t || t.uid !== user.uid) return fail('工单不存在', 404);
  const body = await req.json();
  t.rating = Math.max(1, Math.min(5, Number(body.stars) || 5));
  t.comment = clampStr(body.comment, 200);
  await env.DB.put(`ticket:${id}`, JSON.stringify(t));
  return ok();
}

// ============ 管理接口（仅 admin / cs） ============
async function requireStaff(env, req) {
  const { user } = await verifySession(env, req);
  if (!user || (user.role !== 'admin' && user.role !== 'cs')) return { err: fail('无权限', 403) };
  return { user };
}

export async function handleAdminUsers(env, req) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  const list = await env.DB.list({ prefix: 'user:' });
  const out = [];
  for (const k of list.keys.slice(-300)) {
    const u = JSON.parse(await env.DB.get(k.name));
    const { passHash, passEnc, salt, phoneEnc, emailEnc, ...safe } = u;
    out.push({
      ...safe,
      phone: u.phoneEnc ? '****' + u.phoneTail : '',
      passTail: u.passEnc ? '(后台可查)' : '', // 前端不直接给明文，走专用接口
      level: giftLevel(u.giftValue || 0),
    });
  }
  return ok({ list: out, me: user.role });
}

export async function handleAdminUserPass(env, req, id) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  if (user.role !== 'admin') return fail('仅最高管理员可查看', 403);
  const { aesDecrypt } = await import('./util.js');
  const u = await getUser(env, id);
  if (!u) return fail('用户不存在', 404);
  return ok({ password: await aesDecrypt(env.SECRET, u.passEnc) });
}

export async function handleAdminSetRole(env, req, id) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  if (user.role !== 'admin') return fail('仅最高管理员可操作', 403);
  const u = await getUser(env, id);
  if (!u) return fail('用户不存在', 404);
  const body = await req.json();
  if (!['user', 'streamer', 'cs', 'admin'].includes(body.role)) return fail('角色无效');
  const old = u.role;
  u.role = body.role;
  await putUser(env, u);
  if (old !== u.role) { await bumpStat(env, 'stats:type:' + old, -1); await bumpStat(env, 'stats:type:' + u.role, 1); }
  return ok();
}

export async function handleAdminToggle(env, req, id, field) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  const u = await getUser(env, id);
  if (!u) return fail('用户不存在', 404);
  if (field === 'banned' || field === 'chatBanned' || field === 'dmBanned') {
    u[field] = !u[field];
    await putUser(env, u);
    return ok({ [field]: u[field] });
  }
  return fail('字段无效');
}

export async function handleAdminRecharge(env, req, id) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  const u = await getUser(env, id);
  if (!u) return fail('用户不存在', 404);
  const body = await req.json();
  const amount = Math.floor(Number(body.amount));
  if (!amount || amount <= 0) return fail('金额不正确');
  u.balance += amount;
  await putUser(env, u);
  await env.DB.put(`recharge:${uid('r')}`, JSON.stringify({ uid: u.uid, username: u.username, amount, by: user.uid, at: now() }));
  await env.DB.put(`inbox:${u.uid}:${uid('n')}`, JSON.stringify({ text: `管理员已为你的账户充值 ¥${amount}。`, at: now() }));
  return ok({ balance: u.balance });
}

// ---------- 审核队列 ----------
export async function handleReviewList(env, req) {
  const { err } = await requireStaff(env, req);
  if (err) return err;
  const list = await env.DB.list({ prefix: 'review:' });
  const out = [];
  for (const k of list.keys.slice(-100).reverse()) {
    const item = JSON.parse(await env.DB.get(k.name));
    if (item.kind === 'post') {
      const p = JSON.parse(await env.DB.get(`post:${item.id}`) || 'null');
      if (p) { const a = await getUser(env, p.author); out.push({ ...item, post: p, authorName: a?.username }); }
    } else if (item.kind === 'realname') {
      const u = await getUser(env, item.uid);
      if (u?.realname) out.push({ ...item, name: u.realname.name, idcardTail: u.realname.idcardTail });
    }
  }
  return ok({ list: out });
}

export async function handleReviewPost(env, req, id, pass) {
  const { err } = await requireStaff(env, req);
  if (err) return err;
  const p = JSON.parse(await env.DB.get(`post:${id}`) || 'null');
  if (!p) return fail('内容不存在', 404);
  p.status = pass ? 'approved' : 'rejected';
  p.reason = pass ? '' : '人工审核未通过';
  await env.DB.put(`post:${id}`, JSON.stringify(p));
  await env.DB.delete(`review:post:${id}`);
  await env.DB.put(`inbox:${p.author}:${uid('n')}`, JSON.stringify({
    text: pass ? '你发布的内容已通过审核。' : '你发布的内容审核未通过，已被下架。', at: now(),
  }));
  return ok();
}

export async function handleReviewRealname(env, req, id, pass) {
  const { err } = await requireStaff(env, req);
  if (err) return err;
  const u = await getUser(env, id);
  if (!u || !u.realname) return fail('申请不存在', 404);
  u.realname.status = pass ? 'approved' : 'rejected';
  if (pass && u.role === 'user') {
    u.role = 'streamer';
    await bumpStat(env, 'stats:type:user', -1);
    await bumpStat(env, 'stats:type:streamer', 1);
  }
  await putUser(env, u);
  await env.DB.delete(`review:realname:${id}`);
  await env.DB.put(`inbox:${u.uid}:${uid('n')}`, JSON.stringify({
    text: pass ? '实名认证已通过，直播权限已开通。' : '实名认证未通过，请核对信息后重新提交。', at: now(),
  }));
  return ok();
}

// ---------- 提现审批 ----------
export async function handleWithdrawList(env, req) {
  const { err } = await requireStaff(env, req);
  if (err) return err;
  const list = await env.DB.list({ prefix: 'withdraw:' });
  const out = [];
  for (const k of list.keys.slice(-100).reverse()) out.push(JSON.parse(await env.DB.get(k.name)));
  return ok({ list: out });
}

export async function handleWithdrawDecide(env, req, id) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  const body = await req.json();
  const w = JSON.parse(await env.DB.get(`withdraw:${id}`) || 'null');
  if (!w || w.status !== 'pending') return fail('申请不存在或已处理', 404);
  const u = await getUser(env, w.uid);
  // 大金额必须最高管理员；客服只能处理小额
  const isBig = w.amount >= 500;
  if (isBig && user.role !== 'admin') return fail('大额提现需最高管理员审批', 403);
  w.status = body.approve ? 'approved' : 'rejected';
  w.note = clampStr(body.note, 200);
  w.handler = user.uid;
  if (body.approve && u) {
    u.balance -= w.amount; // 出账（余额在申请时未冻结，批准时扣减）
    if (u.balance < 0) { w.status = 'rejected'; w.note = '对账失败：余额不足'; }
    else await putUser(env, u);
  }
  await env.DB.put(`withdraw:${id}`, JSON.stringify(w));
  await bumpStat(env, 'stats:withdraw:pending', -1);
  await env.DB.put(`inbox:${w.uid}:${uid('n')}`, JSON.stringify({
    text: body.approve ? `你的提现已批准，金额 ¥${w.amount}，管理员将对接打款。` : `你的提现已拒绝：${w.note || '对账未通过'}`, at: now(),
  }));
  return ok({ status: w.status });
}

// ---------- 充值明细 ----------
export async function handleRechargeList(env, req) {
  const { err } = await requireStaff(env, req);
  if (err) return err;
  const list = await env.DB.list({ prefix: 'recharge:' });
  const out = [];
  for (const k of list.keys.slice(-100).reverse()) out.push(JSON.parse(await env.DB.get(k.name)));
  return ok({ list: out });
}

// ---------- 审核设置 ----------
export async function handleModSettings(env, req) {
  const { err } = await requireStaff(env, req);
  if (err) return err;
  if (req.method === 'GET') {
    return ok({
      autoReview: await getSetting(env, 'autoReview', true),
      manualReview: await getSetting(env, 'manualReview', true),
      sessionTtl: Number(env.SESSION_TTL || 7200),
    });
  }
  const body = await req.json();
  if (body.autoReview !== undefined) await setSetting(env, 'autoReview', !!body.autoReview);
  if (body.manualReview !== undefined) await setSetting(env, 'manualReview', !!body.manualReview);
  return ok();
}

// ---------- 创建客服 / 管理账号 ----------
export async function handleAdminCreateAccount(env, req) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  if (user.role !== 'admin') return fail('仅最高管理员可创建', 403);
  const body = await req.json();
  const { sha256, aesEncrypt, uid: newUid } = await import('./util.js');
  const username = clampStr(body.username, 20);
  const password = String(body.password || '');
  if (username.length < 2 || password.length < 6) return fail('用户名至少 2 位，密码至少 6 位');
  if (await findUserBy(env, 'username', username)) return fail('用户名已存在');
  const role = body.role === 'cs' ? 'cs' : 'admin';
  const salt = newUid('s');
  const id = newUid('u');
  const u = {
    uid: id, username, passHash: await sha256(salt + ':' + password),
    passEnc: await aesEncrypt(env.SECRET, password), salt,
    role, phoneEnc: '', emailEnc: '', phoneTail: '', gender: '保密', birthday: '', city: '',
    tags: [], realname: { name: '内部账号', idcardEnc: '', idcardTail: '', status: 'approved' },
    avatar: '', bio: '', balance: 0, giftValue: 0, banned: false,
    chatBanned: false, dmBanned: false, dnd: false,
    device: { os: '其他', browser: '其他', type: '其他', fp: '' },
    createdAt: now(), lastSeen: 0, keepOnline: false,
  };
  await putUser(env, u);
  await env.DB.put(`username:${username}`, id);
  await bumpStat(env, 'stats:type:' + role, 1);
  return ok({ uid: id });
}

// ============ 授权管理（其他站长使用本系统：绑定域名+IP+时长） ============
export async function handleLicenseList(env, req) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  if (user.role !== 'admin') return fail('仅最高管理员可管理授权', 403);
  const list = await env.DB.list({ prefix: 'lic:' });
  const out = [];
  for (const k of list.keys) out.push(JSON.parse(await env.DB.get(k.name)));
  return ok({ list: out });
}

export async function handleLicenseSave(env, req) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  if (user.role !== 'admin') return fail('仅最高管理员可管理授权', 403);
  const body = await req.json();
  const id = clampStr(body.id, 40) || uid('lic');
  const days = Math.max(1, Math.floor(Number(body.days) || 365));
  const lic = {
    id, userId: clampStr(body.userId, 40), key: uid('k') + Math.random().toString(36).slice(2, 10),
    domain: clampStr(body.domain, 100), ip: clampStr(body.ip, 40),
    expireAt: now() + days * 86400 * 1000, createdAt: now(),
  };
  await env.DB.put(`lic:${id}`, JSON.stringify(lic));
  return ok({ license: lic });
}

export async function handleLicenseRevoke(env, req, id) {
  const { user, err } = await requireStaff(env, req);
  if (err) return err;
  if (user.role !== 'admin') return fail('仅最高管理员可操作', 403);
  await env.DB.delete(`lic:${id}`);
  return ok();
}

// ============ 大屏统计（管理员） ============
export async function handleStats(env, req) {
  const { err } = await requireStaff(env, req);
  if (err) return err;
  const url = new URL(req.url);
  const range = url.searchParams.get('range') || 'today';
  const day = DAY();
  const days = range === 'rt' ? [day] : range === 'today' ? [day] :
    Array.from({ length: range === 'd7' ? 7 : 30 }, (_, i) => {
      const d = new Date(now() - i * 86400 * 1000);
      return d.toISOString().slice(0, 10);
    }).reverse();

  // 性别 / 年龄 / 设备 / 类型 / 城市（全量预聚合）
  async function collect(prefix) {
    const list = await env.DB.list({ prefix });
    const out = {};
    for (const k of list.keys) out[k.name.slice(prefix.length)] = Number(await env.DB.get(k.name));
    return out;
  }
  const gender = await collect('stats:gender:');
  const age = await collect('stats:age:');
  const device = await collect('stats:device:');
  const types = await collect('stats:type:');
  let city = await collect('stats:city:');
  city = Object.fromEntries(Object.entries(city).sort((a, b) => b[1] - a[1]).slice(0, 10));

  // 24 小时曲线 + 关键词：按日合并
  let hourly = new Array(24).fill(0);
  let kw = {};
  for (const d of days) {
    for (let h = 0; h < 24; h++) hourly[h] += Number(await env.DB.get(`stats:hourly:${d}:${h}`) || 0);
    const kwList = await env.DB.list({ prefix: `stats:kw:${d}:` });
    for (const k of kwList.keys) {
      const w = k.name.split(':')[3];
      kw[w] = (kw[w] || 0) + Number(await env.DB.get(k.name));
    }
  }
  const keywords = Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => ({ k, v }));

  // 待办计数
  const reviews = await env.DB.list({ prefix: 'review:' });
  const withdraws = await env.DB.list({ prefix: 'withdraw:' });
  let wdPending = 0;
  for (const k of withdraws.keys) { const w = JSON.parse(await env.DB.get(k.name)); if (w.status === 'pending') wdPending++; }
  let rnPending = 0;
  for (const k of reviews.keys) { const r = JSON.parse(await env.DB.get(k.name)); if (r.kind === 'realname') rnPending++; }

  const total = Number(await env.DB.get('stats:total') || 0);
  let newCnt = 0;
  for (const d of days) newCnt += Number(await env.DB.get('stats:new:' + d) || 0);

  return ok({
    range, total, newReg: newCnt,
    gender, age, device, types, city, hourly, keywords,
    todos: { realname: rnPending, content: reviews.keys.length - rnPending, withdraw: wdPending },
    giftIncome: Number(await env.DB.get('stats:gift:' + day) || 0),
  });
}

// 礼物目录（等级动画前端做）
export const GIFTS = [
  { id: 'flower', name: '鲜花', price: 1 },
  { id: 'candy', name: '棒棒糖', price: 5 },
  { id: 'plane', name: '飞机', price: 50 },
  { id: 'rocket', name: '火箭', price: 200 },
  { id: 'castle', name: '城堡', price: 1000 },
];
