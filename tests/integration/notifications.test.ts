// Notifications are written in the command's transaction and published for live delivery.
import { eq } from "drizzle-orm";
import Redis from "ioredis";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "@/contract/schemas";
import type { Project } from "@/domain/types";
import { createProject, executeCommand } from "@/server/commands";
import { db, pg, tables } from "@/server/db";
import { listNotifications, markRead } from "@/server/notifications";
import { redis } from "@/server/redis";

let project: Project;
const suffix = nanoid(5).toLowerCase();
const [alice, bob, carol] = ["alice", "bob", "carol"].map((n) => `${n}-${suffix}`);
const tid = `${nanoid(10)}`;
const run = (command: Command, actor: string) => executeCommand(project.id, { clientMutationId: nanoid(), command }, actor);

const sub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const published: { channel: string; message: { type: string } }[] = [];

beforeAll(async () => {
  project = await createProject({ name: "notify-test", description: "", metadata: {} }, "test", nanoid(12));
  await sub.psubscribe(`notify:*-${suffix}`);
  sub.on("pmessage", (_p, channel, message) => published.push({ channel, message: JSON.parse(message) }));
});

afterAll(async () => {
  await db.delete(tables.projects).where(eq(tables.projects.id, project.id));
  sub.disconnect();
  await pg.end();
  redis.disconnect();
});

describe("notifications", () => {
  it("are created for assignment, mentions, comments and status changes — never for the actor", async () => {
    await run({ type: "task.create", task: { id: tid, title: "Launch", assignedTo: [bob] } }, alice);
    await run({ type: "comment.add", comment: { id: nanoid(), taskId: tid, content: `@${carol} can you help?` } }, alice);
    await run({ type: "task.update", taskId: tid, patch: { status: "in_progress" } }, bob); // bob is the only assignee: nobody else to tell
    await run({ type: "task.update", taskId: tid, patch: { status: "in_review" } }, alice);

    const forBob = await listNotifications(bob, null, 10);
    expect(forBob.notifications.map((n) => n.type)).toEqual(["status", "comment", "assigned"]);
    expect(forBob.unread).toBe(3);
    expect(forBob.notifications[0]).toMatchObject({ actor: alice, projectId: project.id, taskId: tid, data: { projectName: "notify-test", taskTitle: "Launch", status: "in_review" } });

    const forCarol = await listNotifications(carol, null, 10);
    expect(forCarol.notifications.map((n) => n.type)).toEqual(["mention"]);
    expect(forCarol.notifications[0].data.excerpt).toContain("can you help?");

    expect((await listNotifications(alice, null, 10)).notifications).toEqual([]);
  });

  it("are published on the recipient's channel for live delivery", async () => {
    await new Promise((r) => setTimeout(r, 100));
    expect(published.filter((p) => p.channel === `notify:${carol}`).map((p) => p.message.type)).toEqual(["mention"]);
    expect(published.filter((p) => p.channel === `notify:${bob}`)).toHaveLength(3);
  });

  it("can be marked read individually or all at once", async () => {
    const { notifications } = await listNotifications(bob, null, 10);
    expect((await markRead(bob, [notifications[0].id])).unread).toBe(2);
    expect((await markRead(bob)).unread).toBe(0);
    expect((await listNotifications(bob, null, 10)).notifications.every((n) => n.readAt)).toBe(true);
  });
});
