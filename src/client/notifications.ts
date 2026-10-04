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
  const now = new Date().toISOString();
  // Optimistic; the server's count wins.
  set((s) => ({
    items: s.items.map((n) => (!ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)),
    unread: ids ? Math.max(0, s.unread - s.items.filter((n) => ids.includes(n.id) && !n.readAt).length) : 0,
  }));
  try {
    const { unread } = await call("POST /api/notifications/read", { body: { ids } });
    set({ unread });
  } catch {
    // Retried implicitly: the next load reflects the server state.
  }
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
