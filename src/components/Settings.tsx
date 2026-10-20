"use client";

import { useEffect, useRef, useState } from "react";
import { currentTheme, setTheme, THEMES, type ThemeId } from "@/lib/theme";
import { WEB_SEARCH_KEY } from "@/lib/shared";

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
      ["Right-click a chat", "Rename it, or delete it with all its branches and side questions"],
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
      [`${MOD}K`, "On selected text: link it to a page, a chat or a web address, or make a new page (same as right-click → Link to…). On a link: open it"],
      ["[[", "Link to a page or a chat; suggests your notes and chats"],
      ["Right-click → Add note…", "On selected text: write a note about it. Click the highlighted words to see, edit or remove it"],
      [`${MOD}⌥←`, "Back to the note you came from"],
      ["/>", "At the start of a line: make it a toggle (collapsible)"],
      ["↵ on a title", "Open toggle: new first line inside. Closed: new line after it"],
      ["Tab  ⇧Tab", "Move the line after a toggle into it / a line inside out"],
      ["⌫ on an empty last line", "Step out of the toggle (⌫ again goes back in)"],
      ["Drag", "Move a note or folder into a folder"],
      ["Right-click", "Rename, delete, or add a note or folder"],
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
          <Appearance />
          <AiSettings />
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

/** The color themes (see lib/theme.ts). Applies immediately and is remembered on this device. */
function Appearance() {
  const [theme, pick] = useState<ThemeId>(currentTheme);
  return (
    <section className="mb-6">
      <h3 className="mb-3 text-xs font-medium tracking-wider text-muted uppercase">Appearance</h3>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
        {THEMES.map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={theme === t.id}
            onClick={() => {
              setTheme(t.id);
              pick(t.id);
            }}
            className={`rounded-lg border p-2 text-left text-sm ${theme === t.id ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-strong"}`}
          >
            {/* A tiny preview of the page and its text */}
            <span className="mb-2 flex h-10 flex-col justify-center gap-1 rounded-md border border-line px-2" style={{ background: t.swatch[0] }}>
              <span className="block h-1 w-3/4 rounded-full" style={{ background: t.swatch[1] }} />
              <span className="block h-1 w-1/2 rounded-full opacity-50" style={{ background: t.swatch[1] }} />
            </span>
            {t.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Whether the model may search the web. Remembered on this device; read when a message is sent. */
function AiSettings() {
  const [webSearch, setWebSearch] = useState(() => {
    try {
      return localStorage.getItem(WEB_SEARCH_KEY) !== "off";
    } catch {
      return true;
    }
  });
  return (
    <section className="mb-6">
      <h3 className="mb-3 text-xs font-medium tracking-wider text-muted uppercase">AI</h3>
      <label className="flex cursor-pointer items-start justify-between gap-4 text-sm">
        <span>
          <span className="block">Search the web</span>
          <span className="block text-xs text-muted">Lets replies look things up and read pages, with sources. Each search costs about a cent.</span>
        </span>
        <input
          type="checkbox"
          checked={webSearch}
          onChange={(e) => {
            setWebSearch(e.target.checked);
            try {
              localStorage.setItem(WEB_SEARCH_KEY, e.target.checked ? "on" : "off");
            } catch {}
          }}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        />
      </label>
    </section>
  );
}
