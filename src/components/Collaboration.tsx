"use client";
// Live collaboration UI: cursors pinned to tasks, selection outlines, typing indicators.
import { useMemo } from "react";
import { sendCursor, useOtherPeers, useRealtime } from "@/client/realtime";
import type { EditableField, Peer } from "@/contract/realtime";
import { colorFor } from "./ui";

/**
 * Mouse handlers for a task row/card: report the pointer as a fraction of the
 * element's box, so it lands on the same task for everyone regardless of
 * screen size or scroll position.
 */
export function cursorHandlers(taskId: string) {
  return {
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      sendCursor({ taskId, x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) });
    },
  };
}

/** Put on the scroll container: clears your cursor when the pointer leaves the tasks. */
export const clearCursorOnLeave = { onMouseLeave: () => sendCursor(null) };

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Other people's pointers over this task. Render inside a `relative` element. */
export function RemoteCursors({ taskId }: { taskId: string }) {
  const cursors = useRealtime((s) => s.cursors);
  const here = useMemo(() => Object.values(cursors).filter((c) => c.cursor?.taskId === taskId), [cursors, taskId]);
  if (!here.length) return null;
  return (
    <>
      {here.map(({ connId, name, cursor }) => (
        <span
          key={connId}
          data-testid="remote-cursor"
          className="pointer-events-none absolute z-10 transition-[left,top] duration-75 ease-linear"
          style={{ left: `${cursor!.x * 100}%`, top: `${cursor!.y * 100}%` }}
        >
          <svg width="14" height="16" viewBox="0 0 14 16" className="drop-shadow-sm">
            <path d="M1 1l11 6.5-5 1.2L4.5 14z" fill={colorFor(name)} stroke="white" strokeWidth="1.2" />
          </svg>
          <span className="ml-2.5 -mt-1 inline-block whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium text-white" style={{ background: colorFor(name) }}>
            {name}
          </span>
        </span>
      ))}
    </>
  );
}

/** People (other than this tab) who have this task open. */
export function usePeersOnTask(taskId: string): Peer[] {
  const others = useOtherPeers();
  return others.filter((p) => p.taskId === taskId);
}

/** Outline style for a row/card someone else has selected. */
export function selectionStyle(peers: Peer[]): React.CSSProperties | undefined {
  if (!peers.length) return undefined;
  return { boxShadow: `inset 0 0 0 2px ${colorFor(peers[0].name)}` };
}

/** "bob is editing" next to a field. */
export function EditingBy({ taskId, field }: { taskId: string; field: EditableField }) {
  const editors = usePeersOnTask(taskId).filter((p) => p.field === field);
  if (!editors.length) return null;
  const names = [...new Set(editors.map((p) => p.name))];
  return (
    <span className="ml-2 text-[11px] font-normal normal-case tracking-normal" style={{ color: colorFor(names[0]) }} data-testid={`editing-${field}`}>
      {names.join(", ")} {names.length === 1 ? "is" : "are"} editing…
    </span>
  );
}

export function TypingIndicator({ taskId }: { taskId: string }) {
  const typing = useRealtime((s) => s.typing[taskId]);
  const names = [...new Set(Object.values(typing ?? {}).map((t) => t.name))];
  if (!names.length) return null;
  return (
    <p className="text-xs italic text-zinc-500" data-testid="typing-indicator">
      {names.join(", ")} {names.length === 1 ? "is" : "are"} typing…
    </p>
  );
}
