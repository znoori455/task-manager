"use client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useShowTaskUpdates, useTaskFeed } from "@/client/feeds";
import { ensureTasks, selectTask, useStore } from "@/client/store";
import { useInfiniteTrigger } from "@/client/useInfiniteTrigger";
import type { TaskFilter } from "@/contract/filters";
import { blockingDependencies } from "@/domain/rules";
import type { Task } from "@/domain/types";
import { UpdatesPill } from "./UpdatesPill";
import { Avatar, PriorityLabel, StatusBadge, Tag } from "./ui";

const ROW_HEIGHT = 44;
// Columns collapse based on the list's own width (container query), so the list stays usable when the side panel is open.
const COLS = "grid grid-cols-[minmax(0,1fr)_110px] gap-3 @2xl:grid-cols-[minmax(0,1fr)_110px_70px_90px_150px]";
const WIDE = "hidden @2xl:flex";

/**
 * Infinite-scroll feed (most recently updated first), virtualized: only the
 * ~30 visible rows are in the DOM however many pages have been loaded.
 */
export function TaskList({ filter, selectedId }: { filter: TaskFilter; selectedId: string | null }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const feed = useTaskFeed(filter);
  const showUpdates = useShowTaskUpdates();
  const virtualizer = useVirtualizer({
    count: feed.ids.length + (feed.hasNextPage ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  useInfiniteTrigger(virtualizer, feed);

  return (
    <div className="@container relative flex min-h-0 flex-1 flex-col">
      <div className={`${COLS} border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500`}>
        <span>Task</span>
        <span>Status</span>
        <span className={WIDE}>Priority</span>
        <span className={WIDE}>Assignees</span>
        <span className={WIDE}>Tags</span>
      </div>
      <UpdatesPill
        count={feed.updates}
        onShow={() => {
          parentRef.current?.scrollTo({ top: 0 });
          showUpdates();
        }}
      />
      {feed.ids.length === 0 ? (
        <p className="p-6 text-sm text-zinc-500">{feed.isLoading ? "Loading…" : "No tasks match."}</p>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto" data-testid="task-list">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const id = feed.ids[row.index];
              return (
                <div key={id ?? "loader"} style={{ position: "absolute", top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${row.start}px)` }}>
                  {id ? <TaskRow id={id} selected={id === selectedId} /> : <div className="px-4 py-3 text-xs text-zinc-400">Loading more…</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({ id, selected }: { id: string; selected: boolean }) {
  const task: Task | undefined = useStore((s) => s.view?.tasks[id]);
  // "Blocked" needs the dependencies' statuses; fetch any we haven't loaded.
  useEffect(() => {
    if (task?.dependencies.length) ensureTasks(task.dependencies);
  }, [task?.dependencies]);
  const blocked = useStore((s) => (s.view && task?.dependencies.length ? blockingDependencies(task, s.view.tasks).length > 0 : false));
  const viewers = useStore(useShallow((s) => s.presence.filter((p) => p.taskId === id && p.name !== s.me)));
  const pending = useStore((s) => s.pending.some((p) => ("taskId" in p.command && p.command.taskId === id) || (p.command.type === "task.create" && p.command.task.id === id)));
  if (!task) return null;

  return (
    <button
      onClick={() => selectTask(task.id)}
      data-testid="task-row"
      className={`${COLS} h-full w-full items-center border-b border-zinc-100 px-4 text-left text-sm hover:bg-zinc-50 ${selected ? "bg-sky-50 hover:bg-sky-50" : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={`truncate ${task.status === "done" ? "text-zinc-400 line-through" : ""} ${pending ? "opacity-60" : ""}`}>{task.title}</span>
        {blocked && <span className="shrink-0 rounded bg-rose-50 px-1.5 text-[11px] text-rose-700">blocked</span>}
        {task.commentCount > 0 && <span className="shrink-0 text-xs text-zinc-400">💬 {task.commentCount}</span>}
        {viewers.map((v) => (
          <Avatar key={v.name} name={v.name} size="xs" />
        ))}
      </span>
      <span>
        <StatusBadge status={task.status} />
      </span>
      <span className={WIDE}>
        <PriorityLabel priority={task.configuration.priority} />
      </span>
      <span className={`${WIDE} -space-x-1`}>
        {task.assignedTo.slice(0, 3).map((a) => (
          <Avatar key={a} name={a} size="xs" ring />
        ))}
        {task.assignedTo.length > 3 && <span className="pl-2 text-xs text-zinc-400">+{task.assignedTo.length - 3}</span>}
      </span>
      <span className={`${WIDE} min-w-0 gap-1 overflow-hidden`}>
        {task.configuration.tags.slice(0, 2).map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
      </span>
    </button>
  );
}
