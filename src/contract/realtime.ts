// Contract for the WebSocket service (realtime/server.ts). It carries only
// ephemeral collaboration signals: presence, cursors, selection, typing — and
// forwards notifications. Nothing here is persisted or ordered; durable
// changes go through POST /commands and the SSE event stream.
import { z } from "zod";

const id = z.string().min(1).max(64);
const unit = z.number().min(0).max(1);
const base64 = z.string().max(700_000).regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** Which part of a task someone is editing (shown as "bob is editing…"). */
export const EDITABLE_FIELDS = ["title", "description", "comment"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

// ---------- client -> server ----------

export const clientMessageSchema = z.discriminatedUnion("type", [
  /** Enter a room: a project, or the project list ("lobby"). Leaves any previous room. */
  z.object({ type: z.literal("join"), room: z.union([z.object({ projectId: id }), z.literal("lobby")]) }),
  /** Pointer position relative to a task's row/card (0..1 on each axis), or null when it leaves the tasks. */
  z.object({ type: z.literal("cursor"), cursor: z.object({ taskId: id, x: unit, y: unit }).nullable() }),
  /** Task this user has open, and the field they're editing, if any. */
  z.object({ type: z.literal("select"), taskId: id.nullable(), field: z.enum(EDITABLE_FIELDS).nullable() }),
  z.object({ type: z.literal("typing"), taskId: id, typing: z.boolean() }),
  // ---- Shared editing of a task's description (Yjs). Binary payloads are base64. ----
  /**
   * Open the shared draft of a task's description. `seed` is the saved description: if no draft
   * exists, exactly one joiner's seed becomes it (no duplicated text). `clientId` is the Yjs
   * client id, so the server can clear this user's caret if the connection drops.
   */
  z.object({ type: z.literal("doc.join"), taskId: id, seed: z.string().max(20_000), clientId: z.number().int().nonnegative() }),
  z.object({ type: z.literal("doc.leave"), taskId: id }),
  /** `generation` must match the current draft, or the server answers with a fresh doc.sync instead. */
  z.object({ type: z.literal("doc.update"), taskId: id, generation: z.string().min(1).max(32), update: base64 }),
  z.object({ type: z.literal("doc.awareness"), taskId: id, update: base64 }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------- server -> client ----------

export interface Peer {
  /** One per connection (a user with two tabs is two peers). */
  connId: string;
  name: string;
  taskId: string | null;
  field: EditableField | null;
}

export interface CursorUpdate {
  connId: string;
  name: string;
  cursor: { taskId: string; x: number; y: number } | null;
}

export interface NotificationView {
  id: string;
  type: "mention" | "assigned" | "comment" | "status";
  projectId: string;
  taskId: string | null;
  actor: string;
  /** Snapshot of what it was about, so the list renders without extra lookups. */
  data: { projectName: string; taskTitle: string; excerpt?: string; status?: string };
  createdAt: string;
  readAt: string | null;
}

/** Payloads on Redis `notify:<user>`: published by the app, forwarded by the realtime service. */
export type NotifyPayload =
  | { kind: "new"; notification: NotificationView }
  | { kind: "sync"; read?: string[] | "all"; removed?: string[] | "all" };

export type ServerMessage =
  | { type: "welcome"; connId: string; name: string }
  /** Full list of peers in the current project room (small; sent on every change). */
  | { type: "presence"; peers: Peer[] }
  /** Latest cursor of each peer that moved, batched ~15x/s. */
  | { type: "cursors"; updates: CursorUpdate[] }
  | { type: "typing"; connId: string; name: string; taskId: string; typing: boolean }
  /** Lobby: who is in which project. A patch: merge into what you have (empty list = nobody). */
  | { type: "lobby"; projects: Record<string, string[]> }
  | { type: "notification"; notification: NotificationView }
  /** Notifications read or removed elsewhere (e.g. another tab): apply the same change here. */
  | { type: "notifications.sync"; read?: string[] | "all"; removed?: string[] | "all" }
  /**
   * Current state of a shared draft (sent on join). `generation` identifies this incarnation of the
   * draft: if it differs from the one a client was editing (the draft expired and was re-seeded),
   * the client must start over from this state instead of merging, or the text would duplicate.
   */
  | { type: "doc.sync"; taskId: string; generation: string; state: string }
  | { type: "doc.update"; taskId: string; update: string }
  | { type: "doc.awareness"; taskId: string; update: string }
  /** A peer's connection dropped: remove their caret. */
  | { type: "doc.peerLeft"; taskId: string; clientId: number }
  | { type: "error"; message: string };
