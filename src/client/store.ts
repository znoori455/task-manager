"use client";
// Client sync engine.
//
//   confirmed  = state built only from server events, applied in seq order
//   pending    = local commands not yet reflected in `confirmed`
//   view       = confirmed + pending events (what the UI renders)
//
// A local change is predicted with the shared `decide()` and shown at once
// (optimistic). It is sent to the server; when its event comes back over SSE
// it moves from pending into confirmed. If the server rejects it, it's dropped
// from pending and the view rolls back. Remote events land in confirmed and
// pending changes are re-applied on top (a simple rebase).
import { nanoid } from "nanoid";
import { create } from "zustand";
import type { PresenceUser } from "@/contract/api";
import type { Command } from "@/contract/schemas";
import { applyEvents, type ProjectState } from "@/domain/apply";
import { decide, DomainError } from "@/domain/decide";
import type { DomainEvent } from "@/domain/events";
import type { Comment } from "@/domain/types";
import { invert } from "@/domain/undo";
import { ApiError, call } from "./api";

interface Pending {
  id: string;
  command: Command;
  events: DomainEvent[];
  /** Project version returned by the server once accepted. */
  ackedVersion: number | null;
}

export interface Toast {
  id: string;
  kind: "error" | "info" | "mention";
  message: string;
}

export type Connection = "connecting" | "live" | "reconnecting";

interface StoreState {
  me: string | null;
  projectId: string | null;
  phase: "idle" | "loading" | "ready" | "error";
  loaded: number;
  confirmed: ProjectState | null;
  view: ProjectState | null;
  pending: Pending[];
  connection: Connection;
  presence: PresenceUser[];
  /** Recent events, newest first, for the activity feed. */
  activity: DomainEvent[];
  undoStack: Command[];
  redoStack: Command[];
  toasts: Toast[];
  selectedTaskId: string | null;
}

const initial: Omit<StoreState, "me"> = {
  projectId: null,
  phase: "idle",
  loaded: 0,
  confirmed: null,
  view: null,
  pending: [],
  connection: "connecting",
  presence: [],
  activity: [],
  undoStack: [],
  redoStack: [],
  toasts: [],
  selectedTaskId: null,
};

export const useStore = create<StoreState>(() => ({ me: null, ...initial }));
const get = useStore.getState;
const set = useStore.setState;

const PAGE_SIZE = 1000;
const MAX_ACTIVITY = 200;
const MAX_UNDO = 100;

// ---------- connection state (module scope: one open project at a time) ----------

let es: EventSource | null = null;
let buffering = true;
let buffered: DomainEvent[] = [];
let incoming: DomainEvent[] = [];
let flushScheduled = false;
let sending = false;
let session = 0;
let presenceTimer: ReturnType<typeof setInterval> | undefined;
let ackWatchdog: ReturnType<typeof setTimeout> | undefined;
const deletedComments = new Set<string>();

export function setMe(me: string | null) {
  set({ me });
}

export function toast(kind: Toast["kind"], message: string) {
  const id = nanoid(6);
  set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6000 : 4000);
}

function recompute() {
  const { confirmed, pending } = get();
  if (!confirmed) return set({ view: null });
  // Rebase: pending events get provisional seqs after the confirmed head.
  let seq = confirmed.project.version;
  const events = pending.flatMap((p) => p.events.map((e) => ({ ...e, seq: ++seq })));
  set({ view: applyEvents(confirmed, events) });
}

// ---------- loading & streaming ----------

export async function openProject(projectId: string) {
  closeProject();
  const my = ++session;
  set({ ...initial, projectId, phase: "loading" });
  try {
    const { project } = await call("GET /api/projects/:id", { params: { id: projectId } });
    if (my !== session) return;
    // Subscribe first (from the version we're about to load) and buffer events
    // until all pages are in; then replay them on top. Each task carries the
    // seq of its last change, so events already reflected in a page are skipped.
    buffering = true;
    buffered = [];
    connect(projectId, project.version);

    let state: ProjectState = { project, tasks: {}, comments: {} };
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof call<"GET /api/projects/:id/tasks">>> = await call("GET /api/projects/:id/tasks", {
        params: { id: projectId },
        query: { cursor, limit: PAGE_SIZE },
      });
      if (my !== session) return;
      const tasks = { ...state.tasks };
      for (const t of page.tasks) tasks[t.id] = t;
      state = { ...state, tasks };
      cursor = page.nextCursor;
      // Render progressively while the rest streams in.
      set({ confirmed: state, loaded: Object.keys(tasks).length });
      recompute();
    } while (cursor);

    buffering = false;
    set({ confirmed: applyEvents(state, buffered), phase: "ready" });
    buffered = [];
    recompute();
    startPresence();
    void loadActivity();
  } catch (e) {
    if (my !== session) return;
    set({ phase: "error" });
    toast("error", e instanceof Error ? e.message : "Failed to load project");
  }
}

export function closeProject() {
  session++;
  es?.close();
  es = null;
  if (presenceTimer) clearInterval(presenceTimer);
  if (ackWatchdog) clearTimeout(ackWatchdog);
  deletedComments.clear();
}

function connect(projectId: string, since: number) {
  es?.close();
  set({ connection: "connecting" });
  // EventSource reconnects on its own and sends Last-Event-ID, so the server
  // replays exactly what we missed.
  const source = new EventSource(`/api/projects/${projectId}/stream?since=${since}`);
  es = source;
  source.addEventListener("ready", () => set({ connection: "live" }));
  source.onerror = () => set({ connection: "reconnecting" });
  source.onmessage = (msg) => receive(JSON.parse(msg.data) as DomainEvent);
  source.addEventListener("presence", (msg) => set({ presence: JSON.parse((msg as MessageEvent).data) }));
  source.addEventListener("resync", () => {
    // We fell too far behind for an incremental replay: reload a snapshot.
    toast("info", "Resyncing project…");
    void openProject(projectId);
  });
}

/** Reconnect from the confirmed head (used when an ack'd change hasn't shown up). */
function reconnect() {
  const { projectId, confirmed } = get();
  if (projectId && confirmed && !buffering) connect(projectId, confirmed.project.version);
}

function receive(e: DomainEvent) {
  if (buffering) {
    buffered.push(e);
    return;
  }
  incoming.push(e);
  if (!flushScheduled) {
    // Batch bursts of events into one state update / render.
    flushScheduled = true;
    queueMicrotask(flushIncoming);
  }
}

function flushIncoming() {
  flushScheduled = false;
  const { confirmed, me } = get();
  if (!confirmed) return;
  const fresh = incoming.filter((e) => e.seq > confirmed.project.version);
  incoming = [];
  if (!fresh.length) return;

  for (const e of fresh) {
    if (e.type === "comment.deleted") deletedComments.add(e.payload.commentId);
    if (e.type === "comment.added" && me && e.actor !== me && mentions(e.payload.comment.content, me)) {
      toast("mention", `${e.actor} mentioned you: “${e.payload.comment.content.slice(0, 80)}”`);
    }
  }

  const next = applyEvents(confirmed, fresh);
  const mine = new Set(fresh.map((e) => e.clientMutationId));
  const version = next.project.version;
  set((s) => ({
    confirmed: next,
    pending: s.pending.filter((p) => !mine.has(p.id) && !(p.ackedVersion !== null && p.ackedVersion <= version)),
    activity: [...fresh.reverse(), ...s.activity].slice(0, MAX_ACTIVITY),
  }));
  recompute();
}

export function mentions(content: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${escaped}(?![\\w-])`, "i").test(content);
}

async function loadActivity() {
  const { projectId } = get();
  if (!projectId) return;
  const { events } = await call("GET /api/projects/:id/events", { params: { id: projectId }, query: { limit: 50 } });
  set((s) => {
    const seen = new Set(s.activity.map((e) => e.seq));
    return { activity: [...s.activity, ...events.filter((e) => !seen.has(e.seq))].sort((a, b) => b.seq - a.seq).slice(0, MAX_ACTIVITY) };
  });
}

// ---------- comments (lazy per task) ----------

export async function loadComments(taskId: string) {
  const { projectId, confirmed } = get();
  if (!projectId || !confirmed || confirmed.comments[taskId]) return;
  // Mark the thread as loaded first so comment events arriving mid-fetch are kept.
  set({ confirmed: { ...confirmed, comments: { ...confirmed.comments, [taskId]: [] } } });
  const { comments } = await call("GET /api/projects/:id/tasks/:taskId/comments", { params: { id: projectId, taskId } });
  const current = get().confirmed;
  if (!current) return;
  const byId = new Map<string, Comment>();
  for (const c of [...comments, ...(current.comments[taskId] ?? [])]) if (!deletedComments.has(c.id)) byId.set(c.id, c);
  const thread = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  set({ confirmed: { ...current, comments: { ...current.comments, [taskId]: thread } } });
  recompute();
}

// ---------- mutations ----------

/**
 * Apply a command optimistically and queue it for the server.
 * Returns false if it was rejected locally (the server would reject it too).
 */
export function dispatch(command: Command, opts: { history?: "record" | "skip" } = {}): boolean {
  const { view, me, projectId } = get();
  if (!view || !me || !projectId) return false;
  const now = new Date().toISOString();
  let bodies;
  try {
    const commentsById: Record<string, Comment> = {};
    if (command.type === "comment.delete") for (const c of view.comments[command.taskId] ?? []) commentsById[c.id] = c;
    bodies = decide({ project: view.project, tasks: view.tasks, commentsById }, command, { actor: me, now });
  } catch (e) {
    if (e instanceof DomainError) toast("error", e.message);
    else throw e;
    return false;
  }
  if (!bodies.length) return true;

  const id = nanoid();
  const events = bodies.map((b) => ({ ...b, projectId, seq: 0, actor: me, clientMutationId: id, timestamp: now }) as DomainEvent);
  const inverse = opts.history === "skip" ? null : invert(command, view);
  set((s) => ({
    pending: [...s.pending, { id, command, events, ackedVersion: null }],
    ...(inverse && { undoStack: [...s.undoStack, inverse].slice(-MAX_UNDO), redoStack: [] }),
  }));
  recompute();
  void pump();
  return true;
}

/**
 * Sends pending commands one at a time, in order. Serial sending keeps causal
 * order (create before update) without needing server-side reordering.
 */
async function pump() {
  if (sending) return;
  sending = true;
  const my = session;
  let backoff = 500;
  try {
    while (my === session) {
      const { pending, projectId } = get();
      const next = pending.find((p) => p.ackedVersion === null);
      if (!next || !projectId) break;
      try {
        const res = await call("POST /api/projects/:id/commands", {
          params: { id: projectId },
          body: { clientMutationId: next.id, command: next.command },
        });
        backoff = 500;
        if (my !== session) break;
        const confirmedVersion = get().confirmed?.project.version ?? 0;
        set((s) => ({
          pending:
            res.events.length === 0 || res.version <= confirmedVersion
              ? s.pending.filter((p) => p.id !== next.id)
              : s.pending.map((p) => (p.id === next.id ? { ...p, ackedVersion: res.version } : p)),
        }));
        recompute();
        armAckWatchdog();
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          await sleep(e.retryAfterMs || 1000);
        } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          // Rejected: roll back this change only.
          set((s) => ({ pending: s.pending.filter((p) => p.id !== next.id) }));
          recompute();
          toast("error", `Change rejected: ${e.message}`);
        } else {
          // Network/server error: keep it pending and retry (same clientMutationId => idempotent).
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    }
  } finally {
    sending = false;
  }
}

/** If an accepted change doesn't arrive over SSE soon, the stream missed it: reconnect to replay. */
function armAckWatchdog() {
  if (ackWatchdog) clearTimeout(ackWatchdog);
  ackWatchdog = setTimeout(() => {
    const { pending, confirmed } = get();
    if (confirmed && pending.some((p) => p.ackedVersion !== null && p.ackedVersion > confirmed.project.version)) reconnect();
  }, 5000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- undo / redo ----------

export function undo() {
  const { undoStack, view } = get();
  const cmd = undoStack.at(-1);
  if (!cmd || !view) return;
  const redo = invert(cmd, view);
  set({ undoStack: undoStack.slice(0, -1) });
  if (dispatch(cmd, { history: "skip" }) && redo) set((s) => ({ redoStack: [...s.redoStack, redo] }));
}

export function redo() {
  const { redoStack, view } = get();
  const cmd = redoStack.at(-1);
  if (!cmd || !view) return;
  const back = invert(cmd, view);
  set({ redoStack: redoStack.slice(0, -1) });
  if (dispatch(cmd, { history: "skip" }) && back) set((s) => ({ undoStack: [...s.undoStack, back] }));
}

// ---------- selection & presence ----------

export function selectTask(taskId: string | null) {
  set({ selectedTaskId: taskId });
  if (taskId) void loadComments(taskId).catch(() => toast("error", "Couldn't load comments"));
  void sendPresence();
}

function startPresence() {
  void sendPresence();
  presenceTimer = setInterval(sendPresence, 10_000);
}

async function sendPresence() {
  const { projectId, selectedTaskId } = get();
  if (!projectId) return;
  await call("POST /api/projects/:id/presence", { params: { id: projectId }, body: { taskId: selectedTaskId } }).catch(() => {});
}
