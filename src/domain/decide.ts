// Command handler: turns an intent into events, or rejects it. Pure function —
// the server feeds it rows loaded inside a transaction, the client feeds it
// its local state to predict the outcome (optimistic UI).
import type { Command } from "@/contract/schemas";
import type { EventBody } from "./events";
import { GATED_STATUSES, blockingDependencies, canTransition, graphFromTasks, wouldCreateCycle, type DependencyGraph } from "./rules";
import type { Comment, Project, Task } from "./types";

export type DomainErrorCode = "not_found" | "already_exists" | "invalid_transition" | "blocked" | "cycle" | "forbidden" | "invalid";

export class DomainError extends Error {
  constructor(
    public code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DecideContext {
  project: Project;
  /** Every task the command references, plus those tasks' dependencies. */
  tasks: Record<string, Task | undefined>;
  /** Comments referenced by the command (only needed for comment.delete). */
  comments?: Record<string, Comment | undefined>;
  /** Dependency subgraph for cycle checks; derived from `tasks` when omitted. */
  graph?: DependencyGraph;
}

export interface DecideMeta {
  actor: string;
  now: string;
}

function liveTask(ctx: DecideContext, id: string): Task {
  const task = ctx.tasks[id];
  if (!task || task.deletedAt) throw new DomainError("not_found", `Task ${id} not found`);
  return task;
}

function assertNotBlocked(ctx: DecideContext, task: Pick<Task, "dependencies" | "title">, status: Task["status"]) {
  if (!GATED_STATUSES.includes(status)) return;
  const blockers = blockingDependencies(task, ctx.tasks);
  if (blockers.length) {
    throw new DomainError("blocked", `"${task.title}" is blocked by: ${blockers.map((b) => b.title).join(", ")}`);
  }
}

function graphOf(ctx: DecideContext): DependencyGraph {
  return ctx.graph ?? graphFromTasks(ctx.tasks as Record<string, Task>);
}

const uniq = (xs: string[]) => [...new Set(xs)];

export function decide(ctx: DecideContext, cmd: Command, meta: DecideMeta): EventBody[] {
  switch (cmd.type) {
    case "project.update":
      return [{ type: "project.updated", payload: { patch: cmd.patch } }];

    case "task.create": {
      const t = cmd.task;
      if (ctx.tasks[t.id]) throw new DomainError("already_exists", `Task ${t.id} already exists`);
      const dependencies = uniq(t.dependencies ?? []);
      for (const dep of dependencies) liveTask(ctx, dep);
      const status = t.status ?? "todo";
      assertNotBlocked(ctx, { dependencies, title: t.title }, status);
      const task: Task = {
        id: t.id,
        projectId: ctx.project.id,
        title: t.title,
        status,
        assignedTo: uniq(t.assignedTo ?? []),
        configuration: {
          priority: t.configuration?.priority ?? "medium",
          description: t.configuration?.description ?? "",
          tags: uniq(t.configuration?.tags ?? []),
          customFields: t.configuration?.customFields ?? {},
        },
        dependencies,
        commentCount: 0,
        version: 0,
        createdAt: meta.now,
        updatedAt: meta.now,
        deletedAt: null,
      };
      return [{ type: "task.created", payload: { task } }];
    }

    case "task.update": {
      const task = liveTask(ctx, cmd.taskId);
      const patch = { ...cmd.patch };
      if (patch.status !== undefined) {
        if (patch.status === task.status) delete patch.status;
        else {
          if (!canTransition(task.status, patch.status)) {
            throw new DomainError("invalid_transition", `Cannot move from ${task.status} to ${patch.status}`);
          }
          assertNotBlocked(ctx, task, patch.status);
        }
      }
      if (Object.keys(patch).length === 0) return [];
      return [{ type: "task.updated", payload: { taskId: task.id, patch } }];
    }

    case "task.delete": {
      const task = ctx.tasks[cmd.taskId];
      if (!task) throw new DomainError("not_found", `Task ${cmd.taskId} not found`);
      return task.deletedAt ? [] : [{ type: "task.deleted", payload: { taskId: task.id } }];
    }

    case "task.restore": {
      const task = ctx.tasks[cmd.taskId];
      if (!task) throw new DomainError("not_found", `Task ${cmd.taskId} not found`);
      if (!task.deletedAt) return [];
      const graph = graphOf(ctx);
      if (task.dependencies.some((dep) => wouldCreateCycle(graph, task.id, dep))) {
        throw new DomainError("cycle", "Restoring this task would create a dependency cycle");
      }
      return [{ type: "task.restored", payload: { taskId: task.id } }];
    }

    case "task.assignees":
    case "task.tags": {
      const task = liveTask(ctx, cmd.taskId);
      const current = new Set(cmd.type === "task.tags" ? task.configuration.tags : task.assignedTo);
      const add = uniq(cmd.add).filter((x) => !current.has(x));
      const remove = uniq(cmd.remove).filter((x) => current.has(x) && !add.includes(x));
      if (!add.length && !remove.length) return [];
      const type = cmd.type === "task.tags" ? "task.tags.changed" : "task.assignees.changed";
      return [{ type, payload: { taskId: task.id, add, remove } }];
    }

    case "task.dependency.add": {
      const task = liveTask(ctx, cmd.taskId);
      const dep = liveTask(ctx, cmd.dependsOn);
      if (task.dependencies.includes(dep.id)) return [];
      if (wouldCreateCycle(graphOf(ctx), task.id, dep.id)) {
        throw new DomainError("cycle", `"${task.title}" can't depend on "${dep.title}": that would create a cycle`);
      }
      if (GATED_STATUSES.includes(task.status) && dep.status !== "done") {
        throw new DomainError("blocked", `"${task.title}" is already ${task.status}; reopen it before adding an unfinished dependency`);
      }
      return [{ type: "task.dependency.added", payload: { taskId: task.id, dependsOn: dep.id } }];
    }

    case "task.dependency.remove": {
      const task = liveTask(ctx, cmd.taskId);
      if (!task.dependencies.includes(cmd.dependsOn)) return [];
      return [{ type: "task.dependency.removed", payload: { taskId: task.id, dependsOn: cmd.dependsOn } }];
    }

    case "comment.add": {
      liveTask(ctx, cmd.comment.taskId);
      const comment: Comment = { ...cmd.comment, author: meta.actor, timestamp: meta.now };
      return [{ type: "comment.added", payload: { comment } }];
    }

    case "comment.delete": {
      const comment = ctx.comments?.[cmd.commentId];
      if (!comment || comment.taskId !== cmd.taskId) throw new DomainError("not_found", "Comment not found");
      if (comment.author !== meta.actor) throw new DomainError("forbidden", "You can only delete your own comments");
      return [{ type: "comment.deleted", payload: { taskId: cmd.taskId, commentId: cmd.commentId } }];
    }
  }
}
