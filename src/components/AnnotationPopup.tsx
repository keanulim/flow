"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  /** Where to show it (under the words), in viewport pixels. */
  x: number;
  y: number;
  /** The note's text; empty for a new note. */
  note: string;
  /** Start in the text box (a new note), rather than showing the note. */
  editing: boolean;
  /** The note can't be changed (the note is being written live). */
  readOnly?: boolean;
  onSave: (note: string) => void;
  /** Only for an existing note. */
  onRemove?: () => void;
  onClose: () => void;
};

/**
 * A note about some highlighted words: shows it, and lets you edit or remove
 * it. For a new note, it opens straight into the text box.
 * ↵ saves (⇧↵ for a new line), Esc closes.
 */
export default function AnnotationPopup({ x, y, note, editing: startEditing, readOnly, onSave, onRemove, onClose }: Props) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(note);
  const box = useRef<HTMLDivElement>(null);

  // Focus the popup itself (not a button, which would show a focus ring), so Esc works right away.
  useEffect(() => {
    if (!startEditing) box.current?.focus();
  }, [startEditing]);

  // Click outside closes it (a draft that was never saved is dropped).
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - 312));
  const top = Math.min(y, window.innerHeight - 200);
  const save = () => (draft.trim() ? onSave(draft) : onClose());

  return (
    <div
      ref={box}
      style={{ left, top }}
      tabIndex={-1}
      className="fixed z-50 w-72 rounded-lg border border-line bg-bg p-3 text-sm shadow-lg outline-none"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation(); // don't also close panels elsewhere in the app
          onClose();
        }
      }}
    >
      {editing ? (
        <>
          <textarea
            autoFocus
            value={draft}
            rows={3}
            placeholder="Write a note about this…"
            // Editing an existing note: start with the cursor at its end, not the beginning.
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
            }}
            className="w-full resize-none rounded-md border border-line bg-bg px-2.5 py-2 outline-none placeholder:text-muted focus:border-line-strong"
          />
          <div className="mt-2 flex items-center justify-end gap-2 text-xs">
            <button onClick={onClose} className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg">
              Cancel
            </button>
            <button onClick={save} disabled={!draft.trim()} className="rounded-md border border-line px-2 py-1 hover:border-line-strong disabled:opacity-40">
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap">{note || <span className="text-muted">This note is missing.</span>}</p>
          {!readOnly && (
            <div className="mt-2.5 flex items-center justify-end gap-1 text-xs">
              {onRemove && (
                <button onClick={onRemove} className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-danger" title="Remove the note (the words stay)">
                  Remove
                </button>
              )}
              <button
                onClick={() => {
                  setDraft(note);
                  setEditing(true);
                }}
                className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg"
              >
                Edit
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
