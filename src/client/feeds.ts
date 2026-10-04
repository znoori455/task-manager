"use client";
// Infinite-scroll feeds (TanStack Query), sorted by last updated.
//
// Order is frozen while you look: rows update in place, but changes made by
// others don't reshuffle the list. They're counted instead ("3 updated · show"),
// and `showUpdates` refetches from the top. Your own new tasks are pinned on top.
//
// Rows themselves live in the sync store (pages are ingested into it), so a
// feed is just an ordered list of ids. Until the first page arrives — or while
// offline — the feed falls back to the cached rows, sorted locally.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { ProjectSummary } from "@/contract/api";
import { matchesFilter, type TaskFilter } from "@/contract/filters";
import type { Task } from "@/domain/types";
import { call } from "./api";
import { ingestProjects, useProjects } from "./projects";
import { ingestTasks, useStore } from "./store";

const TASK_PAGE = 50;
const PROJECT_PAGE = 30;

const byUpdatedDesc = (a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);

export interface Feed {
  ids: string[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** First page not loaded yet (showing cached rows, if any). */
  isLoading: boolean;
  fetchNextPage: () => void;
  /** Changes by others since this feed loaded, not reflected in its order. */
  updates: number;
}

export const taskFeedKey = (projectId: string | null, f: TaskFilter, epoch: number) =>
  ["tasks", projectId, epoch, f.status ?? null, f.assignee ?? null, f.q ?? null] as const;

export function useTaskFeed(filter: TaskFilter): Feed {
  const projectId = useStore((s) => s.projectId);
  const ready = useStore((s) => s.phase === "ready");
  const online = useStore((s) => s.online);
  const epoch = useStore((s) => s.epoch);
  const tasks = useStore((s) => s.view?.tasks);
  const pinnedIds = useStore((s) => s.pinned);
  const pendingList = useStore((s) => s.pending);
  // Tasks created locally but not on the server yet (e.g. offline) are never in a page: always pin them.
  const pinned = useMemo(
    () => [...new Set([...pendingList.flatMap((p) => (p.command.type === "task.create" ? [p.command.task.id] : [])).reverse(), ...pinnedIds])],
    [pendingList, pinnedIds],
  );
  const remoteTouched = useStore((s) => s.remoteTouched);

  const query = useInfiniteQuery({
    queryKey: taskFeedKey(projectId, filter, epoch),
    enabled: !!projectId && ready && online,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const page = await call("GET /api/projects/:id/tasks", {
        params: { id: projectId! },
        query: { cursor: pageParam, limit: TASK_PAGE, status: filter.status, assignee: filter.assignee, q: filter.q },
      });
      ingestTasks(page.tasks);
      return { ids: page.tasks.map((t) => t.id), nextCursor: page.nextCursor, version: page.version };
    },
    getNextPageParam: (last) => last.nextCursor,
    staleTime: Infinity,
  });

  const pages = query.data?.pages;
  const baseline = pages?.[0]?.version ?? Infinity;

  const ids = useMemo(() => {
    if (!tasks) return [];
    const match = (id: string) => {
      const t: Task | undefined = tasks[id];
      return !!t && matchesFilter(t, filter);
    };
    if (!pages) {
      return Object.values(tasks)
        .filter((t) => matchesFilter(t, filter))
        .sort(byUpdatedDesc)
        .map((t) => t.id);
    }
    const inPages = new Set(pages.flatMap((p) => p.ids));
    const out = pinned.filter((id) => !inPages.has(id) && match(id));
    const seen = new Set(out);
    for (const id of inPages) {
      if (seen.has(id) || !match(id)) continue;
      out.push(id);
      seen.add(id);
    }
    return out;
  }, [tasks, pages, pinned, filter]);

  const updates = useMemo(() => {
    if (!tasks || !pages) return 0;
    let n = 0;
    for (const [id, seq] of Object.entries(remoteTouched)) if (seq > baseline && tasks[id] && matchesFilter(tasks[id], filter)) n++;
    return n;
  }, [remoteTouched, baseline, tasks, pages, filter]);

  const { fetchNextPage } = query;
  return {
    ids,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: !pages,
    fetchNextPage: useCallback(() => void fetchNextPage(), [fetchNextPage]),
    updates,
  };
}

/** Re-sort every task feed of the project from the top (the pill's "show"). */
export function useShowTaskUpdates() {
  const queryClient = useQueryClient();
  const projectId = useStore((s) => s.projectId);
  return useCallback(() => {
    useStore.setState({ remoteTouched: {} });
    void queryClient.resetQueries({ queryKey: ["tasks", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["counts", projectId] });
  }, [queryClient, projectId]);
}

export function useProjectFeed(): Feed & { showUpdates: () => void } {
  const queryClient = useQueryClient();
  const byId = useProjects((s) => s.byId);
  const pinned = useProjects((s) => s.pinned);
  const remoteTouched = useProjects((s) => s.remoteTouched);

  const query = useInfiniteQuery({
    queryKey: ["projects"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const page = await call("GET /api/projects", { query: { cursor: pageParam, limit: PROJECT_PAGE } });
      ingestProjects(page.projects);
      return { ids: page.projects.map((p) => p.id), nextCursor: page.nextCursor, loadedAt: Date.now() };
    },
    getNextPageParam: (last) => last.nextCursor,
    staleTime: Infinity,
  });

  const pages = query.data?.pages;
  const ids = useMemo(() => {
    if (!pages) return (Object.values(byId) as ProjectSummary[]).sort(byUpdatedDesc).map((p) => p.id);
    const inPages = new Set(pages.flatMap((p) => p.ids));
    const out = pinned.filter((id) => !inPages.has(id) && byId[id]);
    for (const id of inPages) if (byId[id] && !out.includes(id)) out.push(id);
    return out;
  }, [byId, pages, pinned]);

  const loadedAt = pages?.[0]?.loadedAt ?? Infinity;
  const updates = pages ? Object.entries(remoteTouched).filter(([id, at]) => at > loadedAt && byId[id]).length : 0;

  const { fetchNextPage } = query;
  return {
    ids,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: !pages,
    fetchNextPage: useCallback(() => void fetchNextPage(), [fetchNextPage]),
    updates,
    showUpdates: useCallback(() => {
      useProjects.setState({ remoteTouched: {}, pinned: [] });
      void queryClient.resetQueries({ queryKey: ["projects"] });
    }, [queryClient]),
  };
}
