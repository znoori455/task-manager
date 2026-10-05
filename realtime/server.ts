// Realtime collaboration service (WebSocket). Runs next to the Next.js app.
//
// It carries only ephemeral signals — presence, cursors, selection, typing —
// and forwards notifications. It never touches Postgres and holds no state
// that matters: everything shared lives in Redis, so any number of instances
// can run behind a load balancer without sticky sessions.
//
//   rooms        one per project (+ "lobby" for the project list)
//   presence     Redis hash rt:presence:<project> (connId -> peer), published
//                to every instance on each change; tied to the connection, so
//                joins/leaves show instantly. Heartbeats expire crashed instances.
//   cursors      latest-wins: each instance keeps only the newest position per
//                connection and flushes a batch every ~66 ms
//   backpressure cursor frames are skipped for clients with a backlog; clients
//                far behind are disconnected (they reconnect and get a snapshot)
import { createServer, type IncomingMessage } from "node:http";
import Redis from "ioredis";
import { nanoid } from "nanoid";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { userKey } from "../src/domain/mentions";
import { createDocRooms, DOC_CHANNEL_PREFIX } from "./docs";
import { clientMessageSchema, type CursorUpdate, type NotificationView, type NotifyPayload, type EditableField, type Peer, type ServerMessage } from "../src/contract/realtime";

const SESSION_COOKIE = "tf_user";
const CURSOR_FLUSH_MS = 66;
const HEARTBEAT_MS = 10_000;
const PRESENCE_TTL_MS = 30_000;
const PING_MS = 25_000;
/** Skip droppable (cursor) frames above this backlog; disconnect above the hard limit. */
const SOFT_BACKLOG = 256 * 1024;
const HARD_BACKLOG = 4 * 1024 * 1024;
/** Per-connection token bucket. */
const RATE = { capacity: 120, perSecond: 60 };

interface Conn {
  id: string;
  name: string;
  ws: WebSocket;
  room: { projectId: string } | "lobby" | null;
  taskId: string | null;
  field: EditableField | null;
  tokens: number;
  tokensAt: number;
  alive: boolean;
  /** Shared description drafts this connection has open: taskId -> Yjs client id. */
  docs: Map<string, number>;
}

type ProjectMessage =
  | { kind: "presence"; peers: Peer[] }
  | { kind: "cursors"; updates: CursorUpdate[] }
  | { kind: "typing"; connId: string; name: string; taskId: string; typing: boolean };

interface StoredPeer {
  name: string;
  taskId: string | null;
  field: EditableField | null;
  ts: number;
}

export interface RealtimeOptions {
  port: number;
  redisUrl: string;
  /**
   * Allowed Origin headers. The session is a cookie, so this is what blocks
   * cross-site pages from connecting as the user. "localhost" (the default when
   * ALLOWED_ORIGINS is unset) accepts any http://localhost:* or 127.0.0.1:* origin.
   */
  allowedOrigins: string[] | "localhost";
  /** How long a shared description draft survives after its last participant leaves. */
  docTtlSeconds?: number;
}

const keys = {
  presence: (projectId: string) => `rt:presence:${projectId}`,
  active: "rt:active",
  projectChannel: (projectId: string) => `rt:project:${projectId}`,
  lobbyChannel: "rt:lobby",
  notifyChannel: (user: string) => `notify:${user}`,
};

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("=")) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function originAllowed(origin: string | undefined, allowed: RealtimeOptions["allowedOrigins"]): boolean {
  if (!origin) return true; // non-browser clients don't send one; they still need the cookie
  if (allowed === "localhost") {
    try {
      return ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  return allowed.includes(origin);
}

export async function startRealtimeServer(opts: RealtimeOptions) {
  const redis = new Redis(opts.redisUrl, { maxRetriesPerRequest: 2 });
  const sub = new Redis(opts.redisUrl);
  for (const c of [redis, sub]) c.on("error", (e: Error) => console.error("[realtime][redis]", e.message));

  const conns = new Map<string, Conn>();
  /** Set by close(): stop issuing Redis commands from socket events, so nothing races the disconnect. */
  let closing = false;
  const logRedisError = (e: Error) => !closing && console.error("[realtime][redis]", e.message);
  /** Local subscriptions, ref-counted: channel -> number of local connections needing it. */
  const subscriptions = new Map<string, number>();
  /** Newest cursor per connection, per project, waiting for the next flush. */
  const pendingCursors = new Map<string, Map<string, CursorUpdate>>();

  const retain = (channel: string) => {
    const n = subscriptions.get(channel) ?? 0;
    subscriptions.set(channel, n + 1);
    if (n === 0) sub.subscribe(channel).catch(logRedisError);
  };
  const release = (channel: string) => {
    const n = (subscriptions.get(channel) ?? 0) - 1;
    if (n > 0) subscriptions.set(channel, n);
    else {
      subscriptions.delete(channel);
      if (!closing) sub.unsubscribe(channel).catch(logRedisError);
    }
  };

  function send(conn: Conn, msg: ServerMessage, droppable = false) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    if (conn.ws.bufferedAmount > HARD_BACKLOG) {
      conn.ws.terminate();
      return;
    }
    if (droppable && conn.ws.bufferedAmount > SOFT_BACKLOG) return;
    conn.ws.send(JSON.stringify(msg));
  }

  const inProject = (projectId: string) => [...conns.values()].filter((c) => typeof c.room === "object" && c.room?.projectId === projectId);

  // ---------- fan-out from Redis to local connections ----------

  const docs = createDocRooms({
    redis,
    retain,
    release,
    send: (connId, msg, droppable) => {
      const conn = conns.get(connId);
      if (conn) send(conn, msg, droppable);
    },
    ttlSeconds: opts.docTtlSeconds ?? 60,
    isClosing: () => closing,
  });

  sub.on("message", (channel: string, raw: string) => {
    if (channel.startsWith(DOC_CHANNEL_PREFIX)) {
      docs.onChannelMessage(channel, raw);
    } else if (channel.startsWith("rt:project:")) {
      const projectId = channel.slice("rt:project:".length);
      const msg = JSON.parse(raw) as ProjectMessage;
      for (const conn of inProject(projectId)) {
        if (msg.kind === "presence") send(conn, { type: "presence", peers: msg.peers });
        else if (msg.kind === "cursors") {
          const updates = msg.updates.filter((u) => u.connId !== conn.id);
          if (updates.length) send(conn, { type: "cursors", updates }, true);
        } else if (msg.connId !== conn.id) send(conn, { type: "typing", connId: msg.connId, name: msg.name, taskId: msg.taskId, typing: msg.typing });
      }
    } else if (channel === keys.lobbyChannel) {
      const projects = JSON.parse(raw) as Record<string, string[]>;
      for (const conn of conns.values()) if (conn.room === "lobby") send(conn, { type: "lobby", projects });
    } else if (channel.startsWith("notify:")) {
      const user = channel.slice("notify:".length);
      const parsed = JSON.parse(raw) as NotifyPayload | NotificationView;
      // Older app versions published a bare NotificationView; accept both so a rolling deploy doesn't drop notifications.
      const payload: NotifyPayload = "kind" in parsed ? parsed : { kind: "new", notification: parsed };
      const msg: ServerMessage =
        payload.kind === "new" ? { type: "notification", notification: payload.notification } : { type: "notifications.sync", read: payload.read, removed: payload.removed };
      for (const conn of conns.values()) if (userKey(conn.name) === user) send(conn, msg);
    }
  });

  // ---------- presence ----------

  /** Read a project's peers from Redis, dropping entries whose instance stopped heartbeating. */
  async function readPeers(projectId: string): Promise<Peer[]> {
    const all = await redis.hgetall(keys.presence(projectId));
    const now = Date.now();
    const peers: Peer[] = [];
    const stale: string[] = [];
    for (const [connId, json] of Object.entries(all)) {
      const p = JSON.parse(json) as StoredPeer;
      if (now - p.ts > PRESENCE_TTL_MS) stale.push(connId);
      else peers.push({ connId, name: p.name, taskId: p.taskId, field: p.field });
    }
    if (stale.length) await redis.hdel(keys.presence(projectId), ...stale);
    return peers.sort((a, b) => a.name.localeCompare(b.name) || a.connId.localeCompare(b.connId));
  }

  async function publishPresence(projectId: string) {
    const peers = await readPeers(projectId);
    const names = [...new Set(peers.map((p) => p.name))];
    await redis
      .multi()
      .publish(keys.projectChannel(projectId), JSON.stringify({ kind: "presence", peers } satisfies ProjectMessage))
      .publish(keys.lobbyChannel, JSON.stringify({ [projectId]: names }))
      [names.length ? "sadd" : "srem"](keys.active, projectId)
      .exec();
  }

  const storePeer = (conn: Conn, projectId: string) =>
    redis.hset(keys.presence(projectId), conn.id, JSON.stringify({ name: conn.name, taskId: conn.taskId, field: conn.field, ts: Date.now() } satisfies StoredPeer));

  async function leaveRoom(conn: Conn) {
    const room = conn.room;
    conn.room = null;
    if (room === "lobby") release(keys.lobbyChannel);
    else if (room) {
      release(keys.projectChannel(room.projectId));
      pendingCursors.get(room.projectId)?.delete(conn.id);
      await redis.hdel(keys.presence(room.projectId), conn.id);
      await publishPresence(room.projectId);
    }
  }

  async function joinRoom(conn: Conn, room: Conn["room"]) {
    await leaveRoom(conn);
    conn.room = room;
    conn.taskId = null;
    conn.field = null;
    if (room === "lobby") {
      retain(keys.lobbyChannel);
      const active = await redis.smembers(keys.active);
      const projects: Record<string, string[]> = {};
      for (const projectId of active) projects[projectId] = [...new Set((await readPeers(projectId)).map((p) => p.name))];
      send(conn, { type: "lobby", projects });
    } else if (room) {
      retain(keys.projectChannel(room.projectId));
      await storePeer(conn, room.projectId);
      await publishPresence(room.projectId);
    }
  }

  // ---------- cursors ----------

  const flushTimer = setInterval(() => {
    for (const [projectId, byConn] of pendingCursors) {
      if (!byConn.size) continue;
      const updates = [...byConn.values()];
      byConn.clear();
      redis.publish(keys.projectChannel(projectId), JSON.stringify({ kind: "cursors", updates } satisfies ProjectMessage)).catch(logRedisError);
    }
  }, CURSOR_FLUSH_MS);

  // Refresh this instance's presence entries, and expire peers of crashed instances.
  const heartbeatTimer = setInterval(async () => {
    await docs.heartbeat().catch(logRedisError);
    const projects = new Set<string>();
    for (const conn of conns.values()) {
      if (typeof conn.room === "object" && conn.room) {
        projects.add(conn.room.projectId);
        await storePeer(conn, conn.room.projectId).catch(() => {});
      }
    }
    for (const projectId of projects) {
      const before = await redis.hlen(keys.presence(projectId)).catch(() => 0);
      const peers = await readPeers(projectId).catch(() => null);
      if (peers && peers.length !== before) await publishPresence(projectId).catch(() => {});
    }
  }, HEARTBEAT_MS);

  // ---------- connections ----------

  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  // Large enough for a shared draft's initial state; everything else is tiny.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  http.on("upgrade", (req, socket, head) => {
    const reject = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return reject(404, "Not Found");
    if (!originAllowed(req.headers.origin, opts.allowedOrigins)) return reject(403, "Forbidden");
    const name = readCookie(req, SESSION_COOKIE);
    if (!name) return reject(401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, name));
  });

  function onConnection(ws: WebSocket, name: string) {
    const conn: Conn = { id: nanoid(10), name, ws, room: null, taskId: null, field: null, tokens: RATE.capacity, tokensAt: Date.now(), alive: true, docs: new Map() };
    conns.set(conn.id, conn);
    retain(keys.notifyChannel(userKey(name)));
    send(conn, { type: "welcome", connId: conn.id, name });

    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data: RawData) => void onMessage(conn, data).catch((e) => console.error("[realtime]", e)));
    ws.on("close", () => {
      conns.delete(conn.id);
      // During shutdown, close() cleans up presence itself (before disconnecting Redis).
      if (closing) return;
      release(keys.notifyChannel(userKey(name)));
      void leaveRoom(conn).catch(() => {});
      for (const taskId of [...conn.docs.keys()]) void docs.leave(conn, taskId).catch(logRedisError);
    });
  }

  function allow(conn: Conn): boolean {
    const now = Date.now();
    conn.tokens = Math.min(RATE.capacity, conn.tokens + ((now - conn.tokensAt) / 1000) * RATE.perSecond);
    conn.tokensAt = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  async function onMessage(conn: Conn, data: RawData) {
    if (!allow(conn)) {
      send(conn, { type: "error", message: "Rate limit exceeded" });
      conn.ws.close(1008, "rate limit");
      return;
    }
    let parsed;
    try {
      parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      send(conn, { type: "error", message: "Invalid message" });
      return;
    }
    const msg = parsed.data;
    const projectId = typeof conn.room === "object" && conn.room ? conn.room.projectId : null;

    switch (msg.type) {
      case "join":
        await joinRoom(conn, msg.room);
        return;
      case "cursor": {
        if (!projectId) return;
        let byConn = pendingCursors.get(projectId);
        if (!byConn) pendingCursors.set(projectId, (byConn = new Map()));
        byConn.set(conn.id, { connId: conn.id, name: conn.name, cursor: msg.cursor });
        return;
      }
      case "select":
        if (!projectId) return;
        conn.taskId = msg.taskId;
        conn.field = msg.taskId ? msg.field : null;
        await storePeer(conn, projectId);
        await publishPresence(projectId);
        return;
      case "typing":
        if (!projectId) return;
        await redis.publish(
          keys.projectChannel(projectId),
          JSON.stringify({ kind: "typing", connId: conn.id, name: conn.name, taskId: msg.taskId, typing: msg.typing } satisfies ProjectMessage),
        );
        return;
      case "doc.join":
        await docs.join(conn, msg.taskId, msg.seed, msg.clientId);
        return;
      case "doc.update":
        await docs.update(conn, msg.taskId, msg.generation, msg.update);
        return;
      case "doc.awareness":
        await docs.awareness(conn, msg.taskId, msg.update);
        return;
      case "doc.leave":
        await docs.leave(conn, msg.taskId);
        return;
    }
  }

  // Detect dead connections (closed laptops, dropped networks).
  const pingTimer = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, PING_MS);

  await new Promise<void>((resolve) => http.listen(opts.port, resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    async close() {
      closing = true;
      clearInterval(flushTimer);
      clearInterval(heartbeatTimer);
      clearInterval(pingTimer);
      for (const conn of conns.values()) conn.ws.close(1001, "shutting down");
      await Promise.all([...conns.values()].map((c) => leaveRoom(c).catch(() => {})));
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      redis.disconnect();
      sub.disconnect();
    },
  };
}
