"use client";

import { useEffect, useRef } from "react";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

const SHORTCUTS: { section: string; items: [keys: string, label: string][] }[] = [
  {
    section: "Chats",
    items: [
      [`${MOD}K`, "Ask on the side (about the highlight, or the latest reply)"],
      ["Esc", "Close the side panel, then go up a level"],
      ["⇧Esc", "Back to the main thread"],
      ["⌥↑  ⌥↓", "Switch side threads"],
      [`${MOD}\\`, "Show or hide the side panel"],
    ],
  },
  {
    section: "Map (click the sidebar first)",
    items: [
      ["W  S", "Previous / next sibling"],
      ["A", "Up to the parent"],
      ["D", "Down to the first child"],
      ["↵  Esc", "Back to the message box"],
    ],
  },
  {
    section: "Notes",
    items: [
      ["#  ##  ###", "Type at the start of a line, then a space, for a heading"],
      [`${MOD}K`, "On selected text: link it to a page (creates it). On a link: open it"],
      ["[[", "Link to a page or a chat; suggests your notes and chats"],
      [`${MOD}⌥←`, "Back to the note you came from"],
      ["/>", "At the start of a line: make it a toggle (collapsible)"],
      ["↵ on a title", "Open toggle: new first line inside. Closed: new line after it"],
      ["Tab  ⇧Tab", "Move the line after a toggle into it / a line inside out"],
      ["⌫ on an empty last line", "Step out of the toggle (⌫ again goes back in)"],
      ["Drag", "Move a note or folder into a folder"],
      ["Double-click", "Rename"],
    ],
  },
  {
    section: "General",
    items: [[`${MOD},`, "Open settings"]],
  },
];

/** The settings window. For now it holds the keyboard shortcut reference. */
export default function Settings({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // don't also trigger the chat's Esc
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-label="Settings"
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-line bg-bg shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button onClick={onClose} className="text-muted hover:text-fg" title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <h3 className="mb-3 text-xs font-medium tracking-wider text-muted uppercase">Keyboard shortcuts</h3>
          {SHORTCUTS.map(({ section, items }) => (
            <div key={section} className="mb-4">
              <div className="mb-1.5 text-sm font-medium">{section}</div>
              {items.map(([keys, label]) => (
                <div key={label} className="flex items-center justify-between gap-4 py-1 text-sm">
                  <span className="text-muted">{label}</span>
                  <kbd className="shrink-0 rounded border border-line bg-panel px-1.5 py-0.5 font-sans text-xs whitespace-pre text-fg">{keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
