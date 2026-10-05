import type { Priority, TaskStatus } from "@/domain/types";
import { STATUS_LABELS } from "@/domain/rules";

const AVATAR_COLORS = ["bg-rose-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500", "bg-violet-500", "bg-pink-500", "bg-teal-500", "bg-indigo-500"];
/** Same hues as AVATAR_COLORS, for inline styles (cursors, selection outlines). */
const HEX_COLORS = ["#f43f5e", "#f59e0b", "#10b981", "#0ea5e9", "#8b5cf6", "#ec4899", "#14b8a6", "#6366f1"];

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** A stable color per user, shared by their avatar, cursor and selection outline. */
export const colorFor = (name: string) => HEX_COLORS[hash(name) % HEX_COLORS.length];

export function Avatar({ name, size = "sm", ring }: { name: string; size?: "xs" | "sm"; ring?: boolean }) {
  const dims = size === "xs" ? "h-5 w-5 text-[10px]" : "h-7 w-7 text-xs";
  return (
    <span
      title={name}
      className={`${dims} ${AVATAR_COLORS[hash(name) % AVATAR_COLORS.length]} ${ring ? "ring-2 ring-white" : ""} inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase text-white`}
    >
      {name.slice(0, 2)}
    </span>
  );
}

export const STATUS_STYLES: Record<TaskStatus, string> = {
  todo: "bg-zinc-100 text-zinc-700",
  in_progress: "bg-sky-100 text-sky-800",
  in_review: "bg-amber-100 text-amber-800",
  done: "bg-emerald-100 text-emerald-800",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>;
}

const PRIORITY_STYLES: Record<Priority, string> = {
  low: "text-zinc-500",
  medium: "text-sky-700",
  high: "text-amber-700",
  urgent: "text-rose-700 font-semibold",
};

export function PriorityLabel({ priority }: { priority: Priority }) {
  return <span className={`text-xs capitalize ${PRIORITY_STYLES[priority]}`}>{priority}</span>;
}

export function Tag({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
      {children}
      {onRemove && (
        <button onClick={onRemove} className="text-zinc-400 hover:text-zinc-900" aria-label="Remove">
          ×
        </button>
      )}
    </span>
  );
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
