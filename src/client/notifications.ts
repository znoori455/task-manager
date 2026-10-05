"use client";
// Notifications: loaded from the API (the source of truth), pushed live over
// the realtime WebSocket, and refetched after every reconnect so nothing that
// arrived while disconnected is missed.
import { create } from "zustand";
import type { NotificationView } from "@/contract/realtime";
import { STATUS_LABELS } from "@/domain/rules";
import { call } from "./api";
import { toast } from "./store";

interface NotificationsState {
  items: NotificationView[];
  unread: number;
  loaded: boolean;
}

export const useNotifications = create<NotificationsState>(() => ({ items: [], unread: 0, loaded: false }));
const set = useNotifications.setState;

export async function loadNotifications() {
  try {
    const res = await call("GET /api/notifications", { query: { limit: 30 } });
    set({ items: res.notifications, unread: res.unread, loaded: true });
  } catch {
    // Offline: keep what we have.
  }
}

export function receiveNotification(n: NotificationView) {
  set((s) => (s.items.some((x) => x.id === n.id) ? s : { items: [n, ...s.items].slice(0, 100), unread: s.unread + 1 }));
  toast(n.type === "mention" ? "mention" : "info", describeNotification(n));
}

export async function markRead(ids?: string[]) {
  // Optimistic; the server's count wins.
  applySync({ read: ids ?? "all" });
  try {
    const { unread } = await call("POST /api/notifications/read", { body: { ids } });
    set({ unread });
  } catch {
    // Retried implicitly: the next load reflects the server state.
  }
}

/** Remove notifications (all when `ids` is omitted). Optimistic; restored if the request fails. */
export async function removeNotifications(ids?: string[]) {
  const before = useNotifications.getState();
  applySync({ removed: ids ?? "all" });
  try {
    const { unread } = ids?.length === 1 ? await call("DELETE /api/notifications/:id", { params: { id: ids[0] } }) : await clearMany(ids);
    set({ unread });
  } catch {
    set({ items: before.items, unread: before.unread });
    toast("error", "Couldn't clear notifications. Check your connection.");
  }
}

async function clearMany(ids?: string[]) {
  if (!ids) return call("DELETE /api/notifications");
  let last = { unread: useNotifications.getState().unread };
  for (const id of ids) last = await call("DELETE /api/notifications/:id", { params: { id } });
  return last;
}

/** Apply a read/remove that happened elsewhere (another tab), or optimistically here. */
export function applySync(change: { read?: string[] | "all"; removed?: string[] | "all" }) {
  const now = new Date().toISOString();
  set((s) => {
    const removed = (n: NotificationView) => change.removed === "all" || !!change.removed?.includes(n.id);
    const read = (n: NotificationView) => change.read === "all" || !!change.read?.includes(n.id);
    const items = s.items.filter((n) => !removed(n)).map((n) => (!n.readAt && read(n) ? { ...n, readAt: now } : n));
    const lostUnread = s.items.filter((n) => !n.readAt && (removed(n) || read(n))).length;
    // "all" also covers notifications beyond the loaded page.
    const unread = change.read === "all" || change.removed === "all" ? 0 : Math.max(0, s.unread - lostUnread);
    return { items, unread };
  });
}

export function describeNotification(n: NotificationView): string {
  const task = `“${n.data.taskTitle}”`;
  switch (n.type) {
    case "mention":
      return `${n.actor} mentioned you in ${task}${n.data.excerpt ? `: ${n.data.excerpt}` : ""}`;
    case "assigned":
      return `${n.actor} assigned you to ${task}`;
    case "comment":
      return `${n.actor} commented on ${task}${n.data.excerpt ? `: ${n.data.excerpt}` : ""}`;
    case "status":
      return `${n.actor} moved ${task} to ${n.data.status ? STATUS_LABELS[n.data.status as keyof typeof STATUS_LABELS] : "a new status"}`;
  }
}
