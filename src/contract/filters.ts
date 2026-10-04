// Task feed filters. The server applies them in SQL; the client applies the
// same predicate to decide whether a live-updated task still belongs in a
// feed. Keep the two in sync.
import type { Task, TaskStatus } from "@/domain/types";
import { TASK_STATUSES } from "@/domain/types";

export interface TaskFilter {
  status?: TaskStatus;
  /** Tasks assigned to this user. */
  assignee?: string;
  /** Case-insensitive substring of the title, or an exact tag. */
  q?: string;
}

export function matchesFilter(task: Task, f: TaskFilter): boolean {
  if (task.deletedAt) return false;
  if (f.status && task.status !== f.status) return false;
  if (f.assignee && !task.assignedTo.includes(f.assignee)) return false;
  const q = f.q?.trim();
  if (q && !task.title.toLowerCase().includes(q.toLowerCase()) && !task.configuration.tags.includes(q)) return false;
  return true;
}

export function parseFilter(params: URLSearchParams): TaskFilter {
  const status = params.get("status");
  return {
    status: status && (TASK_STATUSES as readonly string[]).includes(status) ? (status as TaskStatus) : undefined,
    assignee: params.get("assignee") || undefined,
    q: params.get("q")?.trim().slice(0, 200) || undefined,
  };
}
