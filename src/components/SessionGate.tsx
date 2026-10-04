"use client";
import { useEffect, useState } from "react";
import { call } from "@/client/api";
import { rememberName, rememberedName } from "@/client/cache";
import { setMe, useStore } from "@/client/store";

/** Asks for a display name once; it identifies the user in comments, presence and the activity feed. */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const me = useStore((s) => s.me);
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    call("GET /api/session")
      .then((r) => {
        setMe(r.name);
        rememberName(r.name);
      })
      // Server unreachable (offline): start with the name remembered on this device.
      .catch(() => setMe(rememberedName()))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (me) return <>{children}</>;

  return (
    <div className="flex flex-1 items-center justify-center">
      <form
        className="w-80 space-y-3 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await call("POST /api/session", { body: { name: name.trim() } });
          setMe(r.name);
          rememberName(r.name);
        }}
      >
        <h1 className="text-lg font-semibold">Welcome to Taskflow</h1>
        <p className="text-sm text-zinc-500">Pick a display name. Others will see it next to your changes.</p>
        <input autoFocus className="input w-full" placeholder="e.g. alice" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        <button className="btn-primary w-full justify-center" disabled={!name.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
