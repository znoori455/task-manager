"use client";
// Shared, live description editor: CodeMirror bound to a Yjs draft, with
// everyone's carets. Loaded lazily (see DescriptionField) so CodeMirror and Yjs
// only download when a task panel opens.
import { defaultKeymap } from "@codemirror/commands";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { openDescriptionSession } from "@/client/collab";
import { sendSelect } from "@/client/realtime";
import { colorFor } from "./ui";

/** Save this long after you stop typing (and immediately on blur / close). */
const AUTOSAVE_MS = 1500;
/** If the shared draft hasn't loaded by then (service down, older service version), use the plain editor. */
const READY_TIMEOUT_MS = 5000;

const theme = EditorView.theme({
  "&": { fontSize: "14px", border: "1px solid #d4d4d8", borderRadius: "6px", background: "white" },
  "&.cm-focused": { outline: "none", borderColor: "#71717a", boxShadow: "0 0 0 2px #e4e4e7" },
  ".cm-content": { padding: "6px 10px", minHeight: "110px", fontFamily: "inherit", caretColor: "#18181b" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5" },
  ".cm-placeholder": { color: "#a1a1aa" },
  ".cm-ySelectionInfo": { fontFamily: "inherit", fontSize: "10px", padding: "1px 4px", opacity: "1", borderRadius: "3px" },
});

export default function CollabDescription({
  taskId,
  saved,
  me,
  onSave,
  onUnavailable,
}: {
  taskId: string;
  /** The saved description (seed for a new draft, and what autosave compares against). */
  saved: string;
  me: string;
  onSave: (text: string) => void;
  onUnavailable?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [resets, setResets] = useState(0);
  const [loading, setLoading] = useState(true);
  // Latest values for callbacks created once per session.
  const savedRef = useRef(saved);
  const onSaveRef = useRef(onSave);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    savedRef.current = saved;
    onSaveRef.current = onSave;
    onUnavailableRef.current = onUnavailable;
  });

  useEffect(() => {
    const session = openDescriptionSession(taskId, savedRef.current, { name: me, color: colorFor(me) }, () => setResets((n) => n + 1));
    let view: EditorView | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;

    // Only whoever typed saves; a remote edit never triggers a save here.
    const save = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!dirty) return;
      dirty = false;
      const value = session.text.toString();
      if (value !== savedRef.current) onSaveRef.current(value);
    };
    const observer = (_: unknown, tr: { local: boolean }) => {
      if (!tr.local) return;
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, AUTOSAVE_MS);
    };
    session.text.observe(observer);
    window.addEventListener("pagehide", save);

    let ready = false;
    const readyTimer = setTimeout(() => !ready && onUnavailableRef.current?.(), READY_TIMEOUT_MS);
    void session.ready.then(() => {
      ready = true;
      clearTimeout(readyTimer);
      if (!host.current) return;
      setLoading(false);
      view = new EditorView({
        parent: host.current,
        extensions: [
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          yCollab(session.text, session.awareness),
          EditorView.lineWrapping,
          placeholder("Add a description…"),
          theme,
          EditorView.domEventHandlers({
            focus: () => void sendSelect(taskId, "description"),
            blur: () => {
              sendSelect(taskId, null);
              save();
            },
          }),
        ],
        doc: session.text.toString(),
      });
    });

    return () => {
      clearTimeout(readyTimer);
      save();
      window.removeEventListener("pagehide", save);
      session.text.unobserve(observer);
      view?.destroy();
      session.destroy();
    };
  }, [taskId, me, resets]);

  return (
    <div data-testid="collab-description">
      {loading && <div className="h-[124px] animate-pulse rounded-md border border-zinc-200 bg-zinc-50" />}
      <div ref={host} />
    </div>
  );
}
