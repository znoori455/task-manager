"use client";
// Connection to the realtime WebSocket service (realtime/server.ts): presence,
// cursors pinned to tasks, selection and typing — plus live notifications.
// All of it is ephemeral: if the connection drops we reconnect, rejoin the
// room and get a fresh presence snapshot. Durable data never depends on it.
import { create } from "zustand";
import type { ClientMessage, CursorUpdate, EditableField, NotificationView, Peer, ServerMessage } from "@/contract/realtime";

type Room = { projectId: string } | "lobby" | null;

interface RealtimeState {
  status: "connecting" | "live" | "reconnecting" | "offline";
  connId: string | null;
  /** Everyone in the current project room, including my other tabs (not this one: filter by connId). */
  peers: Peer[];
  /** Latest cursor per connection. */
  cursors: Record<string, CursorUpdate>;
  /** taskId -> connId -> { name, until } for "x is typing…" */
  typing: Record<string, Record<string, { name: string; until: number }>>;
  /** Lobby: projectId -> names currently in it. */
  lobby: Record<string, string[]>;
}

export const useRealtime = create<RealtimeState>(() => ({ status: "connecting", connId: null, peers: [], cursors: {}, typing: {}, lobby: {} }));
const set = useRealtime.setState;
const get = useRealtime.getState;

const CURSOR_THROTTLE_MS = 50;
const TYPING_RESEND_MS = 2000;
const TYPING_TTL_MS = 4000;

let ws: WebSocket | null = null;
let started = false;
let room: Room = null;
let selection: { taskId: string | null; field: EditableField | null } = { taskId: null, field: null };
let backoff = 500;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let notificationHandler: ((n: NotificationView) => void) | null = null;
let syncHandler: ((change: { read?: string[] | "all"; removed?: string[] | "all" }) => void) | null = null;
let reconnectHandler: (() => void) | null = null;
let everConnected = false;

// Hot reload in dev re-runs this module; without this, the previous copy's
// socket would keep reconnecting forever (one more zombie per edit).
const g = globalThis as unknown as { __taskflowRealtime?: { dispose: () => void } };
g.__taskflowRealtime?.dispose();
let disposed = false;
g.__taskflowRealtime = {
  dispose() {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  },
};

function url() {
  if (process.env.NEXT_PUBLIC_REALTIME_URL) return process.env.NEXT_PUBLIC_REALTIME_URL;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:3001/ws`;
}

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Connect once per page load (after the user has a session). */
export function startRealtime(handlers: {
  onNotification: (n: NotificationView) => void;
  onNotificationSync: (change: { read?: string[] | "all"; removed?: string[] | "all" }) => void;
  onReconnect: () => void;
}) {
  notificationHandler = handlers.onNotification;
  syncHandler = handlers.onNotificationSync;
  reconnectHandler = handlers.onReconnect;
  if (started) return;
  started = true;
  window.addEventListener("online", () => {
    backoff = 500;
    if (!ws || ws.readyState === WebSocket.CLOSED) connect();
  });
  window.addEventListener("offline", () => set({ status: "offline" }));
  setInterval(expireTyping, 1000);
  connect();
}

function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (disposed) return;
  if (!navigator.onLine) return set({ status: "offline" });
  const socket = new WebSocket(url());
  ws = socket;
  socket.onopen = () => {
    backoff = 500;
    set({ status: "live" });
    if (room) send({ type: "join", room });
    if (room && room !== "lobby" && selection.taskId) send({ type: "select", ...selection });
    // Notifications are loaded at startup; refetch only after a reconnect (we may have missed some).
    if (everConnected) reconnectHandler?.();
    everConnected = true;
  };
  socket.onmessage = (e) => receive(JSON.parse(e.data) as ServerMessage);
  socket.onclose = () => {
    if (ws !== socket || disposed) return;
    set({ status: navigator.onLine ? "reconnecting" : "offline", peers: [], cursors: {}, typing: {} });
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };
}

function receive(msg: ServerMessage) {
  switch (msg.type) {
    case "welcome":
      return set({ connId: msg.connId });
    case "presence": {
      // Drop cursors of people who left.
      const ids = new Set(msg.peers.map((p) => p.connId));
      const cursors = Object.fromEntries(Object.entries(get().cursors).filter(([id]) => ids.has(id)));
      return set({ peers: msg.peers, cursors });
    }
    case "cursors": {
      const cursors = { ...get().cursors };
      for (const u of msg.updates) {
        if (u.cursor) cursors[u.connId] = u;
        else delete cursors[u.connId];
      }
      return set({ cursors });
    }
    case "typing": {
      const typing = { ...get().typing };
      const forTask = { ...typing[msg.taskId] };
      if (msg.typing) forTask[msg.connId] = { name: msg.name, until: Date.now() + TYPING_TTL_MS };
      else delete forTask[msg.connId];
      typing[msg.taskId] = forTask;
      return set({ typing });
    }
    case "lobby":
      return set({ lobby: { ...get().lobby, ...msg.projects } });
    case "notification":
      return notificationHandler?.(msg.notification);
    case "notifications.sync":
      return syncHandler?.({ read: msg.read, removed: msg.removed });
    case "error":
      console.warn("[realtime]", msg.message);
  }
}

function expireTyping() {
  const now = Date.now();
  const { typing } = get();
  let changed = false;
  const next: RealtimeState["typing"] = {};
  for (const [taskId, byConn] of Object.entries(typing)) {
    const kept = Object.fromEntries(Object.entries(byConn).filter(([, t]) => t.until > now));
    if (Object.keys(kept).length !== Object.keys(byConn).length) changed = true;
    if (Object.keys(kept).length) next[taskId] = kept;
  }
  if (changed) set({ typing: next });
}

// ---------- outgoing ----------

export function joinRoom(next: Room) {
  room = next;
  selection = { taskId: null, field: null };
  set({ peers: [], cursors: {}, typing: {}, ...(next !== "lobby" && { lobby: {} }) });
  if (next) send({ type: "join", room: next });
}

let cursorTimer: ReturnType<typeof setTimeout> | undefined;
let pendingCursor: { taskId: string; x: number; y: number } | null | undefined;

/** Pointer position over a task (0..1 within its row/card), or null. Throttled; only the latest is sent. */
export function sendCursor(cursor: { taskId: string; x: number; y: number } | null) {
  pendingCursor = cursor;
  if (cursorTimer) return;
  const flush = () => {
    cursorTimer = undefined;
    if (pendingCursor === undefined) return;
    send({ type: "cursor", cursor: pendingCursor });
    pendingCursor = undefined;
    cursorTimer = setTimeout(flush, CURSOR_THROTTLE_MS);
  };
  flush();
}

export function sendSelect(taskId: string | null, field: EditableField | null = null) {
  if (selection.taskId === taskId && selection.field === field) return;
  selection = { taskId, field };
  send({ type: "select", taskId, field });
}

const lastTypingSent: Record<string, number> = {};

export function sendTyping(taskId: string, typing: boolean) {
  const now = Date.now();
  if (typing && now - (lastTypingSent[taskId] ?? 0) < TYPING_RESEND_MS) return;
  lastTypingSent[taskId] = typing ? now : 0;
  send({ type: "typing", taskId, typing });
}

/** Peers other than this tab. */
export const useOtherPeers = () => {
  const peers = useRealtime((s) => s.peers);
  const connId = useRealtime((s) => s.connId);
  return peers.filter((p) => p.connId !== connId);
};
