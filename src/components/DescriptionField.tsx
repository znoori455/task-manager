"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { isRealtimeLive, sendSelect, useRealtime } from "@/client/realtime";
import { dispatch, useStore } from "@/client/store";
import { EditableText } from "./EditableText";

type EditorProps = {
  taskId: string;
  saved: string;
  me: string;
  onSave: (text: string) => void;
  /** Live editor only: the shared draft didn't load in time. */
  onUnavailable?: () => void;
  /** Plain editor only: whether the user is in the middle of editing it. */
  onBusy?: (busy: boolean) => void;
};

/** The plain editor: used offline, and if the live editor can't be used. Saves when you click away. */
function PlainDescription({ taskId, saved, onSave, onBusy }: EditorProps) {
  return (
    <EditableText
      multiline
      value={saved}
      placeholder="Add a description…"
      onEditing={(on) => {
        onBusy?.(on);
        sendSelect(taskId, on ? "description" : null);
      }}
      onCommit={onSave}
    />
  );
}

const loadCollab = () => import("./CollabDescription");

/** Start downloading the live editor early (e.g. when a project opens) so it's cached if the network drops later. */
export const preloadDescriptionEditor = () => void loadCollab().catch(() => {});

// CodeMirror + Yjs are only downloaded when needed. If that fails (e.g. offline), fall back instead of crashing the page.
const CollabDescription = dynamic(() => loadCollab().catch(() => PlainDescription), {
  ssr: false,
  loading: () => <div className="h-[124px] animate-pulse rounded-md border border-zinc-200 bg-zinc-50" />,
});

/**
 * The description: edited live together whenever the realtime service is
 * reachable. If it isn't when the panel opens (offline, reconnecting), the plain
 * editor is used and upgrades to live as soon as the connection is back (unless
 * you're mid-edit in it). Once live, it stays live: the editor resyncs on reconnect.
 */
export function DescriptionField({ taskId, value }: { taskId: string; value: string }) {
  const me = useStore((s) => s.me);
  const online = useStore((s) => s.online);
  const realtime = useRealtime((s) => s.status);
  const [live, setLive] = useState(() => isRealtimeLive() && navigator.onLine);
  const [plainBusy, setPlainBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // Upgrade during render (React's pattern for state derived from changing inputs).
  if (!live && !unavailable && realtime === "live" && online && !plainBusy) setLive(true);

  if (!live || unavailable || !me) {
    // Explicit saves from the plain editor go on the undo stack like any other edit.
    return (
      <div>
        <PlainDescription
          taskId={taskId}
          saved={value}
          me={me ?? ""}
          onBusy={setPlainBusy}
          onSave={(description) => dispatch({ type: "task.update", taskId, patch: { description } })}
        />
        {!unavailable && realtime !== "live" && <p className="mt-1 text-xs text-zinc-400">Co-editing is reconnecting; changes save when you click away.</p>}
      </div>
    );
  }
  // Autosaves are frequent, so they stay out of the app-wide undo stack (⌘Z in the editor undoes your own typing).
  const save = (description: string) => dispatch({ type: "task.update", taskId, patch: { description } }, { history: "skip" });
  return <CollabDescription taskId={taskId} saved={value} me={me} onSave={save} onUnavailable={() => setUnavailable(true)} />;
}
