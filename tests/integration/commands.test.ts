// Runs the real write path against Postgres + Redis (docker compose up db redis).
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvents, type ProjectState } from "@/domain/apply";
import type { Project } from "@/domain/types";
import { createProject, eventsSince, executeCommand } from "@/server/commands";
import { db, pg, tables } from "@/server/db";
import { listTasks } from "@/server/queries";
import { redis } from "@/server/redis";
import type { Command } from "@/contract/schemas";

let project: Project;
const run = (command: Command, actor = "alice") => executeCommand(project.id, { clientMutationId: nanoid(), command }, actor);

beforeAll(async () => {
  project = await createProject({ name: `it-${nanoid(6)}`, description: "", metadata: {} }, "test", nanoid(12));
});

afterAll(async () => {
  await db.delete(tables.projects).where(eq(tables.projects.id, project.id));
  await pg.end();
  redis.disconnect();
});

describe("command pipeline", () => {
  it("assigns gap-free sequence numbers under concurrent writes", async () => {
    await run({ type: "task.create", task: { id: `${project.id}-a`, title: "A" } });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => run({ type: "task.update", taskId: `${project.id}-a`, patch: { title: `A${i}` } }, i % 2 ? "alice" : "bob")),
    );
    const seqs = results.flatMap((r) => r.events.map((e) => e.seq)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 3)); // 1 = project.created, 2 = task.created
    const log = await eventsSince(project.id, 0, 1000);
    expect(log.map((e) => e.seq)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
  });

  it("is idempotent per clientMutationId", async () => {
    const req = { clientMutationId: nanoid(), command: { type: "task.create", task: { id: `${project.id}-b`, title: "B" } } as Command };
    const first = await executeCommand(project.id, req, "alice");
    const retry = await executeCommand(project.id, req, "alice");
    expect(retry.events.map((e) => e.seq)).toEqual(first.events.map((e) => e.seq));
  });

  it("rolls back rejected commands without consuming a sequence number", async () => {
    const before = (await eventsSince(project.id, 0, 1000)).length;
    await run({ type: "task.dependency.add", taskId: `${project.id}-a`, dependsOn: `${project.id}-b` });
    await expect(run({ type: "task.dependency.add", taskId: `${project.id}-b`, dependsOn: `${project.id}-a` })).rejects.toMatchObject({ code: "cycle" });
    await expect(run({ type: "task.update", taskId: `${project.id}-a`, patch: { status: "done" } })).rejects.toMatchObject({ code: "invalid_transition" });
    const log = await eventsSince(project.id, 0, 1000);
    expect(log.length).toBe(before + 1);
    expect(log.at(-1)!.seq).toBe(log.length);
  });

  it("rejects task ids that exist in another project", async () => {
    const other = await createProject({ name: "other", description: "", metadata: {} }, "test", nanoid(12));
    try {
      await expect(
        executeCommand(other.id, { clientMutationId: nanoid(), command: { type: "task.create", task: { id: `${project.id}-a`, title: "steal" } } }, "eve"),
      ).rejects.toMatchObject({ code: "already_exists" });
    } finally {
      await db.delete(tables.projects).where(eq(tables.projects.id, other.id));
    }
  });

  it("read model equals a replay of the event log (event sourcing invariant)", async () => {
    await run({ type: "task.tags", taskId: `${project.id}-b`, add: ["x", "y"], remove: [] });
    await run({ type: "comment.add", comment: { id: nanoid(), taskId: `${project.id}-b`, content: "hello" } });
    await run({ type: "task.update", taskId: `${project.id}-b`, patch: { customFields: { points: 5 } } });
    await run({ type: "task.delete", taskId: `${project.id}-a` });
    await run({ type: "task.restore", taskId: `${project.id}-a` });

    const log = await eventsSince(project.id, 0, 10_000);
    const empty: ProjectState = { project: { ...project, version: 0 }, tasks: {}, comments: {} };
    const replayed = applyEvents(empty, log);
    const { tasks } = await listTasks(project.id, null, 1000);
    for (const t of tasks) {
      const r = replayed.tasks[t.id];
      expect({ ...r, createdAt: undefined, updatedAt: undefined }).toEqual({ ...t, createdAt: undefined, updatedAt: undefined });
    }
    expect(Object.values(replayed.tasks).filter((t) => !t.deletedAt)).toHaveLength(tasks.length);
  });
});
