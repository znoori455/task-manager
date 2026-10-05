"use client";
import { useEffect, useRef, useState } from "react";
import { switchUser } from "@/client/session";
import { useStore } from "@/client/store";
import { Avatar } from "./ui";

/** Your avatar; opens a menu to switch to another display name. */
export function UserMenu() {
  const me = useStore((s) => s.me);
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

  if (!me) return null;
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded-full p-0.5 pr-2 text-sm text-zinc-600 hover:bg-zinc-100" onClick={() => setOpen((v) => !v)} aria-label="Account" data-testid="user-menu">
        <Avatar name={me} />
        <span className="hidden max-w-32 truncate sm:inline">{me}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-lg border border-zinc-200 bg-white text-sm shadow-xl">
          <div className="border-b border-zinc-100 px-3 py-2">
            <div className="text-xs text-zinc-400">Signed in as</div>
            <div className="truncate font-medium">{me}</div>
          </div>
          <button className="w-full px-3 py-2 text-left hover:bg-zinc-50" onClick={() => void switchUser().then(() => setOpen(false))}>
            Switch user
          </button>
        </div>
      )}
    </div>
  );
}
