"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { call } from "@/client/api";
import { useProjectFeed } from "@/client/feeds";
import { pinProject, startProjects, useProjects } from "@/client/projects";
import { useStore } from "@/client/store";
import { UpdatesPill } from "./UpdatesPill";
import { Avatar, timeAgo } from "./ui";

export function ProjectsPage() {
  const me = useStore((s) => s.me);
  const online = useStore((s) => s.online);
  const byId = useProjects((s) => s.byId);
  const feed = useProjectFeed();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => void startProjects(), []);

  // Infinite scroll: load the next page when the bottom of the list comes into view.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && !isFetchingNextPage && fetchNextPage(), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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

      {!online && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You&apos;re offline. Showing projects saved on this device; open one to keep working.
        </p>
      )}

      <form
        className="mb-8 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const { project } = await call("POST /api/projects", { body: { name, description } });
            pinProject(project);
            setName("");
            setDescription("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed");
          }
        }}
      >
        <input className="input sm:w-56" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input flex-1" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <button className="btn-primary justify-center" disabled={!name.trim() || !online} title={online ? undefined : "Creating projects needs a connection"}>
          Create project
        </button>
      </form>
      {error && <p className="-mt-6 mb-6 text-sm text-rose-600">{error}</p>}

      {feed.ids.length === 0 ? (
        <p className="text-sm text-zinc-500">{feed.isLoading ? "Loading…" : "No projects yet. Create one above."}</p>
      ) : (
        <div className="relative">
          <UpdatesPill
            count={feed.updates}
            onShow={() => {
              window.scrollTo({ top: 0 });
              feed.showUpdates();
            }}
          />
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="project-list">
            {feed.ids.map((id) => {
              const p = byId[id];
              return (
                <li key={id} className="group relative rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400">
                  <Link href={`/projects/${p.id}`} className="absolute inset-0" aria-label={p.name} />
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-medium">{p.name}</h2>
                    {online && (
                      <button
                        className="relative z-10 text-xs text-zinc-400 opacity-0 hover:text-rose-600 group-hover:opacity-100"
                        onClick={() => confirm(`Delete "${p.name}" and all its tasks?`) && call("DELETE /api/projects/:id", { params: { id: p.id } })}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                  {p.description && <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.description}</p>}
                  <p className="mt-3 text-xs text-zinc-400">
                    {p.taskCount.toLocaleString()} tasks · updated {timeAgo(p.updatedAt)}
                  </p>
                </li>
              );
            })}
          </ul>
          <div ref={sentinel} />
          {isFetchingNextPage && <p className="mt-4 text-center text-xs text-zinc-400">Loading more…</p>}
        </div>
      )}
    </main>
  );
}
