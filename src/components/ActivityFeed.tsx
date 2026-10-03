"use client";
import { selectTask, useStore } from "@/client/store";
import type { DomainEvent } from "@/domain/events";
import { STATUS_LABELS } from "@/domain/rules";
import type { Task } from "@/domain/types";
import { Avatar, timeAgo } from "./ui";

/** The event log, rendered for humans. It's the same stream that drives sync. */
export function ActivityFeed({ onClose }: { onClose: () => void }) {
  const activity = useStore((s) => s.activity);
  const tasks = useStore((s) => s.view?.tasks);

  return (
    <aside className="flex w-80 min-h-0 flex-col border-l border-zinc-200 bg-white" data-testid="activity">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2">
        <span className="text-sm font-medium">Activity</span>
        <button className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-100" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-zinc-100 overflow-y-auto">
        {activity.map((e) => {
          const taskId = taskOf(e);
          return (
            <li key={e.seq} className="flex gap-2 px-4 py-2.5 text-sm">
              <Avatar name={e.actor} size="xs" />
              <div className="min-w-0">
                <p className="text-zinc-700">
                  <span className="font-medium text-zinc-900">{e.actor}</span> {describe(e)}{" "}
                  {taskId && tasks?.[taskId] && (
                    <button className="font-medium text-sky-700 hover:underline" onClick={() => selectTask(taskId)}>
                      {title(tasks[taskId])}
                    </button>
                  )}
                </p>
                <p className="text-xs text-zinc-400">
                  {timeAgo(e.timestamp)} · #{e.seq}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

const title = (t: Task) => (t.title.length > 40 ? `${t.title.slice(0, 40)}…` : t.title);

function taskOf(e: DomainEvent): string | null {
  if (e.type === "task.created") return e.payload.task.id;
  if (e.type === "comment.added") return e.payload.comment.taskId;
  if ("taskId" in e.payload) return e.payload.taskId;
  return null;
}

function describe(e: DomainEvent): string {
  switch (e.type) {
    case "project.created":
      return "created the project";
    case "project.updated":
      return "updated the project";
    case "task.created":
      return "created";
    case "task.updated": {
      const p = e.payload.patch;
      if (p.status) return `moved to ${STATUS_LABELS[p.status]}:`;
      if (p.title) return "renamed";
      if (p.priority) return `set priority ${p.priority} on`;
      if (p.description !== undefined) return "edited the description of";
      return "updated";
    }
    case "task.deleted":
      return "deleted";
    case "task.restored":
      return "restored";
    case "task.assignees.changed":
      return [e.payload.add.length && `assigned ${e.payload.add.join(", ")} to`, e.payload.remove.length && `unassigned ${e.payload.remove.join(", ")} from`].filter(Boolean).join(" and ");
    case "task.tags.changed":
      return "changed tags on";
    case "task.dependency.added":
      return "added a dependency to";
    case "task.dependency.removed":
      return "removed a dependency from";
    case "comment.added":
      return "commented on";
    case "comment.deleted":
      return "deleted a comment on";
  }
}
