// Event reducer. Applying the same events in the same (server-assigned) order
// yields the same state on every client — that is the consistency guarantee.
import type { DomainEvent } from "./events";
import type { Comment, Project, Task } from "./types";

export interface ProjectState {
  project: Project;
  tasks: Record<string, Task>;
  /** Comment threads by task id; only present for threads that have been loaded. */
  comments: Record<string, Comment[] | undefined>;
}

const addAll = (xs: string[], add: string[], remove: string[]) => {
  const out = xs.filter((x) => !remove.includes(x));
  for (const a of add) if (!out.includes(a)) out.push(a);
  return out;
};

/**
 * Applies events to a copy of `state`. Each task records the seq of the last
 * event that touched it, so events already reflected in a task snapshot are
 * skipped — which makes applying a buffered stream on top of freshly loaded
 * pages safe.
 */
export function applyEvents(state: ProjectState, events: readonly DomainEvent[]): ProjectState {
  if (events.length === 0) return state;
  const draft: ProjectState = { project: { ...state.project }, tasks: { ...state.tasks }, comments: { ...state.comments } };
  for (const e of events) applyInPlace(draft, e);
  return draft;
}

function applyInPlace(s: ProjectState, e: DomainEvent) {
  if (e.seq > s.project.version) {
    s.project.version = e.seq;
    s.project.updatedAt = e.timestamp;
  }

  const updateTask = (taskId: string, fn: (t: Task) => Partial<Task>) => {
    const task = s.tasks[taskId];
    if (!task || task.version >= e.seq) return false;
    s.tasks[taskId] = { ...task, ...fn(task), version: e.seq, updatedAt: e.timestamp };
    return true;
  };

  switch (e.type) {
    case "project.created":
      return;
    case "project.updated":
      Object.assign(s.project, e.payload.patch);
      return;
    case "task.created": {
      const existing = s.tasks[e.payload.task.id];
      if (existing && existing.version >= e.seq) return;
      s.tasks[e.payload.task.id] = { ...e.payload.task, version: e.seq };
      return;
    }
    case "task.updated": {
      const { title, status, priority, description, customFields } = e.payload.patch;
      updateTask(e.payload.taskId, (t) => {
        const configuration = { ...t.configuration };
        if (priority !== undefined) configuration.priority = priority;
        if (description !== undefined) configuration.description = description;
        if (customFields) {
          const merged = { ...configuration.customFields };
          for (const [k, v] of Object.entries(customFields)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          configuration.customFields = merged;
        }
        return { ...(title !== undefined && { title }), ...(status !== undefined && { status }), configuration };
      });
      return;
    }
    case "task.deleted":
      updateTask(e.payload.taskId, () => ({ deletedAt: e.timestamp }));
      return;
    case "task.restored":
      updateTask(e.payload.taskId, () => ({ deletedAt: null }));
      return;
    case "task.assignees.changed":
      updateTask(e.payload.taskId, (t) => ({ assignedTo: addAll(t.assignedTo, e.payload.add, e.payload.remove) }));
      return;
    case "task.tags.changed":
      updateTask(e.payload.taskId, (t) => ({
        configuration: { ...t.configuration, tags: addAll(t.configuration.tags, e.payload.add, e.payload.remove) },
      }));
      return;
    case "task.dependency.added":
      updateTask(e.payload.taskId, (t) => ({ dependencies: addAll(t.dependencies, [e.payload.dependsOn], []) }));
      return;
    case "task.dependency.removed":
      updateTask(e.payload.taskId, (t) => ({ dependencies: t.dependencies.filter((d) => d !== e.payload.dependsOn) }));
      return;
    case "comment.added": {
      const c = e.payload.comment;
      if (!updateTask(c.taskId, (t) => ({ commentCount: t.commentCount + 1 }))) return;
      const thread = s.comments[c.taskId];
      if (thread && !thread.some((x) => x.id === c.id)) s.comments[c.taskId] = [...thread, c];
      return;
    }
    case "comment.deleted": {
      const { taskId, commentId } = e.payload;
      if (!updateTask(taskId, (t) => ({ commentCount: Math.max(0, t.commentCount - 1) }))) return;
      const thread = s.comments[taskId];
      if (thread) s.comments[taskId] = thread.filter((x) => x.id !== commentId);
      return;
    }
  }
}
