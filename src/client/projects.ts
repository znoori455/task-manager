"use client";
// Project list state: rows from the infinite-scroll feed, live lobby events,
// and an IndexedDB copy. On start the cached list renders immediately, then
// GET /api/projects/changes?since=<last sync> returns just the projects
// updated or deleted since (Redis sorted sets on the server).
import { create } from "zustand";
import type { ProjectSummary } from "@/contract/api";
import type { Project } from "@/domain/types";
import { call } from "./api";
import { loadProjectsCache, saveProjectsCache } from "./cache";

interface ProjectsState {
  byId: Record<string, ProjectSummary>;
  lastSync: number | null;
}

export const useProjects = create<ProjectsState>(() => ({ byId: {}, lastSync: null }));
const get = useProjects.getState;
const set = useProjects.setState;

/** Overlap when resuming from a server timestamp, to absorb clock skew between app servers. */
const SKEW_MS = 5000;

let started = false;
let lobby: EventSource | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { byId, lastSync } = get();
    void saveProjectsCache({ projects: byId, lastSync });
  }, 500);
}

function upsert(list: (Project & Partial<Pick<ProjectSummary, "taskCount">>)[]) {
  if (!list.length) return;
  set((s) => {
    const byId = { ...s.byId };
    for (const p of list) {
      const prev = byId[p.id];
      if (prev && Date.parse(prev.updatedAt) > Date.parse(p.updatedAt)) continue;
      byId[p.id] = { ...p, taskCount: p.taskCount ?? prev?.taskCount ?? 0 };
    }
    return { byId };
  });
  scheduleSave();
}

function remove(ids: string[]) {
  if (!ids.length) return;
  set((s) => {
    const byId = { ...s.byId };
    for (const id of ids) delete byId[id];
    return { byId };
  });
  scheduleSave();
}

export const ingestProjects = (list: ProjectSummary[]) => upsert(list);

/** Show a project I just created right away (the lobby event may arrive later). */
export const addCreatedProject = (p: Project) => upsert([{ ...p, taskCount: 0 }]);

/** Start once per page load: cached list, catch-up, then live lobby events. */
export async function startProjects() {
  if (started) return;
  started = true;
  const cached = await loadProjectsCache();
  if (cached) set({ byId: cached.projects, lastSync: cached.lastSync });
  window.addEventListener("online", () => void syncProjects());
  await syncProjects();
}

async function syncProjects() {
  if (!navigator.onLine) return;
  const since = get().lastSync;
  try {
    const res = await call("GET /api/projects/changes", { query: { since: since ? since - SKEW_MS : Date.now() } });
    if (res.reset) set({ byId: {} });
    else {
      upsert(res.projects);
      remove(res.deleted);
    }
    set({ lastSync: res.now });
    scheduleSave();
  } catch {
    // Offline or server down: keep showing the cached list.
  }
  connectLobby();
}

function connectLobby() {
  lobby?.close();
  lobby = new EventSource("/api/projects/stream");
  lobby.onmessage = (m) => {
    const msg = JSON.parse(m.data) as { kind: "project.upserted"; project: Project } | { kind: "project.deleted"; projectId: string };
    if (msg.kind === "project.deleted") remove([msg.projectId]);
    else upsert([msg.project]);
  };
}
