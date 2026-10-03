// The write path. Every mutation goes through executeCommand:
//
//   lock project row (per-project sequencer)
//   -> load only the rows the command touches
//   -> decide() (shared domain logic) -> events
//   -> applyEvents() to those rows -> upsert changed rows
//   -> append events to the log
//   COMMIT -> publish events to Redis -> SSE fan-out
import { and, asc, eq, getTableColumns, gt, inArray, sql } from "drizzle-orm";
import type { CommandRequest, Command } from "@/contract/schemas";
import { applyEvents, type ProjectState } from "@/domain/apply";
import { decide, DomainError, type DecideContext } from "@/domain/decide";
import type { DomainEvent, EventBody } from "@/domain/events";
import type { Project, Task } from "@/domain/types";
import { db, tables, type Tx } from "./db";
import { fromTask, toComment, toProject, toTask } from "./db/mappers";
import { cacheEvents, channels, publish } from "./redis";

const { projects, tasks, comments, events } = tables;

export interface CommandResult {
  events: DomainEvent[];
  version: number;
}

export async function executeCommand(projectId: string, req: CommandRequest, actor: string): Promise<CommandResult> {
  const result = await db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE serializes writers per project, which gives every
    // event a unique, gap-free seq without a separate sequence service.
    const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!row) throw new DomainError("not_found", "Project not found");
    const project = toProject(row);

    // Idempotency: a retried request (e.g. after a dropped connection) gets the original outcome.
    const prior = await tx
      .select()
      .from(events)
      .where(and(eq(events.projectId, projectId), eq(events.clientMutationId, req.clientMutationId)))
      .orderBy(asc(events.seq));
    if (prior.length) return { events: prior.map(toEvent), version: project.version, fresh: false };

    const ctx = await loadContext(tx, project, req.command);
    const now = new Date().toISOString();
    const bodies = decide(ctx, req.command, { actor, now });
    if (!bodies.length) return { events: [], version: project.version, fresh: false };

    const newEvents: DomainEvent[] = bodies.map((body, i) => ({
      ...body,
      projectId,
      seq: project.version + i + 1,
      actor,
      clientMutationId: req.clientMutationId,
      timestamp: now,
    }));

    await persist(tx, ctx, newEvents);
    return { events: newEvents, version: project.version + newEvents.length, fresh: true };
  });

  if (result.fresh) await broadcast(projectId, result.events);
  return { events: result.events, version: result.version };
}

/** Load the minimal slice of state `decide` needs — never the whole project. */
async function loadContext(tx: Tx, project: Project, cmd: Command): Promise<DecideContext> {
  const ids = new Set<string>();
  switch (cmd.type) {
    case "task.create":
      cmd.task.dependencies?.forEach((d) => ids.add(d));
      break;
    case "task.dependency.add":
    case "task.dependency.remove":
      ids.add(cmd.taskId).add(cmd.dependsOn);
      break;
    case "comment.add":
      ids.add(cmd.comment.taskId);
      break;
    case "project.update":
      break;
    default:
      ids.add(cmd.taskId);
  }

  const ctx: DecideContext = { project, tasks: {} };
  const load = async (wanted: string[]) => {
    if (!wanted.length) return;
    const rows = await tx.select().from(tasks).where(and(eq(tasks.projectId, project.id), inArray(tasks.id, wanted)));
    for (const r of rows) ctx.tasks[r.id] = toTask(r);
  };
  await load([...ids]);
  // Dependencies of the loaded tasks, for "blocked" checks on status changes.
  await load([...new Set(Object.values(ctx.tasks).flatMap((t) => t!.dependencies))].filter((id) => !ctx.tasks[id]));

  if (cmd.type === "task.create") {
    // Ids are client-generated (needed for optimistic UI), so check global uniqueness.
    const [clash] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, cmd.task.id));
    if (clash) throw new DomainError("already_exists", "Task id already in use");
  }

  if (cmd.type === "task.dependency.add" || cmd.type === "task.restore") {
    const starts = cmd.type === "task.dependency.add" ? [cmd.dependsOn] : (ctx.tasks[cmd.taskId]?.dependencies ?? []);
    ctx.graph = await reachableSubgraph(tx, project.id, starts);
  }

  if (cmd.type === "comment.delete") {
    const [c] = await tx.select().from(comments).where(eq(comments.id, cmd.commentId));
    if (c) ctx.commentsById = { [c.id]: toComment(c) };
  }
  return ctx;
}

/**
 * The part of the dependency graph reachable from `starts`, via a recursive
 * CTE — cycle checks touch only the relevant subgraph, not all tasks.
 */
async function reachableSubgraph(tx: Tx, projectId: string, starts: string[]) {
  if (!starts.length) return {};
  const startArray = sql`ARRAY[${sql.join(
    starts.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;
  const rows = await tx.execute<{ id: string; dependencies: string[] }>(sql`
    WITH RECURSIVE reach(id) AS (
      SELECT unnest(${startArray})
      UNION
      SELECT unnest(t.dependencies) FROM tasks t JOIN reach r ON t.id = r.id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
    )
    SELECT t.id, t.dependencies FROM tasks t JOIN reach r ON t.id = r.id
    WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
  `);
  return Object.fromEntries(rows.map((r) => [r.id, r.dependencies]));
}

async function persist(tx: Tx, ctx: DecideContext, newEvents: DomainEvent[]) {
  const before: ProjectState = {
    project: ctx.project,
    tasks: Object.fromEntries(Object.entries(ctx.tasks).filter((e): e is [string, Task] => !!e[1])),
    comments: {},
  };
  // Same reducer the clients run, so server rows and client state can't drift.
  const after = applyEvents(before, newEvents);

  const changed = Object.values(after.tasks).filter((t) => t !== before.tasks[t.id]);
  if (changed.length) {
    await tx
      .insert(tasks)
      .values(changed.map(fromTask))
      .onConflictDoUpdate({
        target: tasks.id,
        set: Object.fromEntries(
          Object.entries(getTableColumns(tasks))
            .filter(([k]) => !["id", "projectId", "createdAt"].includes(k))
            .map(([k, col]) => [k, sql.raw(`excluded.${col.name}`)]),
        ),
      });
  }

  for (const e of newEvents) {
    if (e.type === "comment.added") await tx.insert(comments).values(e.payload.comment);
    if (e.type === "comment.deleted") await tx.delete(comments).where(eq(comments.id, e.payload.commentId));
  }

  const { name, description, metadata } = after.project;
  await tx.update(projects).set({ name, description, metadata, version: after.project.version }).where(eq(projects.id, ctx.project.id));

  await tx.insert(events).values(
    newEvents.map((e) => ({
      projectId: e.projectId,
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      actor: e.actor,
      clientMutationId: e.clientMutationId,
      timestamp: e.timestamp,
    })),
  );
}

async function broadcast(projectId: string, newEvents: DomainEvent[]) {
  try {
    for (const event of newEvents) await publish(channels.project(projectId), { kind: "event", event });
    await cacheEvents(projectId, newEvents);
    if (newEvents.some((e) => e.type === "project.updated")) {
      const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (row) await publish(channels.lobby, { kind: "project.upserted", project: toProject(row) });
    }
  } catch (e) {
    // The events are committed; clients detect the gap and replay from Postgres.
    console.error("[broadcast] failed", e);
  }
}

export function toEvent(r: typeof events.$inferSelect): DomainEvent {
  return {
    type: r.type,
    payload: r.payload,
    projectId: r.projectId,
    seq: r.seq,
    actor: r.actor,
    clientMutationId: r.clientMutationId,
    timestamp: new Date(r.timestamp).toISOString(),
  } as DomainEvent;
}

export async function eventsSince(projectId: string, since: number, limit: number): Promise<DomainEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.projectId, projectId), gt(events.seq, since)))
    .orderBy(asc(events.seq))
    .limit(limit);
  return rows.map(toEvent);
}

export async function createProject(input: { name: string; description: string; metadata: Record<string, unknown> }, actor: string, id: string) {
  const now = new Date().toISOString();
  const project: Project = { id, ...input, version: 1, createdAt: now };
  const body: EventBody = { type: "project.created", payload: { project: { id, ...input, createdAt: now } } };
  await db.transaction(async (tx) => {
    await tx.insert(projects).values(project);
    await tx.insert(events).values({ projectId: id, seq: 1, type: body.type, payload: body.payload, actor, timestamp: now });
  });
  await publish(channels.lobby, { kind: "project.upserted", project }).catch(() => {});
  return project;
}
