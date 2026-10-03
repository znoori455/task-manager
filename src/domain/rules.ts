// Business rules: the status workflow and the dependency graph.
import type { Task, TaskStatus } from "./types";

/** Allowed status transitions. Moving a task backwards (reopening) is allowed. */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["todo", "in_review", "done"],
  in_review: ["in_progress", "done"],
  done: ["in_progress"],
};

/** Statuses that require every dependency to be done first. */
export const GATED_STATUSES: readonly TaskStatus[] = ["in_review", "done"];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Dependencies of `task` that are live and not done. Deleted or unknown tasks don't block. */
export function blockingDependencies(task: Pick<Task, "dependencies">, tasks: Record<string, Task | undefined>): Task[] {
  const out: Task[] = [];
  for (const depId of task.dependencies) {
    const dep = tasks[depId];
    if (dep && !dep.deletedAt && dep.status !== "done") out.push(dep);
  }
  return out;
}

/** Adjacency list: task id -> ids it depends on. */
export type DependencyGraph = Record<string, readonly string[] | undefined>;

export function graphFromTasks(tasks: Record<string, Task>): DependencyGraph {
  const graph: Record<string, string[]> = {};
  for (const t of Object.values(tasks)) if (!t.deletedAt) graph[t.id] = t.dependencies;
  return graph;
}

/** True if `target` can be reached from `start` by following dependency edges. */
export function reachable(graph: DependencyGraph, start: string, target: string): boolean {
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of graph[node] ?? []) if (!seen.has(next)) stack.push(next);
  }
  return false;
}

/** Adding "taskId depends on dependsOn" creates a cycle iff taskId is reachable from dependsOn. */
export function wouldCreateCycle(graph: DependencyGraph, taskId: string, dependsOn: string): boolean {
  return taskId === dependsOn || reachable(graph, dependsOn, taskId);
}
