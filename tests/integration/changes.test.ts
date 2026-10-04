// Catch-up for returning clients: Redis change index + Postgres safety net.
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "@/contract/schemas";
import { projectsChangedSince, tasksChangedSince } from "@/server/changes";
import { createProject, executeCommand } from "@/server/commands";
import { db, pg, tables } from "@/server/db";
import { listProjects, listTasks } from "@/server/queries";
import { redis } from "@/server/redis";
import type { Project } from "@/domain/types";

let project: Project;
const tid = (s: string) => `${project.id}-${s}`;
const run = (command: Command) => executeCommand(project.id, { clientMutationId: nanoid(), command }, "alice");

beforeAll(async () => {
  project = await createProject({ name: `changes-${nanoid(6)}`, description: "", metadata: {} }, "test", nanoid(12));
  for (const s of ["a", "b", "c"]) await run({ type: "task.create", task: { id: tid(s), title: s.toUpperCase() } });
});

afterAll(async () => {
  await db.delete(tables.projects).where(eq(tables.projects.id, project.id));
  await pg.end();
  redis.disconnect();
});

describe("tasksChangedSince", () => {
  it("returns only the tasks changed after `since`, served from the Redis index", async () => {
    const { version: since } = await tasksChangedSince(project.id, 0);
    await run({ type: "task.update", taskId: tid("b"), patch: { title: "B2" } });
    await run({ type: "task.update", taskId: tid("b"), patch: { title: "B3" } });
    await run({ type: "task.delete", taskId: tid("c") });

    const res = await tasksChangedSince(project.id, since);
    expect(res.tasks.map((t) => t.id).sort()).toEqual([tid("b"), tid("c")]);
    expect(res.tasks.find((t) => t.id === tid("b"))!.title).toBe("B3"); // current row, not a replay
    expect(res.tasks.find((t) => t.id === tid("c"))!.deletedAt).not.toBeNull(); // deletions included
    expect(res.source).toMatchObject({ fallback: 0 });
    expect(res.source.index).toBe(2);
  });

  it("falls back to Postgres for writes the index missed", async () => {
    const { version: since } = await tasksChangedSince(project.id, 0);
    // Simulate a Redis write that never happened: commit, then remove the task's index entry
    // and roll the sentinel back as if this write was never indexed.
    await run({ type: "task.update", taskId: tid("a"), patch: { title: "A-missed" } });
    await redis.zrem(`project:${project.id}:changed`, tid("a"));
    await redis.zadd(`project:${project.id}:changed`, since, "__complete_through");

    const res = await tasksChangedSince(project.id, since);
    expect(res.tasks.map((t) => t.id)).toEqual([tid("a")]);
    expect(res.source).toMatchObject({ index: 0, fallback: 1 });
  });

  it("rebuilds the index from Postgres if Redis lost it", async () => {
    await redis.del(`project:${project.id}:changed`);
    const res = await tasksChangedSince(project.id, 0);
    expect(res.source.rebuilt).toBe(true);
    expect(res.tasks).toHaveLength(3);
    expect(await redis.zscore(`project:${project.id}:changed`, "__complete_through")).toBe(String(res.version));
  });

  it("returns nothing when the client is up to date", async () => {
    const { version } = await tasksChangedSince(project.id, 0);
    expect((await tasksChangedSince(project.id, version)).tasks).toEqual([]);
  });
});

describe("projectsChangedSince", () => {
  it("reports updated and deleted projects", async () => {
    const since = Date.now() - 1;
    await run({ type: "project.update", patch: { name: "renamed" } });
    const doomed = await createProject({ name: "doomed", description: "", metadata: {} }, "test", nanoid(12));
    await db.delete(tables.projects).where(eq(tables.projects.id, doomed.id));
    const { indexProjectDeleted } = await import("@/server/changes");
    await indexProjectDeleted(doomed.id);

    const res = await projectsChangedSince(since);
    expect(res.projects.map((p) => p.id)).toContain(project.id);
    expect(res.projects.find((p) => p.id === project.id)!.name).toBe("renamed");
    expect(res.deleted).toContain(doomed.id);
  });
});

describe("feeds", () => {
  it("pages tasks by last updated with a stable cursor", async () => {
    await run({ type: "task.update", taskId: tid("a"), patch: { priority: "urgent" } });
    const p1 = await listTasks(project.id, { cursor: null, limit: 1 });
    expect(p1.tasks[0].id).toBe(tid("a"));
    const p2 = await listTasks(project.id, { cursor: p1.nextCursor, limit: 5 });
    expect(p2.tasks.map((t) => t.id)).toEqual([tid("b")]); // c is deleted
    expect(p2.nextCursor).toBeNull();
  });

  it("filters on the server", async () => {
    expect((await listTasks(project.id, { cursor: null, limit: 10, q: "b3" })).tasks.map((t) => t.id)).toEqual([tid("b")]);
    expect((await listTasks(project.id, { cursor: null, limit: 10, status: "done" })).tasks).toEqual([]);
  });

  it("lists projects by last updated", async () => {
    await run({ type: "task.update", taskId: tid("b"), patch: { priority: "low" } });
    const { projects } = await listProjects(null, 1);
    expect(projects[0].id).toBe(project.id);
  });
});
