// Contract for the WebSocket service (realtime/server.ts). It carries only
// ephemeral collaboration signals: presence, cursors, selection, typing — and
// forwards notifications. Nothing here is persisted or ordered; durable
// changes go through POST /commands and the SSE event stream.
import { z } from "zod";

const id = z.string().min(1).max(64);
const unit = z.number().min(0).max(1);

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
  | { type: "error"; message: string };
