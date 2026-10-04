import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { ProjectSummary, TaskCounts, TaskPage } from "@/contract/api";
import type { TaskFilter } from "@/contract/filters";
import { DomainError } from "@/domain/decide";
import type { DomainEvent } from "@/domain/events";
import { TASK_STATUSES, type Comment, type Project, type Task, type TaskStatus } from "@/domain/types";
import { projectSummaries } from "./changes";
import { db, tables } from "./db";
import { toComment, toProject, toTask } from "./db/mappers";
import { toEvent } from "./commands";

const { projects, tasks, comments, events } = tables;

const encodeCursor = (updatedAt: string, id: string) => Buffer.from(JSON.stringify([updatedAt, id])).toString("base64url");
function decodeCursor(cursor: string | null): [string, string] | null {
  if (!cursor) return null;
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    return typeof ts === "string" && typeof id === "string" && !Number.isNaN(Date.parse(ts)) ? [ts, id] : null;
  } catch {
    return null;
  }
}

/**
 * Project list, most recently updated first. Keyset pagination on
 * (updated_at, id), served by projects_updated_idx.
 */
export async function listProjects(cursor: string | null, limit: number): Promise<{ projects: ProjectSummary[]; nextCursor: string | null }> {
  const after = decodeCursor(cursor);
  const page = await db
    .select({ id: projects.id, updatedAt: projects.updatedAt })
    .from(projects)
    .where(after ? sql`(${projects.updatedAt}, ${projects.id}) < (${after[0]}::timestamptz, ${after[1]})` : undefined)
    .orderBy(desc(projects.updatedAt), desc(projects.id))
    .limit(limit + 1);
  const rows = page.slice(0, limit);
  const last = rows.at(-1);
  return {
    projects: await projectSummaries(rows.map((r) => r.id)),
    nextCursor: page.length > limit && last ? encodeCursor(new Date(last.updatedAt).toISOString(), last.id) : null,
  };
}

export async function getProject(id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row ? toProject(row) : null;
}

function filterSql(projectId: string, f: TaskFilter): SQL[] {
  const where: SQL[] = [eq(tasks.projectId, projectId), isNull(tasks.deletedAt)];
  if (f.status) where.push(eq(tasks.status, f.status));
  if (f.assignee) where.push(sql`${tasks.assignedTo} @> ARRAY[${f.assignee}]::text[]`);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(tasks.title, like), sql`${tasks.tags} @> ARRAY[${f.q}]::text[]`)!);
  }
  return where;
}

/**
 * Task feed, most recently updated first. Keyset pagination on (updated_at, id),
 * served by tasks_project_updated_idx — page 500 costs the same as page 1.
 */
export async function listTasks(projectId: string, opts: TaskFilter & { cursor: string | null; limit: number }): Promise<TaskPage> {
  const project = await getProject(projectId);
  if (!project) throw new DomainError("not_found", "Project not found");
  const where = filterSql(projectId, opts);
  const after = decodeCursor(opts.cursor);
  if (after) where.push(sql`(${tasks.updatedAt}, ${tasks.id}) < (${after[0]}::timestamptz, ${after[1]})`);
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...where))
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit).map(toTask);
  const last = page.at(-1);
  return {
    tasks: page,
    nextCursor: rows.length > opts.limit && last ? encodeCursor(last.updatedAt, last.id) : null,
    version: project.version,
  };
}

/** Specific tasks (including soft-deleted ones), e.g. dependencies of visible tasks. */
export async function getTasksByIds(projectId: string, ids: string[]): Promise<Task[]> {
  if (!ids.length) return [];
  const rows = await db.select().from(tasks).where(and(eq(tasks.projectId, projectId), inArray(tasks.id, ids)));
  return rows.map(toTask);
}

/** Live task counts per status for a filter (status in the filter is ignored). */
export async function countTasks(projectId: string, f: TaskFilter): Promise<TaskCounts> {
  const rows = await db
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .where(and(...filterSql(projectId, { ...f, status: undefined })))
    .groupBy(tasks.status);
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const r of rows) byStatus[r.status as TaskStatus] = r.n;
  return { total: rows.reduce((a, r) => a + r.n, 0), byStatus };
}

export async function listComments(projectId: string, taskId: string): Promise<Comment[]> {
  const rows = await db
    .select({ c: comments })
    .from(comments)
    .innerJoin(tasks, eq(tasks.id, comments.taskId))
    .where(and(eq(comments.taskId, taskId), eq(tasks.projectId, projectId)))
    .orderBy(asc(comments.timestamp))
    .limit(1000);
  return rows.map((r) => toComment(r.c));
}

/** Activity feed: newest first, paginated backwards by seq. */
export async function listEvents(projectId: string, before: number | null, limit: number): Promise<DomainEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.projectId, projectId), before ? lt(events.seq, before) : undefined))
    .orderBy(desc(events.seq))
    .limit(limit);
  return rows.map(toEvent);
}
