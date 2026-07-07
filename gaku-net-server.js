/* =========================================================================
 * GAKU GAMES 対戦中継サーバー（依存パッケージなし・Node標準のみ）
 *
 * 役割: ルーム管理（作成/コード参加/ランダムマッチ）とメッセージ中継だけを行う。
 *       ゲームのルールは知らない（ホスト権限型：ゲーム進行はホスト端末が担当）。
 *
 * 起動:  node server/gaku-net-server.js          （ポート8787。PORT環境変数で変更可）
 * 確認:  http://localhost:8787/  → 稼働状況JSON
 *
 * プロトコル:
 *   GET  /api/events?client&gameId&name … SSEチャンネル（イベント受信用・1クライアント1本）
 *   POST /api/create {client, gameId, maxPlayers}
 *   POST /api/join   {client, code}
 *   POST /api/random {client, size}      … size人そろったら自動でルーム成立（自動では開始しない。待機ロビーに入るだけ）
 *   POST /api/random-cancel {client}
 *   POST /api/ready  {client, ready}     … 自分の準備完了⇔待機を切替（ホスト以外）
 *   POST /api/start-game {client}        … ホストが開始を宣言。ホスト以外が全員準備完了でないと拒否
 *   POST /api/send   {client, payload, to?} … ルーム内の他メンバーへ中継
 *   POST /api/leave  {client}
 *
 * ルームのライフサイクル:
 *   作成/参加/マッチ成立 → 全員が待機ロビー（まだ"started"ではない） → ホストが/api/start-gameに成功
 *   → started=true。開始前にホストが抜けたら次のメンバーへhostIdを引き継いでルーム継続、
 *   開始後にホストが抜けたら（進行役がいなくなるため）ルームを閉じる。
 *
 * SSEイベント（data: JSON）:
 *   {t:"hello"} / {t:"room", room} / {t:"match", code} / {t:"msg", from, payload} / {t:"closed", reason}
 *   room = {code, hostId, maxPlayers, isRandom, started, members:[{id, name, ready}]}
 * ========================================================================= */

const http = require("http");

const PORT = process.env.PORT || 8787;

/** @type {Map<string, {res:any, gameId:string, name:string, roomCode:string|null, queueKey:string|null, dropTimer:any}>} */
const clients = new Map();
/** @type {Map<string, {gameId:string, hostId:string, memberIds:string[], maxPlayers:number, isRandom:boolean, started:boolean, ready:Set<string>, created:number}>} */
const rooms = new Map();
/** @type {Map<string, string[]>} キー=gameId:size → 待機中クライアントID */
const queues = new Map();

// 紛らわしい文字（I/O/0/1）を除いたコード用文字
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genCode() {
  for (let tries = 0; tries < 100; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return "R" + Date.now().toString(36).toUpperCase().slice(-4);
}

function sse(clientId, obj) {
  const c = clients.get(clientId);
  if (!c || !c.res) return;
  try { c.res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {}
}

function roomInfo(code) {
  const r = rooms.get(code);
  if (!r) return null;
  return {
    code,
    hostId: r.hostId,
    maxPlayers: r.maxPlayers,
    isRandom: r.isRandom,
    started: !!r.started,
    members: r.memberIds.map((id) => ({ id, name: (clients.get(id) || {}).name || "?", ready: r.ready.has(id) })),
  };
}

function pushRoom(code) {
  const r = rooms.get(code);
  if (!r) return;
  const info = roomInfo(code);
  for (const id of r.memberIds) sse(id, { t: "room", room: info });
}

function dequeue(clientId) {
  const c = clients.get(clientId);
  if (!c || !c.queueKey) return;
  const q = queues.get(c.queueKey);
  if (q) {
    const i = q.indexOf(clientId);
    if (i >= 0) q.splice(i, 1);
  }
  c.queueKey = null;
}

/** ルームから抜ける。
 *  開始前にホストが抜けた場合は次のメンバーへhostIdを引き継いでルームを継続する
 *  （待機ロビーでの「最初の人が抜けたら次点の人に開始の決定権が移る」仕様）。
 *  開始後にホストが抜けた場合は進行役がいなくなるためルームを閉じる（従来通り）。 */
function leaveRoom(clientId, reason) {
  const c = clients.get(clientId);
  if (!c || !c.roomCode) return;
  const code = c.roomCode;
  const r = rooms.get(code);
  c.roomCode = null;
  if (!r) return;
  r.memberIds = r.memberIds.filter((id) => id !== clientId);
  r.ready.delete(clientId);
  if (r.memberIds.length === 0) {
    rooms.delete(code);
    return;
  }
  const wasHost = clientId === r.hostId;
  if (wasHost && r.started) {
    for (const id of r.memberIds) {
      const m = clients.get(id);
      if (m) m.roomCode = null;
      sse(id, { t: "closed", reason: reason || "host-left" });
    }
    rooms.delete(code);
    return;
  }
  if (wasHost) {
    r.hostId = r.memberIds[0]; // 次に古くから参加しているメンバーへ引き継ぐ
  }
  pushRoom(code);
}

/** 完全切断（SSEも閉じた） */
function dropClient(clientId) {
  dequeue(clientId);
  leaveRoom(clientId, "member-lost");
  clients.delete(clientId);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (ch) => { data += ch; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;

  // CORS プリフライト
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // ---- SSE チャンネル ----
  if (req.method === "GET" && path === "/api/events") {
    const id = url.searchParams.get("client");
    const gameId = url.searchParams.get("gameId") || "unknown";
    const name = (url.searchParams.get("name") || "プレイヤー").slice(0, 12);
    if (!id) { json(res, 400, { error: "client required" }); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    let c = clients.get(id);
    if (c) {
      // 再接続：古いストリームを差し替え、切断タイマーを解除
      try { if (c.res && c.res !== res) c.res.end(); } catch (e) {}
      if (c.dropTimer) { clearTimeout(c.dropTimer); c.dropTimer = null; }
      c.res = res;
      c.gameId = gameId;
      c.name = name;
    } else {
      c = { res, gameId, name, roomCode: null, queueKey: null, dropTimer: null };
      clients.set(id, c);
    }
    sse(id, { t: "hello", clientId: id });
    if (c.roomCode) sse(id, { t: "room", room: roomInfo(c.roomCode) }); // 再接続時は現状を再送

    req.on("close", () => {
      const cc = clients.get(id);
      if (!cc || cc.res !== res) return; // すでに新しい接続に差し替わっている
      cc.res = null;
      // ネットワーク断での自動再接続(EventSource)に8秒だけ猶予を与える
      cc.dropTimer = setTimeout(() => {
        const c3 = clients.get(id);
        if (c3 && !c3.res) dropClient(id);
      }, 8000);
    });
    return;
  }

  // ---- ステータス ----
  if (req.method === "GET" && (path === "/" || path === "/api/status")) {
    json(res, 200, {
      ok: true,
      service: "gaku-net-server",
      clients: clients.size,
      rooms: rooms.size,
      waiting: [...queues.values()].reduce((a, q) => a + q.length, 0),
    });
    return;
  }

  if (req.method !== "POST") { json(res, 404, { error: "not found" }); return; }
  const body = await readBody(req);
  const clientId = body.client;
  const c = clients.get(clientId);
  if (!c) { json(res, 400, { error: "先にサーバーへ接続してください" }); return; }

  // ---- ルーム作成 ----
  if (path === "/api/create") {
    dequeue(clientId);
    leaveRoom(clientId, "left");
    const code = genCode();
    const maxPlayers = Math.min(8, Math.max(2, +body.maxPlayers || 2));
    rooms.set(code, { gameId: c.gameId, hostId: clientId, memberIds: [clientId], maxPlayers, isRandom: false, started: false, ready: new Set(), created: Date.now() });
    c.roomCode = code;
    pushRoom(code);
    json(res, 200, { room: roomInfo(code) });
    return;
  }

  // ---- コードで参加 ----
  if (path === "/api/join") {
    const code = String(body.code || "").toUpperCase();
    const r = rooms.get(code);
    if (!r) { json(res, 404, { error: "そのコードのルームが見つかりません" }); return; }
    if (r.gameId !== c.gameId) { json(res, 400, { error: "ちがうゲームのルームです" }); return; }
    if (r.memberIds.includes(clientId)) { json(res, 200, { room: roomInfo(code) }); return; }
    if (r.memberIds.length >= r.maxPlayers) { json(res, 400, { error: "ルームが満員です" }); return; }
    dequeue(clientId);
    leaveRoom(clientId, "left");
    r.memberIds.push(clientId);
    c.roomCode = code;
    pushRoom(code);
    json(res, 200, { room: roomInfo(code) });
    return;
  }

  // ---- ランダムマッチ ----
  if (path === "/api/random") {
    dequeue(clientId);
    leaveRoom(clientId, "left");
    const size = Math.min(5, Math.max(2, +body.size || 2));
    const key = c.gameId + ":" + size;
    const q = queues.get(key) || [];
    if (!q.includes(clientId)) q.push(clientId);
    queues.set(key, q);
    c.queueKey = key;
    // 人数がそろったらルーム成立
    if (q.length >= size) {
      const ids = q.splice(0, size);
      const code = genCode();
      rooms.set(code, { gameId: c.gameId, hostId: ids[0], memberIds: ids.slice(), maxPlayers: size, isRandom: true, started: false, ready: new Set(), created: Date.now() });
      for (const id of ids) {
        const m = clients.get(id);
        if (m) { m.roomCode = code; m.queueKey = null; }
        sse(id, { t: "match", code });
      }
      pushRoom(code);
    }
    json(res, 200, { waiting: true });
    return;
  }

  if (path === "/api/random-cancel") {
    dequeue(clientId);
    json(res, 200, { ok: true });
    return;
  }

  // ---- 準備完了⇔待機の切替（ホスト以外） ----
  if (path === "/api/ready") {
    const code = c.roomCode;
    const r = code && rooms.get(code);
    if (!r) { json(res, 400, { error: "ルームに入っていません" }); return; }
    if (clientId === r.hostId) { json(res, 400, { error: "ホストは準備完了の対象ではありません" }); return; }
    if (body.ready) r.ready.add(clientId); else r.ready.delete(clientId);
    pushRoom(code);
    json(res, 200, { ok: true });
    return;
  }

  // ---- ホストがゲーム開始を宣言（ホスト以外が全員準備完了でないと拒否） ----
  if (path === "/api/start-game") {
    const code = c.roomCode;
    const r = code && rooms.get(code);
    if (!r) { json(res, 400, { error: "ルームに入っていません" }); return; }
    if (clientId !== r.hostId) { json(res, 400, { error: "ホストだけが開始できます" }); return; }
    const others = r.memberIds.filter((id) => id !== r.hostId);
    if (others.length === 0) { json(res, 400, { error: "ほかのプレイヤーがいません" }); return; }
    if (!others.every((id) => r.ready.has(id))) { json(res, 400, { error: "まだ準備できていない人がいます" }); return; }
    r.started = true;
    pushRoom(code);
    json(res, 200, { ok: true });
    return;
  }

  // ---- メッセージ中継 ----
  if (path === "/api/send") {
    const code = c.roomCode;
    const r = code && rooms.get(code);
    if (!r) { json(res, 400, { error: "ルームに入っていません" }); return; }
    const msg = { t: "msg", from: clientId, payload: body.payload };
    if (body.to) {
      if (r.memberIds.includes(body.to)) sse(body.to, msg);
    } else {
      for (const id of r.memberIds) if (id !== clientId) sse(id, msg);
    }
    json(res, 200, { ok: true });
    return;
  }

  // ---- 退出 ----
  if (path === "/api/leave") {
    dequeue(clientId);
    leaveRoom(clientId, "left");
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: "not found" });
});

// キープアライブ（途中のプロキシ・スリープ対策）
setInterval(() => {
  for (const [, c] of clients) {
    if (c.res) { try { c.res.write(":ka\n\n"); } catch (e) {} }
  }
}, 25000);

server.listen(PORT, () => {
  console.log("GAKU GAMES 対戦中継サーバー起動 → http://localhost:" + PORT);
  console.log("スマホから遊ぶときは、同じWi-FiでこのPCのIPアドレス:" + PORT + " に接続してください");
});
