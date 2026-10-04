"use client";
import { nanoid } from "nanoid";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TaskPatch } from "@/contract/schemas";
import { call } from "@/client/api";
import { dispatch, ensureTasks, ingestTasks, selectTask, useStore } from "@/client/store";
import { matchesFilter } from "@/contract/filters";
import { STATUS_LABELS, blockingDependencies, canTransition } from "@/domain/rules";
import { PRIORITIES, TASK_STATUSES, type Comment, type Priority, type Task, type TaskStatus } from "@/domain/types";
import { EditableText } from "./EditableText";
import { Avatar, StatusBadge, Tag, timeAgo } from "./ui";

export function TaskPanel({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.view?.tasks[taskId]);
  const viewers = useStore(useShallow((s) => s.presence.filter((p) => p.taskId === taskId && p.name !== s.me).map((p) => p.name)));

  if (!task || task.deletedAt) {
    return (
      <aside className="flex w-full max-w-md flex-col items-center justify-center gap-3 border-l border-zinc-200 bg-white p-6 text-sm text-zinc-500">
        {task ? "This task was deleted." : "Loading task…"}
        <button className="btn" onClick={() => selectTask(null)}>
          Close
        </button>
      </aside>
    );
  }

  const update = (patch: TaskPatch) => dispatch({ type: "task.update", taskId, patch });

  return (
    <aside className="flex w-full max-w-md min-h-0 flex-col border-l border-zinc-200 bg-white" data-testid="task-panel">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          {viewers.length > 0 && (
            <span className="flex items-center gap-1">
              {viewers.map((v) => (
                <Avatar key={v} name={v} size="xs" />
              ))}
              also viewing
            </span>
          )}
        </div>
        <div className="flex gap-1">
          <button
            className="rounded px-2 py-1 text-xs text-rose-600 hover:bg-rose-50"
            onClick={() => {
              if (dispatch({ type: "task.delete", taskId })) selectTask(null);
            }}
          >
            Delete
          </button>
          <button className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-100" onClick={() => selectTask(null)} aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <EditableText value={task.title} className="w-full rounded px-1 text-lg font-semibold hover:bg-zinc-50" onCommit={(title) => title.trim() && update({ title: title.trim() })} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <select className="input w-full" value={task.status} onChange={(e) => update({ status: e.target.value as TaskStatus })} data-testid="status-select">
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s} disabled={!canTransition(task.status, s)}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select className="input w-full capitalize" value={task.configuration.priority} onChange={(e) => update({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Assignees">
          <ChipEditor
            values={task.assignedTo}
            placeholder="Add person"
            render={(v) => (
              <span className="flex items-center gap-1">
                <Avatar name={v} size="xs" /> {v}
              </span>
            )}
            onAdd={(v) => dispatch({ type: "task.assignees", taskId, add: [v], remove: [] })}
            onRemove={(v) => dispatch({ type: "task.assignees", taskId, add: [], remove: [v] })}
          />
        </Field>

        <Field label="Tags">
          <ChipEditor
            values={task.configuration.tags}
            placeholder="Add tag"
            onAdd={(v) => dispatch({ type: "task.tags", taskId, add: [v], remove: [] })}
            onRemove={(v) => dispatch({ type: "task.tags", taskId, add: [], remove: [v] })}
          />
        </Field>

        <Field label="Description">
          <EditableText multiline value={task.configuration.description} placeholder="Add a description…" onCommit={(description) => update({ description })} />
        </Field>

        <Field label="Custom fields">
          <CustomFields task={task} onChange={(customFields) => update({ customFields })} />
        </Field>

        <Field label="Depends on">
          <Dependencies task={task} />
        </Field>

        <Field label={`Comments (${task.commentCount})`}>
          <Comments taskId={taskId} />
        </Field>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      {children}
    </div>
  );
}

function ChipEditor({
  values,
  placeholder,
  onAdd,
  onRemove,
  render = (v) => v,
}: {
  values: string[];
  placeholder: string;
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  render?: (v: string) => React.ReactNode;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <Tag key={v} onRemove={() => onRemove(v)}>
          {render(v)}
        </Tag>
      ))}
      <input
        className="min-w-24 flex-1 rounded border border-transparent px-1 py-0.5 text-sm outline-none hover:border-zinc-200 focus:border-zinc-300"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onAdd(draft.trim());
            setDraft("");
          }
        }}
      />
    </div>
  );
}

function CustomFields({ task, onChange }: { task: Task; onChange: (patch: Record<string, string | number | boolean | null>) => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const entries = Object.entries(task.configuration.customFields);
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 text-sm">
          <span className="w-28 shrink-0 truncate text-zinc-500">{k}</span>
          <EditableText value={String(v)} className="input flex-1 py-1" onCommit={(nv) => onChange({ [k]: parseValue(nv) })} />
          <button className="text-zinc-400 hover:text-rose-600" onClick={() => onChange({ [k]: null })} aria-label={`Remove ${k}`}>
            ×
          </button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim()) return;
          onChange({ [key.trim()]: parseValue(value) });
          setKey("");
          setValue("");
        }}
      >
        <input className="input w-28 py-1" placeholder="Field" value={key} onChange={(e) => setKey(e.target.value)} />
        <input className="input flex-1 py-1" placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn py-1" disabled={!key.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

function parseValue(raw: string): string | number | boolean {
  if (raw === "true" || raw === "false") return raw === "true";
  if (raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

const NO_TASKS: Record<string, Task> = {};

function Dependencies({ task }: { task: Task }) {
  const tasks = useStore((s) => s.view?.tasks ?? NO_TASKS);
  const projectId = useStore((s) => s.projectId);
  const online = useStore((s) => s.online);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const blockers = blockingDependencies(task, tasks);

  useEffect(() => ensureTasks(task.dependencies), [task.dependencies]);
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Only a page of tasks is loaded locally, so search the server (cached tasks when offline).
  const { data: results } = useQuery({
    queryKey: ["task-search", projectId, q],
    enabled: !!q && online,
    queryFn: async () => {
      const page = await call("GET /api/projects/:id/tasks", { params: { id: projectId! }, query: { q, limit: 10 } });
      ingestTasks(page.tasks);
      return page.tasks.map((t) => t.id);
    },
    staleTime: 10_000,
  });

  const suggestions = useMemo(() => {
    if (!q) return [];
    const ids = online ? (results ?? []) : Object.values(tasks).filter((t) => matchesFilter(t, { q })).map((t) => t.id);
    return ids
      .map((id) => tasks[id])
      .filter((t): t is Task => !!t && !t.deletedAt && t.id !== task.id && !task.dependencies.includes(t.id))
      .slice(0, 8);
  }, [q, online, results, tasks, task]);

  return (
    <div className="space-y-2">
      {blockers.length > 0 && <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">Blocked: finish {blockers.length} dependenc{blockers.length === 1 ? "y" : "ies"} before review/done.</p>}
      <ul className="space-y-1">
        {task.dependencies.map((id) => {
          const dep = tasks[id];
          if (!dep || dep.deletedAt) return null;
          return (
            <li key={id} className="flex items-center gap-2 text-sm">
              <StatusBadge status={dep.status} />
              <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => selectTask(id)}>
                {dep.title}
              </button>
              <button className="text-zinc-400 hover:text-rose-600" onClick={() => dispatch({ type: "task.dependency.remove", taskId: task.id, dependsOn: id })} aria-label="Remove dependency">
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <div className="relative">
        <input className="input w-full py-1" placeholder="Search tasks to add a dependency" value={query} onChange={(e) => setQuery(e.target.value)} />
        {suggestions.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
            {suggestions.map((s) => (
              <li key={s.id}>
                <button
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-zinc-50"
                  onClick={() => {
                    dispatch({ type: "task.dependency.add", taskId: task.id, dependsOn: s.id });
                    setQuery("");
                  }}
                >
                  <StatusBadge status={s.status} />
                  <span className="truncate">{s.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Comments({ taskId }: { taskId: string }) {
  const thread = useStore((s) => s.view?.comments[taskId]);
  const me = useStore((s) => s.me);
  const [draft, setDraft] = useState("");

  return (
    <div className="space-y-3">
      {!thread ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : thread.length === 0 ? (
        <p className="text-sm text-zinc-400">No comments yet.</p>
      ) : (
        <ul className="space-y-3" data-testid="comments">
          {thread.map((c) => (
            <CommentItem key={c.id} comment={c} mine={c.author === me} />
          ))}
        </ul>
      )}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const content = draft.trim();
          if (content && dispatch({ type: "comment.add", comment: { id: nanoid(12), taskId, content } })) setDraft("");
        }}
      >
        <textarea
          className="input w-full"
          rows={2}
          placeholder="Write a comment… use @name to mention"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <button className="btn-primary" disabled={!draft.trim()}>
          Comment
        </button>
      </form>
    </div>
  );
}

function CommentItem({ comment, mine }: { comment: Comment; mine: boolean }) {
  return (
    <li className="flex gap-2">
      <Avatar name={comment.author} size="xs" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-medium text-zinc-800">{comment.author}</span>
          <span className="text-zinc-400">{timeAgo(comment.timestamp)}</span>
          {mine && (
            <button className="ml-auto text-zinc-400 hover:text-rose-600" onClick={() => dispatch({ type: "comment.delete", taskId: comment.taskId, commentId: comment.id })}>
              delete
            </button>
          )}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-zinc-700">
          {comment.content.split(/(@[\w.-]+)/g).map((part, i) =>
            part.startsWith("@") ? (
              <span key={i} className="rounded bg-sky-50 px-0.5 font-medium text-sky-700">
                {part}
              </span>
            ) : (
              part
            ),
          )}
        </p>
      </div>
    </li>
  );
}
