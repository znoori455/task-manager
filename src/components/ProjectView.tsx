"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { closeProject, dispatch, openProject, redo, selectTask, undo, useStore } from "@/client/store";
import { STATUS_LABELS } from "@/domain/rules";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/domain/types";
import { nanoid } from "nanoid";
import { ActivityFeed } from "./ActivityFeed";
import { Board } from "./Board";
import { EditableText } from "./EditableText";
import { TaskList } from "./TaskList";
import { TaskPanel } from "./TaskPanel";
import { Toasts } from "./Toasts";
import { Avatar } from "./ui";

type Mode = "list" | "board";

export function ProjectView({ projectId }: { projectId: string }) {
  const phase = useStore((s) => s.phase);
  const loaded = useStore((s) => s.loaded);
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
    void openProject(projectId);
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

  const tasks = useMemo(() => {
    if (!view) return [];
    const q = search.trim().toLowerCase();
    const out: Task[] = [];
    for (const t of Object.values(view.tasks)) {
      if (t.deletedAt) continue;
      if (status !== "all" && t.status !== status) continue;
      if (onlyMine && me && !t.assignedTo.includes(me)) continue;
      if (q && !t.title.toLowerCase().includes(q) && !t.configuration.tags.some((tag) => tag.toLowerCase().includes(q))) continue;
      out.push(t);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }, [view, search, status, onlyMine, me]);

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
        <Toasts />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Header projectId={projectId} onToggleActivity={() => setShowActivity((v) => !v)} activityOpen={showActivity} />

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
          {phase === "loading" && (
            <div className="border-b border-zinc-200 bg-sky-50 px-4 py-1.5 text-xs text-sky-800">Loading tasks… {loaded.toLocaleString()} so far</div>
          )}
          {view && (mode === "list" ? <TaskList tasks={tasks} selectedId={selectedTaskId} /> : <Board tasks={tasks} />)}
        </main>
        {selectedTaskId && <TaskPanel key={selectedTaskId} taskId={selectedTaskId} />}
        {showActivity && <ActivityFeed onClose={() => setShowActivity(false)} />}
      </div>
      <Toasts />
    </div>
  );
}

function Header({ projectId, onToggleActivity, activityOpen }: { projectId: string; onToggleActivity: () => void; activityOpen: boolean }) {
  const project = useStore((s) => s.view?.project);
  const connection = useStore((s) => s.connection);
  const presence = useStore((s) => s.presence);
  const pendingCount = useStore((s) => s.pending.length);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const taskCount = useStore((s) => (s.view ? Object.values(s.view.tasks).filter((t) => !t.deletedAt).length : 0));

  const dot = connection === "live" ? "bg-emerald-500" : connection === "connecting" ? "bg-amber-400" : "bg-rose-500";

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

      <div className="flex -space-x-1.5" aria-label="People here">
        {presence.map((u) => (
          <Avatar key={u.name} name={u.name} ring />
        ))}
      </div>

      <span className="flex items-center gap-1.5 text-xs text-zinc-500" title={`Connection: ${connection}`}>
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {pendingCount > 0 ? `Saving ${pendingCount}…` : connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}
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
      </div>
    </header>
  );
}
