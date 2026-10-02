// ============ 直播间系统 主入口：授权校验 + 路由 + 静态资源 ============
// 只用 KV + Durable Object，不用 R2。
import { json, ok, fail, now, uid, clampStr, need, hmac, hmacVerify } from './src/util.js';
import {
  handlePubkey, handleRegister, handleLogin, handleLogout, handleMe,
  handleProfile, handleRealname, handleHeartbeat, handleUserInfo,
  getUser, putUser, verifySession, findUserBy, bumpStat,
} from './src/auth.js';
import {
  handleFriendAdd, handleFriendList, handleDmSend, handleDmList,
  handlePostCreate, handlePostFeed, handlePostAction, handleExposureBuy,
  handleWithdraw, handleTicketCreate, handleTicketList, handleTicketRate,
  handleAdminUsers, handleAdminUserPass, handleAdminSetRole, handleAdminToggle,
  handleAdminRecharge, handleReviewList, handleReviewPost, handleReviewRealname,
  handleWithdrawList, handleWithdrawDecide, handleRechargeList, handleModSettings,
  handleAdminCreateAccount, handleLicenseList, handleLicenseSave, handleLicenseRevoke,
  handleStats,
} from './src/api.js';

// Durable Object 类必须从入口导出，否则 Pages 构建报错「not exported in your entrypoint」
export { RoomDO } from './src/RoomDO.js';

const CONTACT = 'WX：byz0325L,QQ:2857936445';
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
};

function securityHeaders(resp) {
  resp.headers.set('X-Content-Type-Options', 'nosniff');
  resp.headers.set('X-Frame-Options', 'SAMEORIGIN');
  resp.headers.set('Referrer-Policy', 'same-origin');
  return resp;
}

// ---------- 站点授权：绑定域名 + IP + 有效期（对不上 = 未授权，前端清空渲染） ----------
async function checkSiteLicense(env, req) {
  let lic = await env.DB.get('lic:site', 'json');
  const host = (req.headers.get('host') || '').toLowerCase().split(':')[0];
  if (!lic) {
    // 首次访问自动建档（绑定当前域名，IP 不限；管理员可在后台改绑）
    lic = { id: 'site', userId: 'owner', key: 'local', domain: host, ip: '*', expireAt: now() + 100 * 365 * 86400 * 1000, createdAt: now() };
    await env.DB.put('lic:site', JSON.stringify(lic));
  }
  const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0';
  const domainOk = lic.domain === '*' || lic.domain === host;
  const ipOk = lic.ip === '*' || lic.ip === ip;
  const timeOk = lic.expireAt > now();
  if (domainOk && ipOk && timeOk) return { valid: true, lic };
  // 记录并拦截违规访问者
  await env.DB.put(`banip:${ip}`, String(now()), { expirationTtl: 86400 * 30 });
  return { valid: false, lic, ip };
}

function unauthorizedPage(expireAt) {
  const exp = new Date(expireAt).toLocaleString('zh-CN');
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>未授权</title></head>
     <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0f1e;color:#fff;font-family:sans-serif;">
     <div style="text-align:center;"><h1 style="color:#f43f5e;">你的系统未授权，请联系管理员授权</h1>
     <p>到期时间：${exp}</p><p>联系方式：${CONTACT}</p></div></body></html>`,
    { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------- 首次启动：创建最高管理员 ----------
async function seedAdmin(env) {
  const exists = await findUserBy(env, 'username', env.ADMIN_USER || 'aluo1207');
  if (exists) return;
  const { sha256, aesEncrypt } = await import('./src/util.js');
  const salt = uid('s');
  const pass = env.ADMIN_PASS || 'aluo1207@126.com';
  const id = uid('u');
  const u = {
    uid: id, username: env.ADMIN_USER || 'aluo1207',
    passHash: await sha256(salt + ':' + pass), passEnc: await aesEncrypt(env.SECRET, pass), salt,
    role: 'admin', phoneEnc: '', emailEnc: '', phoneTail: '', gender: '保密', birthday: '', city: '',
    tags: [], realname: { name: '最高管理员', idcardEnc: '', idcardTail: '', status: 'approved' },
    avatar: '', bio: '', balance: 0, giftValue: 0, banned: false,
    chatBanned: false, dmBanned: false, dnd: false,
    device: { os: '其他', browser: '其他', type: '其他', fp: '' },
    createdAt: now(), lastSeen: 0, keepOnline: false,
  };
  await putUser(env, u);
  await env.DB.put(`username:${u.username}`, id);
  await bumpStat(env, 'stats:type:admin', 1);
}

export default {
  async fetch(req, env, ctx) {
    await seedAdmin(env);
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ===== 授权校验（除验证接口本身外全部受控） =====
    const licCheck = await checkSiteLicense(env, req);
    if (!licCheck.valid && !path.startsWith('/api/license/')) {
      return unauthorizedPage(licCheck.lic.expireAt);
    }

    // ===== API 路由 =====
    try {
      // --- 开放接口 ---
      if (path === '/api/pubkey') return securityHeaders(await handlePubkey(env));
      if (path === '/api/register' && method === 'POST') return securityHeaders(await handleRegister(env, req));
      if (path === '/api/login' && method === 'POST') return securityHeaders(await handleLogin(env, req));
      if (path === '/api/license/verify') return securityHeaders(await handleLicenseVerify(env, req));

      if (path === '/api/logout') return securityHeaders(await handleLogout());
      if (path === '/api/me') return securityHeaders(await handleMe(env, req));
      if (path === '/api/profile' && method === 'POST') return securityHeaders(await handleProfile(env, req));
      if (path === '/api/realname' && method === 'POST') return securityHeaders(await handleRealname(env, req));
      if (path === '/api/heartbeat') return securityHeaders(await handleHeartbeat(env, req));
      if (path.startsWith('/api/user/')) return securityHeaders(await handleUserInfo(env, req, path.split('/')[3]));

      // --- 社交 ---
      if (path === '/api/friend/add' && method === 'POST') return securityHeaders(await handleFriendAdd(env, req));
      if (path === '/api/friends') return securityHeaders(await handleFriendList(env, req));
      if (path === '/api/dm/send' && method === 'POST') return securityHeaders(await handleDmSend(env, req));
      if (path === '/api/dm') return securityHeaders(await handleDmList(env, req));
      if (path === '/api/dm/redpacket' && method === 'POST') return securityHeaders(await handleDmRedpacket(env, req));
      if (path === '/api/dm/redpacket/claim' && method === 'POST') return securityHeaders(await handleDmRedpacketClaim(env, req));
      if (path === '/api/inbox') return securityHeaders(await handleInbox(env, req));

      // --- 内容 ---
      if (path === '/api/post' && method === 'POST') return securityHeaders(await handlePostCreate(env, req));
      if (path === '/api/feed') return securityHeaders(await handlePostFeed(env, req));
      let pm = path.match(/^\/api\/post\/([\w-]+)\/(forward|like)$/);
      if (pm && method === 'POST') return securityHeaders(await handlePostAction(env, req, pm[1], pm[2]));

      // --- 钱包 / 曝光卡 ---
      if (path === '/api/exposure/buy' && method === 'POST') return securityHeaders(await handleExposureBuy(env, req));
      if (path === '/api/withdraw' && method === 'POST') return securityHeaders(await handleWithdraw(env, req));

      // --- 客服工单 ---
      if (path === '/api/ticket' && method === 'POST') return securityHeaders(await handleTicketCreate(env, req));
      if (path === '/api/tickets') return securityHeaders(await handleTicketList(env, req));
      let tm = path.match(/^\/api\/ticket\/([\w-]+)\/rate$/);
      if (tm && method === 'POST') return securityHeaders(await handleTicketRate(env, req, tm[1]));

      // --- 管理 ---
      if (path === '/api/admin/users') return securityHeaders(await handleAdminUsers(env, req));
      let up = path.match(/^\/api\/admin\/user\/([\w-]+)\/pass$/);
      if (up) return securityHeaders(await handleAdminUserPass(env, req, up[1]));
      let ur = path.match(/^\/api\/admin\/user\/([\w-]+)\/role$/);
      if (ur && method === 'POST') return securityHeaders(await handleAdminSetRole(env, req, ur[1]));
      let ut = path.match(/^\/api\/admin\/user\/([\w-]+)\/toggle$/);
      if (ut && method === 'POST') return securityHeaders(await handleAdminToggle(env, req, ut[1]));
      if (path === '/api/admin/recharge' && method === 'POST') return securityHeaders(await handleAdminRecharge(env, req));
      if (path === '/api/admin/reviews') return securityHeaders(await handleReviewList(env, req));
      let rp = path.match(/^\/api\/admin\/review\/post\/([\w-]+)$/);
      if (rp && method === 'POST') return securityHeaders(await handleReviewPost(env, req, rp[1], (await req.json()).pass));
      let rr = path.match(/^\/api\/admin\/review\/realname\/([\w-]+)$/);
      if (rr && method === 'POST') return securityHeaders(await handleReviewRealname(env, req, rr[1], (await req.json()).pass));
      if (path === '/api/admin/withdraws') return securityHeaders(await handleWithdrawList(env, req));
      let wd = path.match(/^\/api\/admin\/withdraw\/([\w-]+)$/);
      if (wd && method === 'POST') return securityHeaders(await handleWithdrawDecide(env, req, wd[1]));
      if (path === '/api/admin/recharges') return securityHeaders(await handleRechargeList(env, req));
      if (path === '/api/admin/settings') return securityHeaders(await handleModSettings(env, req));
      if (path === '/api/admin/account' && method === 'POST') return securityHeaders(await handleAdminCreateAccount(env, req));
      if (path === '/api/admin/licenses' && method === 'POST') return securityHeaders(await handleLicenseSave(env, req));
      if (path === '/api/admin/licenses') return securityHeaders(await handleLicenseList(env, req));
      let lr = path.match(/^\/api\/admin\/licenses\/([\w-]+)\/revoke$/);
      if (lr && method === 'POST') return securityHeaders(await handleLicenseRevoke(env, req, lr[1]));

      // --- 大屏统计 ---
      if (path === '/api/stats') return securityHeaders(await handleStats(env, req));

      // --- 直播间（转发给 Durable Object） ---
      if (path === '/api/rooms') {
        return securityHeaders(await env.ROOMS.get('global').fetch(new Request('https://do/room/list')));
      }
      if (path === '/api/room/create' && method === 'POST') {
        const { user } = await verifySession(env, req);
        if (!user) return fail('未登录', 401);
        const headers = new Headers(req.headers); headers.set('X-User-Id', user.uid);
        return securityHeaders(await env.ROOMS.get('global').fetch(new Request('https://do/room/create', { method: 'POST', headers, body: await req.text() })));
      }
      if (path === '/api/room/close' && method === 'POST') {
        const { user } = await verifySession(env, req);
        if (!user) return fail('未登录', 401);
        const headers = new Headers(req.headers); headers.set('X-User-Id', user.uid);
        return securityHeaders(await env.ROOMS.get('global').fetch(new Request('https://do/room/close', { method: 'POST', headers, body: await req.text() })));
      }
      if (path === '/api/room/info') {
        return securityHeaders(await env.ROOMS.get('global').fetch(new Request('https://do/room/info?' + url.searchParams.toString())));
      }
      if (path === '/ws/room') { // WebSocket 升级直通 DO
        const { user } = await verifySession(env, req);
        const qs = new URLSearchParams(url.search);
        if (user) {
          qs.set('uid', user.uid); qs.set('name', user.username); qs.set('avatar', user.avatar || '');
        } else {
          qs.set('guest', '1'); qs.set('name', qs.get('name') || '游客');
        }
        const doReq = new Request('https://do/ws?' + qs.toString(), { headers: req.headers });
        return env.ROOMS.get('global').fetch(doReq);
      }

      // ===== 静态资源（不存在的一律 404，符合「全部 404 拒绝访问」） =====
      if (!path.startsWith('/api/') && !path.startsWith('/ws/')) {
        // 源码与配置文件绝不外泄
        const DENY = ['/src', '/_worker.js', '/wrangler.toml', '/package.json', '/README.md', '/node_modules'];
        if (DENY.some(p => path === p || path.startsWith(p + '/'))) return new Response('not found', { status: 404 });
        const clean = path === '/' ? '/index.html' : path;
        if (clean.includes('..')) return new Response('not found', { status: 404 });
        const assetResp = await env.ASSETS.fetch(new URL(clean, req.url).toString());
        if (assetResp && assetResp.status !== 404) {
          const resp = new Response(assetResp.body, assetResp);
          const ext = clean.slice(clean.lastIndexOf('.'));
          if (CONTENT_TYPES[ext]) resp.headers.set('Content-Type', CONTENT_TYPES[ext]);
          resp.headers.set('Cache-Control', clean.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
          return securityHeaders(resp);
        }
        return new Response('not found', { status: 404 });
      }
      return fail('接口不存在', 404);
    } catch (e) {
      return fail('服务器错误：' + e.message, 500);
    }
  },
};

// ---------- 授权验证接口（其他站点调用；也供本地 license.js 自检） ----------
async function handleLicenseVerify(env, req) {
  const body = await req.json().catch(() => ({}));
  const { userId, key, domain, ts, sign } = body;
  if (!userId || !key || !ts || !sign) return fail('参数不全');
  if (Math.abs(now() - Number(ts)) > 5 * 60000) return fail('时间戳过期', 403, { contact: CONTACT });
  // 全部许可证中匹配 userId + key + 域名
  const list = await env.DB.list({ prefix: 'lic:' });
  for (const k of list.keys) {
    const lic = JSON.parse(await env.DB.get(k.name));
    if (lic.userId === userId && lic.key === key && (lic.domain === '*' || lic.domain === String(domain || ''))) {
      if (lic.expireAt < now()) return fail('授权已到期', 403, { contact: CONTACT, expireAt: lic.expireAt });
      return ok({ expireAt: lic.expireAt, contact: CONTACT });
    }
  }
  return fail('未授权', 403, { contact: CONTACT });
}

// ---------- 私信红包 ----------
async function handleDmRedpacket(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  if (user.dmBanned) return fail('你已被限制私信功能', 403);
  const body = await req.json();
  const to = await getUser(env, body.to);
  const amount = Math.floor(Number(body.amount));
  if (!to || !amount || amount < 1) return fail('参数错误');
  if (user.balance < amount) return fail('余额不足');
  user.balance -= amount;
  await putUser(env, user);
  const msg = {
    id: uid('m'), from: user.uid, to: to.uid, type: 'redpacket', amount,
    text: '[红包]', at: now(), read: false, claimed: false,
  };
  await env.DB.put(`dm:${to.uid}:${msg.id}`, JSON.stringify(msg));
  await env.DB.put(`dm:${user.uid}:${msg.id}`, JSON.stringify(msg));
  return ok({ id: msg.id, balance: user.balance });
}

async function handleDmRedpacketClaim(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const body = await req.json();
  const mine = JSON.parse(await env.DB.get(`dm:${user.uid}:${body.id}`) || 'null');
  if (!mine || mine.type !== 'redpacket' || mine.claimed) return fail('红包不存在或已领取', 404);
  if (mine.to !== user.uid) return fail('无权领取', 403);
  mine.claimed = true;
  await env.DB.put(`dm:${user.uid}:${mine.id}`, JSON.stringify(mine));
  const other = JSON.parse(await env.DB.get(`dm:${mine.from}:${mine.id}`) || 'null');
  if (other) { other.claimed = true; await env.DB.put(`dm:${mine.from}:${mine.id}`, JSON.stringify(other)); }
  user.balance += mine.amount;
  await putUser(env, user);
  return ok({ balance: user.balance });
}

// ---------- 系统信箱 ----------
async function handleInbox(env, req) {
  const { user } = await verifySession(env, req);
  if (!user) return fail('未登录', 401);
  const list = await env.DB.list({ prefix: `inbox:${user.uid}:` });
  const out = [];
  for (const k of list.keys.slice(-50).reverse()) out.push(JSON.parse(await env.DB.get(k.name)));
  return ok({ list: out });
}
