// Who gets notified about what. Pure: the server runs it inside the write
// transaction with the before/after state of the touched rows, so a
// notification exists if and only if its change committed.
import type { ProjectState } from "./apply";
import type { DomainEvent } from "./events";
import { extractMentions, userKey } from "./mentions";
import type { TaskStatus } from "./types";

export type NotificationType = "mention" | "assigned" | "comment" | "status";

export interface NotificationDraft {
  recipient: string;
  type: NotificationType;
  taskId: string;
  actor: string;
  data: { taskTitle: string; excerpt?: string; status?: TaskStatus };
}

const excerpt = (s: string) => (s.length > 140 ? `${s.slice(0, 140)}…` : s);

/**
 * - mention:  you were @mentioned in a comment
 * - assigned: you were assigned a task (on creation or later)
 * - comment:  someone commented on a task assigned to you (and didn't mention you)
 * - status:   a task assigned to you changed status
 * Nobody is notified about their own actions, and at most once per task per
 * type per command.
 */
export function notificationsFor(events: readonly DomainEvent[], before: ProjectState, after: ProjectState): NotificationDraft[] {
  const out = new Map<string, NotificationDraft>();
  const add = (recipient: string, d: Omit<NotificationDraft, "recipient">) => {
    const r = userKey(recipient);
    if (!r || r === userKey(d.actor)) return;
    const key = `${r}|${d.type}|${d.taskId}`;
    if (!out.has(key)) out.set(key, { recipient: r, ...d });
  };
  const taskAfter = (id: string) => after.tasks[id] ?? before.tasks[id];

  for (const e of events) {
    switch (e.type) {
      case "comment.added": {
        const { comment } = e.payload;
        const task = taskAfter(comment.taskId);
        if (!task) break;
        const data = { taskTitle: task.title, excerpt: excerpt(comment.content) };
        const mentioned = extractMentions(comment.content);
        for (const name of mentioned) add(name, { type: "mention", taskId: task.id, actor: e.actor, data });
        for (const name of task.assignedTo) {
          if (!mentioned.includes(userKey(name))) add(name, { type: "comment", taskId: task.id, actor: e.actor, data });
        }
        break;
      }
      case "task.created":
        for (const name of e.payload.task.assignedTo) add(name, { type: "assigned", taskId: e.payload.task.id, actor: e.actor, data: { taskTitle: e.payload.task.title } });
        break;
      case "task.assignees.changed": {
        const task = taskAfter(e.payload.taskId);
        if (!task) break;
        for (const name of e.payload.add) add(name, { type: "assigned", taskId: task.id, actor: e.actor, data: { taskTitle: task.title } });
        break;
      }
      case "task.updated": {
        const status = e.payload.patch.status;
        const task = taskAfter(e.payload.taskId);
        if (!status || !task) break;
        for (const name of task.assignedTo) add(name, { type: "status", taskId: task.id, actor: e.actor, data: { taskTitle: task.title, status } });
        break;
      }
    }
  }
  return [...out.values()];
}
