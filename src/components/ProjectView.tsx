"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { call } from "@/client/api";
import { joinRoom, useRealtime } from "@/client/realtime";
import { closeProject, dispatch, openProject, redo, selectTask, undo, useStore } from "@/client/store";
import type { TaskCounts } from "@/contract/api";
import type { TaskFilter } from "@/contract/filters";
import { STATUS_LABELS } from "@/domain/rules";
import { TASK_STATUSES, type TaskStatus } from "@/domain/types";
import { nanoid } from "nanoid";
import { ActivityFeed } from "./ActivityFeed";
import { Board } from "./Board";
import { EditableText } from "./EditableText";
import { TaskList } from "./TaskList";
import { TaskPanel } from "./TaskPanel";
import { preloadDescriptionEditor } from "./DescriptionField";
import { NotificationBell } from "./NotificationBell";
import { UserMenu } from "./UserMenu";
import { Avatar } from "./ui";

type Mode = "list" | "board";

export function ProjectView({ projectId }: { projectId: string }) {
  const phase = useStore((s) => s.phase);
  const view = useStore((s) => s.view);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const me = useStore((s) => s.me);
  // Rendered client-side only (behind SessionGate), so reading localStorage here is safe.
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem("taskflow:mode") === "board" ? "board" : "list";
    } catch {
      return "list";
    }
  });
  const [showActivity, setShowActivity] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TaskStatus | "all">("all");
  const [onlyMine, setOnlyMine] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  useEffect(() => {
    void openProject(projectId).then(() => {
      // Deep link from a notification: /projects/:id?task=<taskId>
      const task = new URLSearchParams(location.search).get("task");
      if (task) selectTask(task);
    });
    joinRoom({ projectId });
    if (navigator.onLine) preloadDescriptionEditor();
    return closeProject;
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === "Escape") selectTask(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Search runs on the server; wait for a typing pause before refetching.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const filter = useMemo<TaskFilter>(
    () => ({ status: status === "all" ? undefined : status, assignee: onlyMine && me ? me : undefined, q: debouncedSearch || undefined }),
    [status, onlyMine, me, debouncedSearch],
  );
  const counts = useTaskCounts(projectId, filter);

  const setModeSaved = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem("taskflow:mode", m);
    } catch {}
  };

  if (phase === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-500">
        Couldn&apos;t load this project.
        <Link className="btn" href="/">
          Back to projects
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Header projectId={projectId} total={counts?.total} onToggleActivity={() => setShowActivity((v) => !v)} activityOpen={showActivity} />

      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2">
        <form
          className="flex min-w-0 flex-1 gap-2 sm:max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            const title = newTitle.trim();
            if (!title) return;
            const id = nanoid(12);
            if (dispatch({ type: "task.create", task: { id, title, assignedTo: onlyMine && me ? [me] : [] } })) {
              setNewTitle("");
            }
          }}
        >
          <input className="input min-w-0 flex-1" placeholder="Add a task and press Enter" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          <button className="btn-primary" disabled={!newTitle.trim() || !view}>
            Add
          </button>
        </form>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <input className="input w-40" placeholder="Search title or tag" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | "all")}>
            <option value="all">All statuses</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-zinc-600">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Mine
          </label>
          <div className="flex rounded-md border border-zinc-300 bg-white p-0.5 text-sm">
            {(["list", "board"] as const).map((m) => (
              <button key={m} onClick={() => setModeSaved(m)} className={`rounded px-2.5 py-1 capitalize ${mode === m ? "bg-zinc-900 text-white" : "text-zinc-600"}`}>
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <OfflineBanner />
          {view && (mode === "list" ? <TaskList filter={filter} selectedId={selectedTaskId} /> : <Board filter={filter} counts={counts} />)}
        </main>
        {selectedTaskId && <TaskPanel key={selectedTaskId} taskId={selectedTaskId} />}
        {showActivity && <ActivityFeed onClose={() => setShowActivity(false)} />}
      </div>
    </div>
  );
}

/**
 * Live task counts for the current filter. Refetched (debounced) as events
 * arrive, since rows outside the loaded pages can change too.
 */
function useTaskCounts(projectId: string, filter: TaskFilter): TaskCounts | undefined {
  const online = useStore((s) => s.online);
  const version = useStore((s) => s.confirmed?.project.version ?? 0);
  const queryClient = useQueryClient();
  const key = ["counts", projectId, filter.assignee ?? null, filter.q ?? null];
  const { data } = useQuery({
    queryKey: key,
    enabled: online,
    queryFn: () => call("GET /api/projects/:id/tasks/counts", { params: { id: projectId }, query: { assignee: filter.assignee, q: filter.q } }),
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });
  const keyString = JSON.stringify(key);
  useEffect(() => {
    const t = setTimeout(() => void queryClient.invalidateQueries({ queryKey: JSON.parse(keyString) }), 1500);
    return () => clearTimeout(t);
  }, [version, keyString, queryClient]);
  return data;
}

function OfflineBanner() {
  const connection = useStore((s) => s.connection);
  const fromCache = useStore((s) => s.fromCache);
  const pending = useStore((s) => s.pending.length);
  if (connection !== "offline" && !fromCache) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900" data-testid="offline-banner">
      {connection === "offline" ? "You're offline. Showing the copy saved on this device" : "Showing the copy saved on this device while syncing"}
      {pending > 0 && ` · ${pending} change${pending === 1 ? "" : "s"} will sync when you're back online`}
    </div>
  );
}

function Header({
  projectId,
  total,
  onToggleActivity,
  activityOpen,
}: {
  projectId: string;
  total: number | undefined;
  onToggleActivity: () => void;
  activityOpen: boolean;
}) {
  const project = useStore((s) => s.view?.project);
  const connection = useStore((s) => s.connection);
  const peers = useRealtime((s) => s.peers);
  const people = [...new Set(peers.map((p) => p.name))];
  const pendingCount = useStore((s) => s.pending.length);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const cachedCount = useStore((s) => (s.view ? Object.values(s.view.tasks).filter((t) => !t.deletedAt).length : 0));
  const taskCount = total ?? cachedCount;

  const dot = connection === "live" ? "bg-emerald-500" : connection === "connecting" ? "bg-amber-400" : connection === "offline" ? "bg-zinc-400" : "bg-rose-500";
  const label = { live: "Live", connecting: "Connecting", reconnecting: "Reconnecting", offline: "Offline" }[connection];

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900">
        ← Projects
      </Link>
      <div className="min-w-0 flex-1">
        {project ? (
          <EditableText
            value={project.name}
            className="w-full max-w-md rounded px-1 text-lg font-semibold hover:bg-zinc-50"
            onCommit={(name) => name.trim() && dispatch({ type: "project.update", patch: { name: name.trim() } })}
          />
        ) : (
          <span className="text-lg font-semibold text-zinc-300">Loading…</span>
        )}
        <div className="px-1 text-xs text-zinc-400" data-testid="project-meta">
          {taskCount.toLocaleString()} tasks · v{project?.version ?? 0} · {projectId}
        </div>
      </div>

      <div className="flex -space-x-1.5" aria-label="People here" data-testid="presence">
        {people.map((name) => (
          <Avatar key={name} name={name} ring />
        ))}
      </div>

      <span className="flex items-center gap-1.5 text-xs text-zinc-500" title={`Connection: ${connection}`}>
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {pendingCount > 0 ? (connection === "offline" ? `${pendingCount} unsynced` : `Saving ${pendingCount}…`) : label}
      </span>

      <div className="flex gap-1">
        <button className="btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
          ↶ Undo
        </button>
        <button className="btn" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
          ↷ Redo
        </button>
        <button className={`btn ${activityOpen ? "bg-zinc-100" : ""}`} onClick={onToggleActivity}>
          Activity
        </button>
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
