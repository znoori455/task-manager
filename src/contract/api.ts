// Response shapes for every endpoint. Route handlers are typed against these
// and the client fetch wrappers return them, so a change on one side fails
// type-checking on the other.
import type { DomainEvent } from "@/domain/events";
import type { Comment, Project, Task, TaskStatus } from "@/domain/types";
import type { NotificationView } from "./realtime";
import type { CommandRequest } from "./schemas";

export interface ProjectSummary extends Project {
  taskCount: number;
}

export interface Api {
  "GET /api/session": { res: { name: string | null } };
  "POST /api/session": { body: { name: string }; res: { name: string } };
  "DELETE /api/session": { res: { ok: true } };
  "GET /api/projects": { res: { projects: ProjectSummary[]; nextCursor: string | null } };
  "GET /api/projects/changes": { res: ProjectChanges };
  "POST /api/projects": { body: { name: string; description?: string }; res: { project: Project } };
  "GET /api/projects/:id": { res: { project: Project } };
  "DELETE /api/projects/:id": { res: { ok: true } };
  "GET /api/projects/:id/tasks": { res: TaskPage };
  "GET /api/projects/:id/tasks/counts": { res: TaskCounts };
  "GET /api/projects/:id/changes": { res: TaskChanges };
  "POST /api/projects/:id/commands": { body: CommandRequest; res: { events: DomainEvent[]; version: number } };
  "GET /api/projects/:id/events": { res: { events: DomainEvent[] } };
  "GET /api/projects/:id/tasks/:taskId/comments": { res: { comments: Comment[] } };
  "GET /api/notifications": { res: { notifications: NotificationView[]; unread: number } };
  "POST /api/notifications/read": { body: { ids?: string[] }; res: { unread: number } };
  "DELETE /api/notifications": { res: { unread: number } };
  "DELETE /api/notifications/:id": { res: { unread: number } };
}

export interface TaskPage {
  tasks: Task[];
  /** Pass as `cursor` to fetch the next page; null when done. */
  nextCursor: string | null;
  /** Project version when this page was read. Changes after it count as "updated". */
  version: number;
}

export interface TaskCounts {
  total: number;
  byStatus: Record<TaskStatus, number>;
}

/** Catch-up for a client returning with a cached copy of the project. */
export interface TaskChanges {
  /** Resume the live stream from this version. */
  version: number;
  /** Current rows of every task changed since `since`, including soft-deleted ones. */
  tasks: Task[];
  /** Too much changed: drop the cache and reload. */
  reset: boolean;
  source: { index: number; fallback: number; rebuilt: boolean };
}

export interface ProjectChanges {
  /** Server time; send it back (minus a small overlap) as `since` next time. */
  now: number;
  projects: ProjectSummary[];
  deleted: string[];
  reset: boolean;
}

export type ApiResponse<K extends keyof Api> = Api[K]["res"];
