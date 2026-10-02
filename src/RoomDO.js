// ============ RoomDO：全局大厅（房间管理 + WebSocket 实时中继 + WebRTC 信令 + PK + 礼物红包） ============
// 所有房间跑在一个全局 Durable Object 实例里（memory 为事实源，定期快照到 KV），
// WebRTC 媒体走 P2P，Worker 只传信令，延迟最低。

import { now, uid } from './util.js';
import { getUser, putUser, giftLevel, bumpStat } from './auth.js';
import { GIFTS } from './api.js';

const DAY = () => new Date().toISOString().slice(0, 10);

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();      // roomId -> room
    this.sockets = new Map();    // ws -> { uid, roomId }
    this.pkWait = { video: null, voice: null };
    this.snapshotTimer = null;
  }

  // ---------- HTTP：REST 也走 DO，保证读到实时内存态 ----------
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.endsWith('/ws')) return this.handleWebSocket(req);
    if (path.endsWith('/room/list')) return this.roomList();
    if (path.endsWith('/room/create')) return this.createRoom(req);
    if (path.endsWith('/room/close')) return this.closeRoom(req);
    if (path.endsWith('/room/info')) return this.roomInfo(url);
    return new Response('not found', { status: 404 });
  }

  async roomList() {
    const out = [];
    for (const r of this.rooms.values()) {
      out.push(this.publicRoom(r));
    }
    return Response.json({ ok: true, list: out, online: this.sockets.size });
  }

  publicRoom(r) {
    return {
      id: r.id, owner: r.owner, ownerName: r.ownerName, ownerAvatar: r.ownerAvatar,
      type: r.type, title: r.title, pk: !!r.pkPartner, cover: r.cover,
      count: r.members.size, startedAt: r.startedAt,
    };
  }

  async createRoom(req) {
    // 身份在 worker 已校验（cookie 头透传），这里取 uid
    const uidVal = req.headers.get('X-User-Id');
    const user = uidVal ? await getUser(this.env, uidVal) : null;
    if (!user) return Response.json({ ok: false, msg: '未登录' }, { status: 401 });
    const canLive = user.role === 'streamer' || user.role === 'admin';
    if (!canLive) return Response.json({ ok: false, msg: '未实名认证，无直播权限' }, { status: 403 });
    if (user.banned) return Response.json({ ok: false, msg: '账号已被封禁' }, { status: 403 });
    // 同一人只能开一个房
    for (const r of this.rooms.values()) if (r.owner === user.uid) return Response.json({ ok: false, msg: '你已有进行中的直播间' }, { status: 400 });
    const body = await req.json().catch(() => ({}));
    const type = body.type === 'voice' ? 'voice' : 'video';
    const id = uid('room');
    const room = {
      id, owner: user.uid, ownerName: user.username, ownerAvatar: user.avatar,
      type, title: String(body.title || user.username + ' 的直播间').slice(0, 30),
      members: new Map(),          // uid -> { ws, cam, mic, name, avatar, level }
      micAllowed: new Set(),       // 房主批准上麦的人
      pkPartner: null,
      danmaku: true, comment: true, allowUserCam: false, allowUserMic: false,
      startedAt: now(), cover: '',
    };
    this.rooms.set(id, room);
    await this.persistRooms();
    return Response.json({ ok: true, room: this.publicRoom(room) });
  }

  async closeRoom(req) {
    const uidVal = req.headers.get('X-User-Id');
    const body = await req.json().catch(() => ({}));
    const r = this.rooms.get(body.roomId);
    if (!r) return Response.json({ ok: false, msg: '直播间不存在' }, { status: 404 });
    if (r.owner !== uidVal && !(await this.isAdmin(uidVal))) return Response.json({ ok: false, msg: '只有房主或管理员可以关闭' }, { status: 403 });
    this.destroyRoom(r, '直播间已关闭');
    return Response.json({ ok: true });
  }

  async roomInfo(url) {
    const id = url.searchParams.get('id');
    const r = this.rooms.get(id);
    if (!r) return Response.json({ ok: false, msg: '直播间不存在或已关闭' }, { status: 404 });
    return Response.json({ ok: true, room: { ...this.publicRoom(r), danmaku: r.danmaku, comment: r.comment, allowUserCam: r.allowUserCam, allowUserMic: r.allowUserMic, micAllowed: [...r.micAllowed] } });
  }

  async isAdmin(uidVal) {
    const u = await getUser(this.env, uidVal);
    return u && u.role === 'admin';
  }

  // ---------- WebSocket ----------
  async handleWebSocket(req) {
    const url = new URL(req.url);
    const roomId = url.searchParams.get('room');
    const uidVal = url.searchParams.get('uid') || '';
    const name = url.searchParams.get('name') || '游客';
    const avatar = url.searchParams.get('avatar') || '';
    const guest = url.searchParams.get('guest') === '1';
    const room = this.rooms.get(roomId);
    if (!room) return new Response('直播间不存在或已关闭', { status: 404 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.set(server, { uid: uidVal, roomId, guest });
    const isOwner = uidVal === room.owner;
    const user = uidVal ? await getUser(this.env, uidVal) : null;
    if (uidVal && !room.members.has(uidVal)) {
      const lv = giftLevel(user ? user.giftValue : 0);
      room.members.set(uidVal, { ws: server, cam: false, mic: false, name, avatar, level: lv });
    }
    this.broadcast(room, { t: 'join', uid: uidVal, name, isOwner, count: room.members.size });
    this.broadcastMembers(room);

    server.addEventListener('message', (e) => this.onMessage(server, room, e.data));
    server.addEventListener('close', () => this.onLeave(server, room));
    server.addEventListener('error', () => this.onLeave(server, room));

    this.ensureSnapshot();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async onMessage(ws, room, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const ctx = this.sockets.get(ws);
    const uidVal = ctx ? ctx.uid : '';
    const isOwner = uidVal === room.owner;
    const user = uidVal ? await getUser(this.env, uidVal) : null;
    const member = uidVal ? room.members.get(uidVal) : null;

    switch (m.t) {
      case 'chat': { // 直播间聊天（房主可关）
        if (!uidVal || !user) return this.send(ws, { t: 'err', msg: '游客不能发言，请先登录' });
        if (user.chatBanned) return this.send(ws, { t: 'err', msg: '你已被限制直播间聊天' });
        if (!room.comment) return this.send(ws, { t: 'err', msg: '房主已关闭评论区留言' });
        const text = String(m.text || '').slice(0, 200);
        const lv = giftLevel(user.giftValue || 0);
        this.broadcast(room, { t: 'chat', uid: uidVal, name: user.username, avatar: user.avatar, text, level: lv });
        break;
      }
      case 'danmaku': { // 弹幕（房主可关）
        if (!uidVal || !user) return;
        if (user.chatBanned || !room.danmaku) return;
        this.broadcast(room, { t: 'danmaku', uid: uidVal, name: user.username, text: String(m.text || '').slice(0, 50) });
        break;
      }
      case 'gift': { // 送礼：扣余额 → 房主到账 80% → 等级重算
        if (!user) return;
        const g = GIFTS.find(x => x.id === m.giftId);
        const count = Math.max(1, Math.min(99, Math.floor(m.count || 1)));
        if (!g) return;
        const total = g.price * count;
        if (uidVal === room.owner) return this.send(ws, { t: 'err', msg: '房主不能给自己打赏' });
        if (user.balance < total) return this.send(ws, { t: 'err', msg: '余额不足，请联系管理员充值' });
        user.balance -= total;
        await putUser(this.env, user);
        const owner = await getUser(this.env, room.owner);
        let ownerEarn = 0;
        if (owner) {
          ownerEarn = Math.round(total * 0.8); // 平台服务费 20%
          owner.balance += ownerEarn;
          owner.giftValue = (owner.giftValue || 0) + total;
          await putUser(this.env, owner);
        }
        await bumpStat(this.env, 'stats:gift', total, DAY());
        const lv = giftLevel(owner ? owner.giftValue : 0);
        this.broadcast(room, { t: 'gift', from: user.username, to: room.ownerName, gift: g, count, total, ownerLevel: lv });
        break;
      }
      case 'redpacket': { // 直播间拼手气红包
        if (!user) return;
        const amount = Math.floor(Number(m.amount));
        const num = Math.max(1, Math.min(20, Math.floor(m.count || 5)));
        if (!amount || amount < num) return this.send(ws, { t: 'err', msg: '红包金额不正确' });
        if (user.balance < amount) return this.send(ws, { t: 'err', msg: '余额不足' });
        user.balance -= amount;
        await putUser(this.env, user);
        room.redpacket = { id: uid('rp'), from: uidVal, fromName: user.username, amountLeft: amount, countLeft: num, grabbed: {} };
        this.broadcast(room, { t: 'redpacket', rp: { id: room.redpacket.id, fromName: user.username, amount: amount, count: num } });
        break;
      }
      case 'redpacket:grab': {
        const rp = room.redpacket;
        if (!rp || rp.countLeft <= 0) return;
        if (!uidVal || rp.grabbed[uidVal]) return;
        const share = rp.countLeft === 1 ? rp.amountLeft : Math.max(1, Math.floor(Math.random() * (rp.amountLeft / rp.countLeft * 2)));
        const got = Math.min(share, rp.amountLeft);
        rp.amountLeft -= got; rp.countLeft -= 1; rp.grabbed[uidVal] = got;
        if (user) { user.balance += got; user.lastSeen = now(); await putUser(this.env, user); }
        this.broadcast(room, { t: 'redpacket:grab', name: user ? user.username : '游客', got, left: rp.countLeft });
        if (rp.countLeft <= 0) room.redpacket = null;
        break;
      }
      case 'applyMic': { // 申请上麦（房主审批）
        if (!uidVal || uidVal === room.owner) return;
        if (room.type === 'voice' && !room.allowUserMic) return this.send(ws, { t: 'err', msg: '语音房需房主允许后才能上麦' });
        this.toOwner(room, { t: 'applyMic', uid: uidVal, name: member ? member.name : '' });
        this.send(ws, { t: 'toast', msg: '已发送上麦申请，等待房主同意' });
        break;
      }
      case 'allowMic': { // 房主批准/拒绝
        if (!isOwner) return;
        const target = String(m.uid || '');
        if (m.allow) room.micAllowed.add(target); else room.micAllowed.delete(target);
        this.toUid(room, target, { t: 'micAllowed', allow: !!m.allow, cam: room.allowUserCam, mic: room.allowUserMic });
        this.broadcastMembers(room);
        break;
      }
      case 'toggle': { // 房主开关：弹幕 / 评论 / 允许用户摄像头 / 允许用户麦克风
        if (!isOwner) return;
        const key = { danmaku: 'danmaku', comment: 'comment', allowUserCam: 'allowUserCam', allowUserMic: 'allowUserMic' }[m.key];
        if (!key) return;
        room[key] = !!m.val;
        this.broadcast(room, { t: 'roomFlags', danmaku: room.danmaku, comment: room.comment, allowUserCam: room.allowUserCam, allowUserMic: room.allowUserMic });
        break;
      }
      case 'cam': case 'mic': { // 开关自己的摄像头/麦克风
        if (!member) return;
        if (uidVal !== room.owner && !room.micAllowed.has(uidVal)) return this.send(ws, { t: 'err', msg: '请先申请上麦，房主同意后才能开启' });
        if (m.t === 'cam' && (room.type === 'voice' || (uidVal !== room.owner && !room.allowUserCam))) return this.send(ws, { t: 'err', msg: room.type === 'voice' ? '语音直播间不能开启摄像头' : '房主未允许用户开启摄像头' });
        if (m.t === 'mic' && uidVal !== room.owner && !room.allowUserMic) return this.send(ws, { t: 'err', msg: '房主未允许用户开启麦克风' });
        member[m.t] = !!m.on;
        this.broadcast(room, { t: 'mediaState', uid: uidVal, cam: member.cam, mic: member.mic }, ws);
        this.broadcastMembers(room);
        break;
      }
      case 'pk:enter': { // 随机连线（同类型匹配）
        if (!isOwner) return;
        if (room.pkPartner) return;
        const wait = this.pkWait[room.type];
        if (wait && wait !== room.id && this.rooms.get(wait)) {
          const other = this.rooms.get(wait);
          if (other.type === room.type && !other.pkPartner) {
            room.pkPartner = wait; other.pkPartner = room.id;
            this.pkWait[room.type] = null;
            this.broadcast(room, { t: 'pk:start', partner: this.publicRoom(other) });
            this.broadcast(other, { t: 'pk:start', partner: this.publicRoom(room) });
            break;
          }
        }
        this.pkWait[room.type] = room.id;
        this.broadcast(room, { t: 'toast', msg: '正在为你匹配同类型直播间…' });
        break;
      }
      case 'pk:leave': {
        if (room.pkPartner) {
          const other = this.rooms.get(room.pkPartner);
          room.pkPartner = null;
          if (other) { other.pkPartner = null; this.broadcast(other, { t: 'pk:end' }); }
          this.broadcast(room, { t: 'pk:end' });
        }
        break;
      }
      case 'signal': { // WebRTC 信令中继（offer/answer/candidate）
        this.toUid(room, String(m.to || ''), { t: 'signal', from: uidVal, data: m.data });
        break;
      }
      case 'banUser': { // 房主把某人踢出直播间
        if (!isOwner) return;
        const target = String(m.uid || '');
        const tm = room.members.get(target);
        if (tm && tm.ws) { this.send(tm.ws, { t: 'kicked' }); tm.ws.close(1000, 'kicked'); }
        break;
      }
    }
  }

  onLeave(ws, room) {
    const ctx = this.sockets.get(ws);
    if (!ctx) return;
    this.sockets.delete(ws);
    if (ctx.uid && room.members.has(ctx.uid)) {
      room.members.delete(ctx.uid);
      room.micAllowed.delete(ctx.uid);
      this.broadcast(room, { t: 'leave', uid: ctx.uid, count: room.members.size });
      this.broadcastMembers(room);
    }
    // 房主离开 → 关房（链接失效）
    if (ctx.uid === room.owner) this.destroyRoom(room, '房主已结束直播');
    // 无成员 → 关房
    if (room.members.size === 0 && this.pkWait[room.type] === room.id) this.pkWait[room.type] = null;
    if (room.members.size === 0) { this.rooms.delete(room.id); this.persistRooms(); }
  }

  destroyRoom(room, reason) {
    for (const [, m] of room.members) {
      if (m.ws) { try { this.send(m.ws, { t: 'closed', msg: reason }); m.ws.close(1000, 'closed'); } catch {} }
    }
    if (room.pkPartner) {
      const other = this.rooms.get(room.pkPartner);
      if (other) { other.pkPartner = null; this.broadcast(other, { t: 'pk:end' }); }
    }
    if (this.pkWait[room.type] === room.id) this.pkWait[room.type] = null;
    room.members.clear();
    this.rooms.delete(room.id);
    this.persistRooms();
  }

  // ---------- 工具 ----------
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(room, obj, except = null) {
    for (const [, m] of room.members) {
      if (m.ws && m.ws !== except) this.send(m.ws, obj);
    }
  }
  toOwner(room, obj) {
    const om = room.members.get(room.owner);
    if (om && om.ws) this.send(om.ws, obj);
  }
  toUid(room, uidVal, obj) {
    const m = room.members.get(uidVal);
    if (m && m.ws) this.send(m.ws, obj);
  }
  broadcastMembers(room) {
    const list = [];
    for (const [id, m] of room.members) list.push({ uid: id, name: m.name, avatar: m.avatar, cam: m.cam, mic: m.mic, isOwner: id === room.owner, level: m.level });
    this.broadcast(room, { t: 'members', list, pkPartner: room.pkPartner });
  }

  // ---------- 定期快照到 KV（大屏与刷新恢复用） ----------
  ensureSnapshot() {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => this.persistRooms(), 30000);
  }
  async persistRooms() {
    try {
      const list = [...this.rooms.values()].map(r => this.publicRoom(r));
      await this.env.DB.put('rooms:active', JSON.stringify(list));
      await this.env.DB.put('presence:online', String(this.sockets.size));
      await this.env.DB.put('presence:live', String(list.length));
    } catch {}
  }
}
