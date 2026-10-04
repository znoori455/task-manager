"use client";
// Offline cache in IndexedDB (via idb-keyval). localStorage would cap us at
// ~5 MB and block the main thread; one 10k-task project is ~7 MB of JSON.
//
// Every access is wrapped: private windows, blocked storage or quota errors
// just mean "no cache", never a broken page.
import { del, get, set } from "idb-keyval";
import type { ProjectSummary } from "@/contract/api";
import type { Command } from "@/contract/schemas";
import type { DomainEvent } from "@/domain/events";
import type { Comment, Project, Task } from "@/domain/types";

const VERSION = 1;

export interface CachedPending {
  id: string;
  command: Command;
  events: DomainEvent[];
  ackedVersion: number | null;
}

export interface ProjectCache {
  v: typeof VERSION;
  /** project.version is the last seq this cache reflects — the catch-up cursor. */
  project: Project;
  tasks: Record<string, Task>;
  comments: Record<string, Comment[] | undefined>;
  /** Edits made offline (or not yet acknowledged), replayed on reconnect. */
  pending: CachedPending[];
  savedAt: number;
}

export interface ProjectsCache {
  v: typeof VERSION;
  projects: Record<string, ProjectSummary>;
  /** Server time of the last successful sync — the catch-up cursor. */
  lastSync: number | null;
}

const projectKey = (id: string) => `taskflow:project:${id}`;
const PROJECTS_KEY = "taskflow:projects";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.warn("[cache]", (e as Error).message);
    return fallback;
  }
}

export const loadProjectCache = (id: string) =>
  safe(async () => {
    const c = await get<ProjectCache>(projectKey(id));
    return c?.v === VERSION ? c : null;
  }, null);

export const saveProjectCache = (c: Omit<ProjectCache, "v" | "savedAt">) =>
  safe(() => set(projectKey(c.project.id), { ...c, v: VERSION, savedAt: Date.now() }), undefined);

export const deleteProjectCache = (id: string) => safe(() => del(projectKey(id)), undefined);

export const loadProjectsCache = () =>
  safe(async () => {
    const c = await get<ProjectsCache>(PROJECTS_KEY);
    return c?.v === VERSION ? c : null;
  }, null);

export const saveProjectsCache = (c: Omit<ProjectsCache, "v">) => safe(() => set(PROJECTS_KEY, { ...c, v: VERSION }), undefined);

/** The display name, so the app can start while the server is unreachable. */
export function rememberName(name: string | null) {
  try {
    if (name) localStorage.setItem("taskflow:me", name);
  } catch {}
}

export function rememberedName(): string | null {
  try {
    return localStorage.getItem("taskflow:me");
  } catch {
    return null;
  }
}
