// Events are the facts appended to a project's log. They are the only thing
// sent to clients after the initial load — each is a small delta, never a
// whole project.
import type { Comment, CustomFieldValue, Priority, Project, Task, TaskStatus } from "./types";

export type EventBody =
  | { type: "project.created"; payload: { project: Omit<Project, "version"> } }
  | { type: "project.updated"; payload: { patch: Partial<Pick<Project, "name" | "description" | "metadata">> } }
  | { type: "task.created"; payload: { task: Task } }
  | {
      type: "task.updated";
      payload: {
        taskId: string;
        patch: {
          title?: string;
          status?: TaskStatus;
          priority?: Priority;
          description?: string;
          customFields?: Record<string, CustomFieldValue | null>;
        };
      };
    }
  | { type: "task.deleted"; payload: { taskId: string } }
  | { type: "task.restored"; payload: { taskId: string } }
  | { type: "task.assignees.changed"; payload: { taskId: string; add: string[]; remove: string[] } }
  | { type: "task.tags.changed"; payload: { taskId: string; add: string[]; remove: string[] } }
  | { type: "task.dependency.added"; payload: { taskId: string; dependsOn: string } }
  | { type: "task.dependency.removed"; payload: { taskId: string; dependsOn: string } }
  | { type: "comment.added"; payload: { comment: Comment } }
  | { type: "comment.deleted"; payload: { taskId: string; commentId: string } };

export type EventType = EventBody["type"];

export type DomainEvent = EventBody & {
  projectId: string;
  /** Position in the project's log; strictly increasing, gap-free. */
  seq: number;
  actor: string;
  clientMutationId: string | null;
  timestamp: string;
};
