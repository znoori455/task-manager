"use client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { useShowTaskUpdates, useTaskFeed } from "@/client/feeds";
import { dispatch, selectTask, useStore } from "@/client/store";
import { useInfiniteTrigger } from "@/client/useInfiniteTrigger";
import type { TaskCounts } from "@/contract/api";
import type { TaskFilter } from "@/contract/filters";
import { STATUS_LABELS, canTransition } from "@/domain/rules";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/domain/types";
import { Avatar, PriorityLabel, STATUS_STYLES } from "./ui";
import { clearCursorOnLeave, cursorHandlers, RemoteCursors, selectionStyle, usePeersOnTask } from "./Collaboration";
import { UpdatesPill } from "./UpdatesPill";

const CARD_HEIGHT = 84;

/**
 * Kanban board. Each column is its own infinite-scroll feed filtered by
 * status. Dropping a card on a column is a status transition, validated by the
 * same rules as everywhere else.
 */
export function Board({ filter, counts }: { filter: TaskFilter; counts: TaskCounts | undefined }) {
  const [dragging, setDragging] = useState<Task | null>(null);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto bg-zinc-50 p-3 md:grid-cols-4">
      {TASK_STATUSES.map((status) => (
        <Column
          key={status}
          status={status}
          filter={filter}
          count={counts?.byStatus[status]}
          dragging={dragging}
          onDragStart={setDragging}
          onDrop={(task) => {
            setDragging(null);
            if (task.status !== status) dispatch({ type: "task.update", taskId: task.id, patch: { status } });
          }}
        />
      ))}
    </div>
  );
}

function Column({
  status,
  filter,
  count,
  dragging,
  onDragStart,
  onDrop,
}: {
  status: TaskStatus;
  filter: TaskFilter;
  count: number | undefined;
  dragging: Task | null;
  onDragStart: (t: Task | null) => void;
  onDrop: (t: Task) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const columnFilter = useMemo(() => ({ ...filter, status }), [filter, status]);
  const feed = useTaskFeed(columnFilter);
  const showUpdates = useShowTaskUpdates();
  const virtualizer = useVirtualizer({
    count: feed.ids.length + (feed.hasNextPage ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT,
    overscan: 5,
  });
  useInfiniteTrigger(virtualizer, feed, 5);
  const allowed = dragging ? canTransition(dragging.status, status) : true;

  return (
    <section
      data-testid={`column-${status}`}
      className={`relative flex min-h-64 flex-col rounded-lg border bg-white transition md:min-h-0 ${over ? (allowed ? "border-sky-400 ring-2 ring-sky-100" : "border-rose-300") : "border-zinc-200"} ${dragging && !allowed ? "opacity-50" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (dragging) onDrop(dragging);
      }}
    >
      <header className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>
        <span className="text-xs text-zinc-400">{(count ?? feed.ids.length).toLocaleString()}</span>
      </header>
      <div className="relative min-h-0 flex-1">
        <UpdatesPill
          count={feed.updates}
          onShow={() => {
            parentRef.current?.scrollTo({ top: 0 });
            showUpdates();
          }}
        />
        <div ref={parentRef} className="absolute inset-0 overflow-auto p-2" {...clearCursorOnLeave}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const id = feed.ids[row.index];
              return (
                <div key={id ?? "loader"} style={{ position: "absolute", top: 0, left: 0, right: 0, height: CARD_HEIGHT, transform: `translateY(${row.start}px)` }} className="pb-2">
                  {id ? <Card id={id} onDragStart={onDragStart} /> : <div className="p-2 text-xs text-zinc-400">Loading more…</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function Card({ id, onDragStart }: { id: string; onDragStart: (t: Task | null) => void }) {
  const task: Task | undefined = useStore((s) => s.view?.tasks[id]);
  const selected = useStore((s) => s.selectedTaskId === id);
  const viewers = usePeersOnTask(id);
  if (!task) return null;
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart(task);
      }}
      onDragEnd={() => onDragStart(null)}
      onClick={() => selectTask(task.id)}
      data-testid="task-card"
      {...cursorHandlers(task.id)}
      style={selectionStyle(viewers)}
      className={`relative flex h-full cursor-grab flex-col justify-between rounded-md border bg-white p-2 text-sm shadow-sm hover:border-zinc-400 active:cursor-grabbing ${selected ? "border-sky-400" : "border-zinc-200"}`}
    >
      <RemoteCursors taskId={task.id} />
      <span className="line-clamp-2">{task.title}</span>
      <span className="flex items-center justify-between">
        <PriorityLabel priority={task.configuration.priority} />
        <span className="flex items-center gap-2">
          {task.commentCount > 0 && <span className="text-xs text-zinc-400">💬 {task.commentCount}</span>}
          <span className="flex -space-x-1">
            {task.assignedTo.slice(0, 3).map((a) => (
              <Avatar key={a} name={a} size="xs" ring />
            ))}
          </span>
        </span>
      </span>
    </div>
  );
}
