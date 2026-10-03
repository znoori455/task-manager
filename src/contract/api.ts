// Response shapes for every endpoint. Route handlers are typed against these
// and the client fetch wrappers return them, so a change on one side fails
// type-checking on the other.
import type { DomainEvent } from "@/domain/events";
import type { Comment, Project, Task } from "@/domain/types";
import type { CommandRequest } from "./schemas";

export interface ProjectSummary extends Project {
  taskCount: number;
}

export interface Api {
  "GET /api/session": { res: { name: string | null } };
  "POST /api/session": { body: { name: string }; res: { name: string } };
  "GET /api/projects": { res: { projects: ProjectSummary[] } };
  "POST /api/projects": { body: { name: string; description?: string }; res: { project: Project } };
  "GET /api/projects/:id": { res: { project: Project } };
  "DELETE /api/projects/:id": { res: { ok: true } };
  "GET /api/projects/:id/tasks": { res: TaskPage };
  "POST /api/projects/:id/commands": { body: CommandRequest; res: { events: DomainEvent[]; version: number } };
  "GET /api/projects/:id/events": { res: { events: DomainEvent[] } };
  "GET /api/projects/:id/tasks/:taskId/comments": { res: { comments: Comment[] } };
  "POST /api/projects/:id/presence": { body: { taskId: string | null }; res: { ok: true } };
}

export interface TaskPage {
  tasks: Task[];
  /** Pass as `cursor` to fetch the next page; null when done. */
  nextCursor: string | null;
  /** Project version when this page was read. */
  version: number;
}

export type ApiResponse<K extends keyof Api> = Api[K]["res"];

export interface PresenceUser {
  name: string;
  /** Task the user has open, if any. */
  taskId: string | null;
  ts: number;
}
