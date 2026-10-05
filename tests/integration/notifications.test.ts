// Notifications are written in the command's transaction and published for live delivery.
import { eq } from "drizzle-orm";
import Redis from "ioredis";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "@/contract/schemas";
import type { Project } from "@/domain/types";
import { createProject, executeCommand } from "@/server/commands";
import { db, pg, tables } from "@/server/db";
import { listNotifications, markRead, removeNotifications } from "@/server/notifications";
import { redis } from "@/server/redis";

let project: Project;
const suffix = nanoid(5).toLowerCase();
const [alice, bob, carol] = ["alice", "bob", "carol"].map((n) => `${n}-${suffix}`);
const tid = `${nanoid(10)}`;
const run = (command: Command, actor: string) => executeCommand(project.id, { clientMutationId: nanoid(), command }, actor);

const sub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const published: { channel: string; message: { kind: string; notification?: { type: string }; read?: unknown; removed?: unknown } }[] = [];

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
    expect(published.filter((p) => p.channel === `notify:${carol}`).map((p) => p.message.notification?.type)).toEqual(["mention"]);
    expect(published.filter((p) => p.channel === `notify:${bob}` && p.message.kind === "new")).toHaveLength(3);
  });

  it("can be marked read individually or all at once", async () => {
    const { notifications } = await listNotifications(bob, null, 10);
    expect((await markRead(bob, [notifications[0].id])).unread).toBe(2);
    expect((await markRead(bob)).unread).toBe(0);
    expect((await listNotifications(bob, null, 10)).notifications.every((n) => n.readAt)).toBe(true);
  });

  it("can be removed one at a time or all at once, only by their owner, and other tabs are told", async () => {
    await run({ type: "comment.add", comment: { id: nanoid(), taskId: tid, content: `@${carol} again` } }, alice);
    const { notifications } = await listNotifications(carol, null, 10);
    expect(notifications).toHaveLength(2);

    // Someone else can't delete carol's notifications, even by id.
    await removeNotifications(bob, [notifications[0].id]);
    expect((await listNotifications(carol, null, 10)).notifications).toHaveLength(2);

    expect((await removeNotifications(carol, [notifications[0].id])).unread).toBe(1);
    expect((await listNotifications(carol, null, 10)).notifications.map((n) => n.id)).toEqual([notifications[1].id]);
    expect(await removeNotifications(carol)).toEqual({ unread: 0 });
    expect((await listNotifications(carol, null, 10)).notifications).toEqual([]);

    await new Promise((r) => setTimeout(r, 100));
    const syncs = published.filter((p) => p.channel === `notify:${carol}` && p.message.kind === "sync").map((p) => p.message.removed);
    expect(syncs).toEqual([[notifications[0].id], "all"]);
  });
});
