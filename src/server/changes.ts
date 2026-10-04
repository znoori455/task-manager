// "What changed while I was away?" — catch-up for clients returning with a
// local (IndexedDB) cache.
//
// Tasks: one Redis sorted set per project, member = task id, score = seq of
// the task's last change. It holds one entry per task, so it's bounded by the
// number of tasks, not by the number of writes. A returning client sends the
// last seq it saw and gets back the *current rows* of just the tasks that
// changed — instead of replaying every event, or reloading everything.
//
// Redis isn't part of the Postgres transaction, so a write to the set can be
// missed. A sentinel member records "complete through seq N": it only advances
// when the previous write was indexed too. Anything newer than N is read from
// Postgres (tasks_project_version_idx), and a missing or badly lagging set is
// rebuilt from Postgres. Redis is the fast path; it can never lose an update.
//
// Projects: a global sorted set by last-updated time, plus a sorted set of
// deletions (tombstones) so returning clients can drop deleted projects.
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { ProjectChanges, ProjectSummary, TaskChanges } from "@/contract/api";
import { DomainError } from "@/domain/decide";
import type { Task } from "@/domain/types";
import { db, tables, type Tx } from "./db";
import { toProject, toTask } from "./db/mappers";
import { redis } from "./redis";

const { projects, tasks } = tables;

const SENTINEL = "__complete_through";
/** Rebuild the set instead of patching from Postgres when it lags this far behind. */
const REBUILD_LAG = 1000;
/** Above this many changed tasks the client is better off reloading. */
export const MAX_CHANGED_TASKS = 2000;
/** How long project deletions are remembered. Clients away longer reload the list. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The project index is rebuilt at least this often, bounding staleness from missed writes. */
const PROJECT_INDEX_TTL_S = 600;

const keys = {
  taskIndex: (projectId: string) => `project:${projectId}:changed`,
  projectsUpdated: "projects:updated",
  projectsDeleted: "projects:deleted",
  projectsIndexed: "projects:indexed",
};

// KEYS: task index, project index. ARGV: firstSeq, lastSeq, projectId, projectScore, (taskId, version)...
const INDEX_WRITE = `
local complete = redis.call('ZSCORE', KEYS[1], '${SENTINEL}')
for i = 5, #ARGV, 2 do
  redis.call('ZADD', KEYS[1], 'GT', ARGV[i + 1], ARGV[i])
end
if complete and tonumber(complete) == tonumber(ARGV[1]) - 1 then
  redis.call('ZADD', KEYS[1], ARGV[2], '${SENTINEL}')
end
redis.call('ZADD', KEYS[2], 'GT', ARGV[4], ARGV[3])
return 1
`;

/**
 * Record a committed-to-be write in the change indexes. Called inside the
 * write transaction while the project row is locked, so calls for one project
 * are serialized. Never throws: a failure only means readers fall back to Postgres.
 */
export async function indexWrite(projectId: string, firstSeq: number, lastSeq: number, touched: Pick<Task, "id" | "version">[], projectUpdatedAt: string) {
  try {
    await redis.eval(
      INDEX_WRITE,
      2,
      keys.taskIndex(projectId),
      keys.projectsUpdated,
      firstSeq,
      lastSeq,
      projectId,
      Date.parse(projectUpdatedAt),
      ...touched.flatMap((t) => [t.id, t.version]),
    );
  } catch (e) {
    console.error("[changes] index write failed; readers will fall back to Postgres", (e as Error).message);
  }
}

/** Rebuild a project's task index from Postgres, holding the project lock so no write interleaves. */
export async function rebuildTaskIndex(projectId: string): Promise<number> {
  return db.transaction(async (tx: Tx) => {
    const [p] = await tx.select({ version: projects.version }).from(projects).where(eq(projects.id, projectId)).for("update");
    if (!p) throw new DomainError("not_found", "Project not found");
    const rows = await tx.select({ id: tasks.id, version: tasks.version }).from(tasks).where(eq(tasks.projectId, projectId));
    const key = keys.taskIndex(projectId);
    const multi = redis.multi().del(key);
    for (let i = 0; i < rows.length; i += 1000) {
      multi.zadd(key, ...rows.slice(i, i + 1000).flatMap((r) => [r.version, r.id]));
    }
    multi.zadd(key, p.version, SENTINEL);
    await multi.exec();
    return p.version;
  });
}

export async function tasksChangedSince(projectId: string, since: number): Promise<TaskChanges> {
  const [p] = await db.select({ version: projects.version }).from(projects).where(eq(projects.id, projectId));
  if (!p) throw new DomainError("not_found", "Project not found");
  const source = { index: 0, fallback: 0, rebuilt: false };
  if (since >= p.version) return { version: p.version, tasks: [], reset: false, source };

  const key = keys.taskIndex(projectId);
  const read = async () => {
    const [[, complete], [, members]] = (await redis
      .multi()
      .zscore(key, SENTINEL)
      .zrangebyscore(key, `(${since}`, "+inf", "LIMIT", 0, MAX_CHANGED_TASKS + 2)
      .exec()) as [[unknown, string | null], [unknown, string[]]];
    return { complete: complete === null ? null : Number(complete), ids: members.filter((m) => m !== SENTINEL) };
  };

  let ids = new Set<string>();
  let complete = since;
  try {
    let r = await read();
    if (r.complete === null || p.version - r.complete > REBUILD_LAG) {
      await rebuildTaskIndex(projectId);
      source.rebuilt = true;
      r = await read();
    }
    complete = r.complete ?? since;
    ids = new Set(r.ids);
    source.index = ids.size;
  } catch (e) {
    console.error("[changes] Redis unavailable, using Postgres", (e as Error).message);
  }

  // Safety net: anything newer than what the index vouches for comes from Postgres.
  if (complete < p.version) {
    const extra = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), gt(tasks.version, Math.max(since, complete))))
      .limit(MAX_CHANGED_TASKS + 1);
    for (const r of extra) {
      if (ids.has(r.id)) continue;
      ids.add(r.id);
      source.fallback++;
    }
  }

  if (ids.size > MAX_CHANGED_TASKS) return { version: p.version, tasks: [], reset: true, source };
  const all = [...ids];
  const rows = [];
  for (let i = 0; i < all.length; i += 1000) {
    rows.push(...(await db.select().from(tasks).where(and(eq(tasks.projectId, projectId), inArray(tasks.id, all.slice(i, i + 1000))))));
  }
  return { version: p.version, tasks: rows.map(toTask), reset: false, source };
}

// ---------- projects ----------

export async function indexProjectCreated(projectId: string, updatedAt: string) {
  await redis.zadd(keys.projectsUpdated, "GT", Date.parse(updatedAt), projectId).catch(() => {});
}

export async function indexProjectDeleted(projectId: string) {
  const now = Date.now();
  await redis
    .multi()
    .zrem(keys.projectsUpdated, projectId)
    .zadd(keys.projectsDeleted, now, projectId)
    .zremrangebyscore(keys.projectsDeleted, "-inf", now - TOMBSTONE_TTL_MS)
    .exec()
    .catch(() => {});
}

async function rebuildProjectIndex() {
  const rows = await db.select({ id: projects.id, updatedAt: projects.updatedAt }).from(projects);
  const multi = redis.multi().del(keys.projectsUpdated);
  for (let i = 0; i < rows.length; i += 1000) {
    multi.zadd(keys.projectsUpdated, ...rows.slice(i, i + 1000).flatMap((r) => [Date.parse(r.updatedAt), r.id]));
  }
  await multi.set(keys.projectsIndexed, "1", "EX", PROJECT_INDEX_TTL_S).exec();
}

export async function projectsChangedSince(since: number): Promise<ProjectChanges> {
  const now = Date.now();
  if (since < now - TOMBSTONE_TTL_MS) return { now, projects: [], deleted: [], reset: true };

  let ids: string[];
  let deleted: string[] = [];
  try {
    if (!(await redis.exists(keys.projectsIndexed))) await rebuildProjectIndex();
    const [[, updated], [, removed]] = (await redis
      .multi()
      .zrangebyscore(keys.projectsUpdated, `(${since}`, "+inf")
      .zrangebyscore(keys.projectsDeleted, `(${since}`, "+inf")
      .exec()) as [[unknown, string[]], [unknown, string[]]];
    ids = updated;
    deleted = removed;
  } catch {
    const rows = await db.select({ id: projects.id }).from(projects).where(gt(projects.updatedAt, new Date(since).toISOString()));
    ids = rows.map((r) => r.id);
  }
  return { now, projects: await projectSummaries(ids), deleted, reset: false };
}

export async function projectSummaries(ids: string[]): Promise<ProjectSummary[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ project: projects, taskCount: count(tasks.id) })
    .from(projects)
    .leftJoin(tasks, and(eq(tasks.projectId, projects.id), isNull(tasks.deletedAt)))
    .where(inArray(projects.id, ids))
    .groupBy(projects.id)
    .orderBy(sql`${projects.updatedAt} DESC`, sql`${projects.id} DESC`);
  return rows.map((r) => ({ ...toProject(r.project), taskCount: r.taskCount }));
}
