import { and, asc, count, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { ProjectSummary, TaskPage } from "@/contract/api";
import type { DomainEvent } from "@/domain/events";
import type { Comment, Project } from "@/domain/types";
import { db, tables } from "./db";
import { toComment, toProject, toTask } from "./db/mappers";
import { toEvent } from "./commands";

const { projects, tasks, comments, events } = tables;

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = await db
    .select({ project: projects, taskCount: count(tasks.id) })
    .from(projects)
    .leftJoin(tasks, and(eq(tasks.projectId, projects.id), isNull(tasks.deletedAt)))
    .groupBy(projects.id)
    .orderBy(desc(projects.createdAt));
  return rows.map((r) => ({ ...toProject(r.project), taskCount: r.taskCount }));
}

export async function getProject(id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row ? toProject(row) : null;
}

/** Keyset pagination on (project_id, id) — O(page) regardless of depth, served by tasks_project_live_id_idx. */
export async function listTasks(projectId: string, cursor: string | null, limit: number): Promise<TaskPage> {
  const project = await getProject(projectId);
  if (!project) return { tasks: [], nextCursor: null, version: 0 };
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt), cursor ? gt(tasks.id, cursor) : undefined))
    .orderBy(asc(tasks.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    tasks: page.map(toTask),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    version: project.version,
  };
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
