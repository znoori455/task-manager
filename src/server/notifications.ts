import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { NotificationView } from "@/contract/realtime";
import { userKey } from "@/domain/mentions";
import { db, tables } from "./db";
import { channels, publish } from "./redis";

const { notifications } = tables;

const toView = (r: typeof notifications.$inferSelect): NotificationView => ({
  id: r.id,
  type: r.type as NotificationView["type"],
  projectId: r.projectId,
  taskId: r.taskId,
  actor: r.actor,
  data: r.data as NotificationView["data"],
  createdAt: new Date(r.createdAt).toISOString(),
  readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
});

async function unreadCount(recipient: string) {
  const [r] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.recipient, recipient), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

export async function listNotifications(user: string, before: string | null, limit: number) {
  const recipient = userKey(user);
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.recipient, recipient), before ? lt(notifications.createdAt, before) : undefined))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
  return { notifications: rows.map(toView), unread: await unreadCount(recipient) };
}

/** Tell the user's other tabs (via the realtime service) to apply the same change. */
const syncOtherTabs = (recipient: string, change: { read?: string[] | "all"; removed?: string[] | "all" }) =>
  publish(channels.notify(recipient), { kind: "sync", ...change }).catch(() => {});

export async function markRead(user: string, ids?: string[]) {
  const recipient = userKey(user);
  await db
    .update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(notifications.recipient, recipient), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));
  await syncOtherTabs(recipient, { read: ids ?? "all" });
  return { unread: await unreadCount(recipient) };
}

/** Delete notifications (all of them when `ids` is omitted). Only ever the user's own. */
export async function removeNotifications(user: string, ids?: string[]) {
  const recipient = userKey(user);
  await db.delete(notifications).where(and(eq(notifications.recipient, recipient), ids ? inArray(notifications.id, ids) : undefined));
  await syncOtherTabs(recipient, { removed: ids ?? "all" });
  return { unread: await unreadCount(recipient) };
}
