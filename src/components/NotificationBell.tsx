"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { describeNotification, markRead, removeNotifications, useNotifications } from "@/client/notifications";
import { selectTask, useStore } from "@/client/store";
import type { NotificationView } from "@/contract/realtime";
import { Avatar, timeAgo } from "./ui";

const ICONS: Record<NotificationView["type"], string> = { mention: "@", assigned: "→", comment: "💬", status: "↻" };

/** Bell with unread count; the list covers all projects. Clicking an item opens its task. */
export function NotificationBell() {
  const items = useNotifications((s) => s.items);
  const unread = useNotifications((s) => s.unread);
  const currentProject = useStore((s) => s.projectId);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openNotification = (n: NotificationView) => {
    setOpen(false);
    if (!n.readAt) void markRead([n.id]);
    if (n.projectId === currentProject) {
      if (n.taskId) selectTask(n.taskId);
    } else router.push(`/projects/${n.projectId}${n.taskId ? `?task=${n.taskId}` : ""}`);
  };

  return (
    <div className="relative" ref={ref}>
      <button className="btn relative" onClick={() => setOpen((v) => !v)} aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} data-testid="notification-bell">
        🔔
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-rose-600 px-1 text-center text-[11px] font-semibold leading-5 text-white" data-testid="unread-count">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            <span className="flex gap-3">
              <button className="text-xs text-sky-700 hover:underline disabled:text-zinc-300 disabled:no-underline" disabled={!unread} onClick={() => void markRead()}>
                Mark all read
              </button>
              <button className="text-xs text-zinc-500 hover:text-rose-600 hover:underline disabled:text-zinc-300 disabled:no-underline" disabled={!items.length} onClick={() => void removeNotifications()}>
                Clear all
              </button>
            </span>
          </div>
          <ul className="max-h-96 divide-y divide-zinc-100 overflow-y-auto" data-testid="notification-list">
            {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-zinc-400">No notifications. You&apos;ll hear about mentions and your tasks here.</li>}
            {items.map((n) => (
              <li key={n.id} className={`group relative ${n.readAt ? "" : "bg-sky-50/60"}`} data-testid="notification">
                <button
                  className="absolute right-2 top-2 z-10 rounded px-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-zinc-700 focus:opacity-100 group-hover:opacity-100"
                  onClick={() => void removeNotifications([n.id])}
                  aria-label="Dismiss notification"
                  title="Dismiss"
                >
                  ×
                </button>
                <button onClick={() => openNotification(n)} className="flex w-full gap-2.5 py-2.5 pl-3 pr-8 text-left text-sm hover:bg-zinc-50/80">
                  <span className="relative">
                    <Avatar name={n.actor} size="xs" />
                    <span className="absolute -bottom-1 -right-1 rounded-full bg-white text-[10px] leading-none">{ICONS[n.type]}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-zinc-700">{describeNotification(n)}</span>
                    <span className="text-xs text-zinc-400">
                      {n.data.projectName} · {timeAgo(n.createdAt)}
                    </span>
                  </span>
                  {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-label="unread" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
