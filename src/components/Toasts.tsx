"use client";
import { useStore } from "@/client/store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm shadow-lg ${
            t.kind === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : t.kind === "mention" ? "border-sky-200 bg-sky-50 text-sky-900" : "border-zinc-200 bg-white text-zinc-800"
          }`}
        >
          {t.kind === "mention" && <span className="mr-1">🔔</span>}
          {t.message}
        </div>
      ))}
    </div>
  );
}
