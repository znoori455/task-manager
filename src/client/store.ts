"use client";
// Client sync engine.
//
//   confirmed  = state built only from server data, events applied in seq order
//   pending    = local commands not yet reflected in `confirmed`
//   view       = confirmed + pending events (what the UI renders)
//
// A local change is predicted with the shared `decide()` and shown at once
// (optimistic). It is sent to the server; when its event comes back over SSE
// it moves from pending into confirmed. If the server rejects it, it's dropped
// from pending and the view rolls back. Remote events land in confirmed and
// pending changes are re-applied on top (a simple rebase).
//
// Tasks are loaded lazily (infinite-scroll feeds call ingestTasks), so
// `confirmed.tasks` holds only what this client has seen. It is persisted to
// IndexedDB together with the pending queue:
//
//   open project  -> render the cached copy immediately (works offline)
//                 -> GET /changes?since=<cached version>: current rows of just
//                    the tasks that changed (Redis sorted set; see server/changes.ts)
//                 -> live SSE stream from there
//   offline edits -> stay in `pending` (persisted) and are sent on reconnect;
//                    the server re-validates them, conflicts roll back
import { nanoid } from "nanoid";
import { create } from "zustand";
import type { PresenceUser } from "@/contract/api";
import type { Command } from "@/contract/schemas";
import { applyEvents, type ProjectState } from "@/domain/apply";
import { decide, DomainError } from "@/domain/decide";
import type { DomainEvent } from "@/domain/events";
import type { Comment, Task } from "@/domain/types";
import { invert } from "@/domain/undo";
import { ApiError, call } from "./api";
import { deleteProjectCache, loadProjectCache, saveProjectCache, type CachedPending } from "./cache";

type Pending = CachedPending;

export interface Toast {
  id: string;
  kind: "error" | "info" | "mention";
  message: string;
}

export type Connection = "connecting" | "live" | "reconnecting" | "offline";

interface StoreState {
  me: string | null;
  online: boolean;
  projectId: string | null;
  phase: "idle" | "loading" | "ready" | "error";
  /** Showing the IndexedDB copy; not yet caught up with the server. */
  fromCache: boolean;
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
  /** Tasks created/moved by me this session; shown at the top of feeds that haven't loaded them. */
  pinned: string[];
  /** Task id -> seq of the last change made by someone else (drives the "N updated" pill). */
  remoteTouched: Record<string, number>;
  /** Bumped when cached data is discarded, so feeds refetch from scratch. */
  epoch: number;
}

const initial: Omit<StoreState, "me" | "online"> = {
  projectId: null,
  phase: "idle",
  fromCache: false,
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
  pinned: [],
  remoteTouched: {},
  epoch: 0,
};

const isOnline = () => typeof navigator === "undefined" || navigator.onLine;

export const useStore = create<StoreState>(() => ({ me: null, online: isOnline(), ...initial }));
const get = useStore.getState;
const set = useStore.setState;

const MAX_ACTIVITY = 200;
const MAX_UNDO = 100;
const FETCH_BATCH = 200;

// ---------- connection state (module scope: one open project at a time) ----------

let es: EventSource | null = null;
let incoming: DomainEvent[] = [];
let flushScheduled = false;
let sending = false;
let session = 0;
let presenceTimer: ReturnType<typeof setInterval> | undefined;
let ackWatchdog: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const deletedComments = new Set<string>();
/** Mutation ids sent by this tab: their events aren't "someone else's update". */
const mine = new Set<string>();
/** Events for tasks we haven't loaded, held until the task's row arrives. */
const stash = new Map<string, DomainEvent[]>();
const fetchQueue = new Set<string>();
let fetchTimer: ReturnType<typeof setTimeout> | undefined;

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

// ---------- persistence ----------

/** Debounced write of confirmed state + pending queue to IndexedDB. */
function scheduleSave(urgent = false) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, urgent ? 150 : 1500);
}

function save() {
  saveTimer = undefined;
  const { confirmed, pending } = get();
  if (!confirmed) return;
  void saveProjectCache({ project: confirmed.project, tasks: confirmed.tasks, comments: confirmed.comments, pending });
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => saveTimer && save());
  window.addEventListener("offline", () => {
    set({ online: false, connection: "offline" });
    es?.close();
  });
  window.addEventListener("online", () => {
    set({ online: true });
    const { projectId, phase } = get();
    if (!projectId) return;
    if (phase === "error") void openProject(projectId);
    else void catchUp(session);
  });
}

// ---------- loading & streaming ----------

export async function openProject(projectId: string) {
  closeProject();
  const my = ++session;
  set({ ...initial, projectId, phase: "loading", online: isOnline() });

  const cached = await loadProjectCache(projectId);
  if (my !== session) return;
  if (cached) {
    set({
      confirmed: { project: cached.project, tasks: cached.tasks, comments: cached.comments },
      pending: cached.pending,
      phase: "ready",
      fromCache: true,
    });
    cached.pending.forEach((p) => mine.add(p.id));
    recompute();
  }

  if (!isOnline()) {
    set({ connection: "offline", ...(!cached && { phase: "error" }) });
    if (!cached) toast("error", "You're offline and this project isn't cached on this device yet.");
    return;
  }
  await catchUp(my);
}

/**
 * Bring confirmed state up to date with the server, then (re)connect the live
 * stream. With no local copy this is just "fetch metadata"; with a cached or
 * stale copy it asks for the tasks changed since the version we have.
 */
async function catchUp(my: number) {
  const { projectId } = get();
  if (!projectId) return;
  try {
    const { project } = await call("GET /api/projects/:id", { params: { id: projectId } });
    if (my !== session) return;
    const current = get().confirmed;

    if (!current) {
      set({ confirmed: { project, tasks: {}, comments: {} }, phase: "ready" });
    } else if (project.version > current.project.version) {
      const since = current.project.version;
      const changes = await call("GET /api/projects/:id/changes", { params: { id: projectId }, query: { since } });
      if (my !== session) return;
      const latest = get().confirmed!;
      if (changes.reset) {
        // Away too long for a delta: start over from the server (pending edits are kept).
        set((s) => ({ confirmed: { project: { ...project, version: changes.version }, tasks: {}, comments: {} }, epoch: s.epoch + 1 }));
        toast("info", "A lot changed while you were away — reloaded the project.");
      } else {
        const merged = mergeSnapshots(latest, changes.tasks);
        set({ confirmed: { ...merged, project: { ...merged.project, ...project, version: Math.max(changes.version, merged.project.version) } } });
        if (changes.tasks.length) toast("info", `Synced ${changes.tasks.length} task${changes.tasks.length === 1 ? "" : "s"} changed while you were away.`);
      }
    } else {
      set({ confirmed: { ...current, project: { ...project, version: current.project.version } } });
    }

    set({ phase: "ready", fromCache: false });
    recompute();
    scheduleSave();
    connect(projectId, get().confirmed!.project.version);
    startPresence();
    void loadActivity();
    void pump();
  } catch (e) {
    if (my !== session) return;
    if (e instanceof ApiError && e.status === 404) {
      void deleteProjectCache(projectId);
      set({ phase: "error", confirmed: null, view: null });
      toast("error", "This project no longer exists.");
    } else if (get().confirmed) {
      // Server unreachable but we have a local copy: keep working offline.
      set({ connection: "offline" });
      setTimeout(() => my === session && isOnline() && void catchUp(my), 5000);
    } else {
      set({ phase: "error" });
      toast("error", e instanceof Error ? e.message : "Failed to load project");
    }
  }
}

/** Replace tasks with newer snapshots, then apply any held events newer than each snapshot. */
function mergeSnapshots(state: ProjectState, snapshots: Task[]): ProjectState {
  let tasks: Record<string, Task> | null = null;
  let comments: ProjectState["comments"] | null = null;
  const held: DomainEvent[] = [];
  for (const t of snapshots) {
    const existing = state.tasks[t.id];
    if (!existing || t.version > existing.version) {
      tasks ??= { ...state.tasks };
      tasks[t.id] = t;
      if (existing && existing.commentCount !== t.commentCount && state.comments[t.id]) {
        comments ??= { ...state.comments };
        delete comments[t.id]; // stale thread; refetched when opened
      }
    }
    const evs = stash.get(t.id);
    if (evs) {
      held.push(...evs);
      stash.delete(t.id);
    }
  }
  if (!tasks && !held.length) return state;
  const next = { ...state, tasks: tasks ?? state.tasks, comments: comments ?? state.comments };
  // Held events are older than the head, so this only touches their tasks.
  return applyEvents(next, held.sort((a, b) => a.seq - b.seq));
}

/** Feed pages and lookups hand their rows here. */
export function ingestTasks(snapshots: Task[]) {
  const { confirmed } = get();
  if (!confirmed || !snapshots.length) return;
  const next = mergeSnapshots(confirmed, snapshots);
  if (next === confirmed) return;
  set({ confirmed: next });
  recompute();
  scheduleSave();
}

/** Make sure these tasks are loaded (e.g. dependencies of a visible task). Batched. */
export function ensureTasks(ids: readonly string[]) {
  const { confirmed } = get();
  if (!confirmed) return;
  let added = false;
  for (const id of ids) {
    if (confirmed.tasks[id] || fetchQueue.has(id)) continue;
    fetchQueue.add(id);
    added = true;
  }
  if (added && !fetchTimer) fetchTimer = setTimeout(flushFetches, 100);
}

async function flushFetches() {
  fetchTimer = undefined;
  const { projectId } = get();
  const my = session;
  const ids = [...fetchQueue].slice(0, FETCH_BATCH);
  ids.forEach((id) => fetchQueue.delete(id));
  if (fetchQueue.size) fetchTimer = setTimeout(flushFetches, 100);
  if (!projectId || !ids.length || !isOnline()) return;
  try {
    const { tasks } = await call("GET /api/projects/:id/tasks", { params: { id: projectId }, query: { ids: ids.join(",") } });
    if (my !== session) return;
    ingestTasks(tasks);
  } catch {
    // Not fatal: the task just stays unloaded until something asks again.
  } finally {
    for (const id of ids) if (!get().confirmed?.tasks[id]) stash.delete(id);
  }
}

export function closeProject() {
  session++;
  if (saveTimer) save();
  es?.close();
  es = null;
  if (presenceTimer) clearInterval(presenceTimer);
  if (ackWatchdog) clearTimeout(ackWatchdog);
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = undefined;
  deletedComments.clear();
  stash.clear();
  fetchQueue.clear();
}

function connect(projectId: string, since: number) {
  es?.close();
  set({ connection: "connecting" });
  // EventSource reconnects on its own and sends Last-Event-ID, so the server
  // replays exactly what we missed during short drops.
  const source = new EventSource(`/api/projects/${projectId}/stream?since=${since}`);
  es = source;
  source.addEventListener("ready", () => set({ connection: "live" }));
  source.onerror = () => set({ connection: isOnline() ? "reconnecting" : "offline" });
  source.onmessage = (msg) => receive(JSON.parse(msg.data) as DomainEvent);
  source.addEventListener("presence", (msg) => set({ presence: JSON.parse((msg as MessageEvent).data) }));
  source.addEventListener("resync", () => {
    // Too far behind to replay the log: catch up with changed rows instead.
    source.close();
    void catchUp(session);
  });
}

/** Reconnect from the confirmed head (used when an ack'd change hasn't shown up). */
function reconnect() {
  const { projectId, confirmed } = get();
  if (projectId && confirmed && isOnline()) connect(projectId, confirmed.project.version);
}

function receive(e: DomainEvent) {
  incoming.push(e);
  if (!flushScheduled) {
    // Batch bursts of events into one state update / render.
    flushScheduled = true;
    queueMicrotask(flushIncoming);
  }
}

function taskIdOf(e: DomainEvent): string | null {
  if (e.type === "task.created") return e.payload.task.id;
  if (e.type === "comment.added") return e.payload.comment.taskId;
  if ("taskId" in e.payload) return e.payload.taskId;
  return null;
}

function flushIncoming() {
  flushScheduled = false;
  const { confirmed, me } = get();
  if (!confirmed) return;
  const fresh = incoming.filter((e) => e.seq > confirmed.project.version);
  incoming = [];
  if (!fresh.length) return;

  const touched: Record<string, number> = {};
  const missing: string[] = [];
  for (const e of fresh) {
    const taskId = taskIdOf(e);
    if (taskId && e.type !== "task.created" && !confirmed.tasks[taskId]) {
      // We don't have this task yet; hold the event and fetch the row.
      stash.set(taskId, [...(stash.get(taskId) ?? []), e]);
      missing.push(taskId);
    }
    if (taskId && !(e.clientMutationId && mine.has(e.clientMutationId))) touched[taskId] = e.seq;
    if (e.type === "comment.deleted") deletedComments.add(e.payload.commentId);
    if (e.type === "comment.added" && me && e.actor !== me && mentions(e.payload.comment.content, me)) {
      toast("mention", `${e.actor} mentioned you: “${e.payload.comment.content.slice(0, 80)}”`);
    }
  }

  const next = applyEvents(confirmed, fresh);
  const acked = new Set(fresh.map((e) => e.clientMutationId));
  const version = next.project.version;
  set((s) => ({
    confirmed: next,
    pending: s.pending.filter((p) => !acked.has(p.id) && !(p.ackedVersion !== null && p.ackedVersion <= version)),
    activity: [...fresh.reverse(), ...s.activity].slice(0, MAX_ACTIVITY),
    remoteTouched: Object.keys(touched).length ? { ...s.remoteTouched, ...touched } : s.remoteTouched,
  }));
  recompute();
  scheduleSave();
  if (missing.length) ensureTasks(missing);
}

export function mentions(content: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${escaped}(?![\\w-])`, "i").test(content);
}

async function loadActivity() {
  const { projectId } = get();
  if (!projectId) return;
  const { events } = await call("GET /api/projects/:id/events", { params: { id: projectId }, query: { limit: 50 } }).catch(() => ({ events: [] }));
  set((s) => {
    const seen = new Set(s.activity.map((e) => e.seq));
    return { activity: [...s.activity, ...events.filter((e) => !seen.has(e.seq))].sort((a, b) => b.seq - a.seq).slice(0, MAX_ACTIVITY) };
  });
}

// ---------- comments (lazy per task) ----------

export async function loadComments(taskId: string) {
  const { projectId, confirmed } = get();
  if (!projectId || !confirmed || confirmed.comments[taskId] || !isOnline()) return;
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
  scheduleSave();
}

// ---------- mutations ----------

/**
 * Apply a command optimistically and queue it for the server (works offline:
 * the queue is persisted and sent on reconnect).
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
  mine.add(id);
  const events = bodies.map((b) => ({ ...b, projectId, seq: 0, actor: me, clientMutationId: id, timestamp: now }) as DomainEvent);
  const inverse = opts.history === "skip" ? null : invert(command, view);
  const pin = command.type === "task.create" ? command.task.id : command.type === "task.update" && command.patch.status ? command.taskId : null;
  set((s) => ({
    pending: [...s.pending, { id, command, events, ackedVersion: null }],
    ...(inverse && { undoStack: [...s.undoStack, inverse].slice(-MAX_UNDO), redoStack: [] }),
    ...(pin && { pinned: [pin, ...s.pinned.filter((x) => x !== pin)] }),
  }));
  recompute();
  scheduleSave(true);
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
    while (my === session && isOnline()) {
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
        scheduleSave(true);
        armAckWatchdog();
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          await sleep(e.retryAfterMs || 1000);
        } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          // Rejected (e.g. an offline edit that conflicts with what happened meanwhile): roll back this change only.
          set((s) => ({ pending: s.pending.filter((p) => p.id !== next.id) }));
          recompute();
          scheduleSave(true);
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
  if (taskId) {
    ensureTasks([taskId]);
    void loadComments(taskId).catch(() => toast("error", "Couldn't load comments"));
  }
  void sendPresence();
}

function startPresence() {
  if (presenceTimer) clearInterval(presenceTimer);
  void sendPresence();
  presenceTimer = setInterval(sendPresence, 10_000);
}

async function sendPresence() {
  const { projectId, selectedTaskId } = get();
  if (!projectId || !isOnline()) return;
  await call("POST /api/projects/:id/presence", { params: { id: projectId }, body: { taskId: selectedTaskId } }).catch(() => {});
}
