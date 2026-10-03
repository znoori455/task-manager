"use client";
import { useState } from "react";

/**
 * Text input that keeps a local draft while focused and commits on blur/Enter.
 * While not being edited it follows the live value, so remote edits show up.
 */
export function EditableText({
  value,
  onCommit,
  className = "input w-full",
  multiline,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  const props = {
    className,
    placeholder,
    value: draft ?? value,
    onFocus: () => setDraft(value),
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
