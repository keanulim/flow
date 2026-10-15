"use client";

import { useEffect, useRef, useState } from "react";

export type MenuItem = { label: string; run: () => void; danger?: boolean; separator?: boolean };

/** A small menu at the pointer. Closes on a click elsewhere, Escape, scroll, or resize. */
export default function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    // Keep it on screen near the edges.
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.min(x, innerWidth - r.width - 8), top: Math.min(y, innerHeight - r.height - 8) });
    const close = (ev: Event) => {
      if (ev.type === "pointerdown" && ref.current?.contains(ev.target as Node)) return;
      onClose();
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key, true);
    };
  }, [x, y, onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={pos}
      className="fixed z-50 min-w-36 rounded-lg border border-line bg-bg p-1 text-sm shadow-lg"
    >
      {items.map((item) => (
        <div key={item.label}>
          {item.separator && <div className="my-1 border-t border-line" />}
          <button
            role="menuitem"
            onClick={() => {
              onClose();
              item.run();
            }}
            className={`block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-hover ${item.danger ? "text-danger" : "text-fg"}`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
