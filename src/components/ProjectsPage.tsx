"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProjectSummary } from "@/contract/api";
import { call } from "@/client/api";
import { useStore } from "@/client/store";
import { Avatar } from "./ui";

export function ProjectsPage() {
  const me = useStore((s) => s.me);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call("GET /api/projects").then((r) => setProjects(r.projects));
    // Live project list: other users' new/renamed/deleted projects appear immediately.
    const es = new EventSource("/api/projects/stream");
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      setProjects((list) => {
        if (!list) return list;
        if (msg.kind === "project.deleted") return list.filter((p) => p.id !== msg.projectId);
        const existing = list.find((p) => p.id === msg.project.id);
        if (existing) return list.map((p) => (p.id === msg.project.id ? { ...p, ...msg.project } : p));
        return [{ ...msg.project, taskCount: 0 }, ...list];
      });
    };
    return () => es.close();
  }, []);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Taskflow</h1>
          <p className="text-sm text-zinc-500">Real-time collaborative projects</p>
        </div>
        {me && (
          <div className="flex items-center gap-2 text-sm text-zinc-600">
            <Avatar name={me} /> {me}
          </div>
        )}
      </header>

      <form
        className="mb-8 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await call("POST /api/projects", { body: { name, description } });
            setName("");
            setDescription("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed");
          }
        }}
      >
        <input className="input sm:w-56" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input flex-1" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <button className="btn-primary justify-center" disabled={!name.trim()}>
          Create project
        </button>
      </form>
      {error && <p className="-mt-6 mb-6 text-sm text-rose-600">{error}</p>}

      {!projects ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-zinc-500">No projects yet. Create one above.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id} className="group relative rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400">
              <Link href={`/projects/${p.id}`} className="absolute inset-0" aria-label={p.name} />
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium">{p.name}</h2>
                <button
                  className="relative z-10 text-xs text-zinc-400 opacity-0 hover:text-rose-600 group-hover:opacity-100"
                  onClick={() => confirm(`Delete "${p.name}" and all its tasks?`) && call("DELETE /api/projects/:id", { params: { id: p.id } })}
                >
                  Delete
                </button>
              </div>
              {p.description && <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.description}</p>}
              <p className="mt-3 text-xs text-zinc-400">
                {p.taskCount.toLocaleString()} tasks · v{p.version}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
