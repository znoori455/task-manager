"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { isRealtimeLive, sendSelect } from "@/client/realtime";
import { dispatch, useStore } from "@/client/store";
import { EditableText } from "./EditableText";

type EditorProps = { taskId: string; saved: string; me: string; onSave: (text: string) => void };

/** The plain editor: used offline, and if the live editor's code can't be downloaded. */
function PlainDescription({ taskId, saved, onSave }: EditorProps) {
  return (
    <EditableText
      multiline
      value={saved}
      placeholder="Add a description…"
      onEditing={(on) => sendSelect(taskId, on ? "description" : null)}
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
 * The description: edited live together when the realtime service is reachable,
 * otherwise (e.g. offline) the plain editor whose saves queue like any other edit.
 */
export function DescriptionField({ taskId, value }: { taskId: string; value: string }) {
  const me = useStore((s) => s.me);
  // Decided when the panel opens; a session that starts live survives disconnects (edits merge on reconnect).
  const [live] = useState(() => isRealtimeLive() && navigator.onLine);

  if (!live || !me) {
    // Explicit saves from the plain editor go on the undo stack like any other edit.
    return <PlainDescription taskId={taskId} saved={value} me={me ?? ""} onSave={(description) => dispatch({ type: "task.update", taskId, patch: { description } })} />;
  }
  // Autosaves are frequent, so they stay out of the app-wide undo stack (⌘Z in the editor undoes your own typing).
  const save = (description: string) => dispatch({ type: "task.update", taskId, patch: { description } }, { history: "skip" });
  return <CollabDescription taskId={taskId} saved={value} me={me} onSave={save} />;
}
