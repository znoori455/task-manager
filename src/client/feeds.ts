"use client";
// Infinite-scroll feeds (TanStack Query), sorted by last updated.
//
// Order is live: a feed is the rows in the sync store that match its filter,
// sorted by (updatedAt, id), so anything anyone edits or creates moves to its
// place immediately — no refresh needed.
//
// Pages only decide how far down the feed reaches: rows newer than the last
// loaded page are shown (that includes everything edited since, wherever it
// was), older ones appear as you scroll and their page loads. Rows the store
// holds for other reasons (e.g. a dependency shown elsewhere) therefore don't
// pop up out of order in the middle of the list.
//
// Until the first page arrives — or while offline — the feed shows every
// cached row, sorted the same way.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { ProjectSummary } from "@/contract/api";
import { matchesFilter, type TaskFilter } from "@/contract/filters";
import { call } from "./api";
import { ingestProjects, useProjects } from "./projects";
import { ingestTasks, useStore } from "./store";

const TASK_PAGE = 50;
const PROJECT_PAGE = 30;

type Row = { updatedAt: string; id: string };
const byUpdatedDesc = (a: Row, b: Row) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);

/** The last row of the last loaded page, as it was when fetched: the feed shows rows at or above it. */
type Boundary = Row | null;
const withinBoundary = (row: Row, boundary: Boundary) => !boundary || byUpdatedDesc(row, boundary) <= 0;

/** Boundary for a feed's loaded pages; null when everything is loaded. */
function boundaryOf(pages: { last: Row | null; nextCursor: string | null }[] | undefined): Boundary {
  const last = pages?.at(-1);
  return last && last.nextCursor ? last.last : null;
}

export interface Feed {
  ids: string[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** First page not loaded yet (showing cached rows, if any). */
  isLoading: boolean;
  fetchNextPage: () => void;
}

export const taskFeedKey = (projectId: string | null, f: TaskFilter, epoch: number) =>
  ["tasks", projectId, epoch, f.status ?? null, f.assignee ?? null, f.q ?? null] as const;

export function useTaskFeed(filter: TaskFilter): Feed {
  const projectId = useStore((s) => s.projectId);
  const ready = useStore((s) => s.phase === "ready");
  const online = useStore((s) => s.online);
  const epoch = useStore((s) => s.epoch);
  const tasks = useStore((s) => s.view?.tasks);

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
      const last = page.tasks.at(-1);
      return { nextCursor: page.nextCursor, last: last ? { updatedAt: last.updatedAt, id: last.id } : null };
    },
    getNextPageParam: (last) => last.nextCursor,
    staleTime: Infinity,
  });

  const pages = query.data?.pages;
  const boundary = boundaryOf(pages);

  const ids = useMemo(() => {
    if (!tasks) return [];
    // Pending (e.g. offline) creates are in the view with a fresh updatedAt, so they sort to the top too.
    return Object.values(tasks)
      .filter((t) => matchesFilter(t, filter) && withinBoundary(t, boundary))
      .sort(byUpdatedDesc)
      .map((t) => t.id);
  }, [tasks, filter, boundary]);

  const { fetchNextPage } = query;
  return {
    ids,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: !pages,
    fetchNextPage: useCallback(() => void fetchNextPage(), [fetchNextPage]),
  };
}

export function useProjectFeed(): Feed {
  const byId = useProjects((s) => s.byId);

  const query = useInfiniteQuery({
    queryKey: ["projects"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const page = await call("GET /api/projects", { query: { cursor: pageParam, limit: PROJECT_PAGE } });
      ingestProjects(page.projects);
      const last = page.projects.at(-1);
      return { nextCursor: page.nextCursor, last: last ? { updatedAt: last.updatedAt, id: last.id } : null };
    },
    getNextPageParam: (last) => last.nextCursor,
    staleTime: Infinity,
  });

  const pages = query.data?.pages;
  const boundary = boundaryOf(pages);
  const ids = useMemo(
    () =>
      (Object.values(byId) as ProjectSummary[])
        .filter((p) => withinBoundary(p, boundary))
        .sort(byUpdatedDesc)
        .map((p) => p.id),
    [byId, boundary],
  );

  const { fetchNextPage } = query;
  return {
    ids,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: !pages,
    fetchNextPage: useCallback(() => void fetchNextPage(), [fetchNextPage]),
  };
}
