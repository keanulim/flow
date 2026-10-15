"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An inline name box (files, chats). The whole name starts selected, so typing
 * replaces it. Enter or clicking away saves; Esc cancels (onDone(null)).
 */
export default function RenameInput({ initial, onDone, className = "" }: { initial: string; onDone: (name: string | null) => void; className?: string }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // Focus and select the whole name on mount, so typing replaces it.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return; // Enter then blur would otherwise submit twice
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={input}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep app-wide shortcuts (Esc) out of it
        if (e.key === "Enter") finish(value.trim());
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value.trim())}
      className={`min-w-0 flex-1 rounded border border-line-strong bg-bg px-1 py-0 text-[13px] text-fg outline-none ${className}`}
    />
  );
}
