"use client";
import { useState } from "react";

/**
 * Text input that commits on blur/Enter. It follows the live value until you
 * start typing (even while focused), so remote edits keep showing up; from the
 * first keystroke it keeps your draft until you commit or press Escape.
 */
export function EditableText({
  value,
  onCommit,
  className = "input w-full",
  multiline,
  placeholder,
  onEditing,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
  /** Called on focus/blur, e.g. to show others "bob is editing…". */
  onEditing?: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
    onEditing?.(false);
  };
  const props = {
    className,
    placeholder,
    value: draft ?? value,
    onFocus: () => onEditing?.(true),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft(null);
        (e.target as HTMLElement).blur();
      }
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) (e.target as HTMLElement).blur();
    },
  };
  return multiline ? <textarea rows={5} {...props} /> : <input {...props} />;
}
