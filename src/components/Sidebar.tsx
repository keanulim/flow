"use client";

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { Thread } from "@/lib/db";
import type { VaultEntry } from "@/lib/vault";
import FileTree from "./FileTree";
import RenameInput from "./RenameInput";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

const SHARE_KEY = "flow.sidebar.listShare";
const DEFAULT_SHARE = 0.35; // the chat list's share of the height, above the map
const MIN_SHARE = 0.1;
const MAX_SHARE = 0.85;

// The Home / Chats / Files row.
const NAV = "flex h-9 items-center rounded-md text-sm";
const ON = "bg-hover text-fg";
const OFF = "text-muted hover:bg-hover hover:text-fg";

type Props = {
  /** The public demo: show a note that replies are simulated and changes are private and temporary. */
  demo?: boolean;
  /**
   * What the sidebar shows. "home": nothing below the buttons (Home is a page
   * of its own; a search still lists results). "files": the file tree.
   * "chats": New chat, the chat list and the map.
   */
  view: "home" | "chats" | "files";
  /** With view "home", which list a search shows. */
  filesSide: boolean;
  query: string;
  onQuery: (q: string) => void;
  onHome: () => void;
  onChats: () => void;
  /** The notes side, on the last note open there. */
  onFiles: () => void;
  onNewChat: () => void;
  onSettings: () => void;
  /** On Home: the vault's files and what to do with them. */
  files: VaultEntry[] | null;
  activeNote: string | null;
  fileActions: Pick<React.ComponentProps<typeof FileTree>, "onOpen" | "onCreate" | "onRename" | "onPlace" | "onDelete">;
  /** In chats: the conversation list (already filtered by search) and the map below it. */
  conversations: Thread[];
  searching: boolean;
  activeChat: string | null;
  onOpenChat: (id: string) => void;
  onChatMenu: (id: string, x: number, y: number) => void;
  /** The chat whose name is being edited (from its right-click menu), and what to do with the new name. */
  renamingChat: string | null;
  onRenameChat: (id: string, name: string | null) => void;
  map: ReactNode;
  mapRef: RefObject<HTMLDivElement | null>;
};

/** The left sidebar: search, a Home / Chats / Files row, then either the notes or (with New chat) the chat list and map. */
export default function Sidebar(p: Props) {
  // How much of the space below the buttons the chat list gets; the map gets the rest.
  const split = useRef<HTMLDivElement>(null);
  const [listShare, setListShare] = useState(DEFAULT_SHARE);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SHARE_KEY));
      if (saved >= MIN_SHARE && saved <= MAX_SHARE) setListShare(saved);
    } catch {}
  }, []);
  const saveShare = (share: number) => {
    setListShare(share);
    try {
      localStorage.setItem(SHARE_KEY, String(share));
    } catch {}
  };
  /** Drag the line between the chat list and the map. */
  const startResize = (e: React.PointerEvent) => {
    const box = split.current?.getBoundingClientRect();
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const shareAt = (y: number) => Math.min(MAX_SHARE, Math.max(MIN_SHARE, (y - box.top) / box.height));
    let latest = listShare;
    const move = (ev: PointerEvent) => setListShare((latest = shareAt(ev.clientY)));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      saveShare(latest);
    };
    document.body.style.cursor = "row-resize";
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return (
    <aside
      // In chats, clicking anywhere on the sidebar except its own buttons
      // enters map mode, so WASD works without aiming at a dot.
      onMouseDown={(e) => {
        // On Home there's no map: leave clicks alone (otherwise preventDefault
        // below would keep focus stuck in a file's rename box).
        if (p.filesSide || !p.mapRef.current || (e.target as Element).closest("[data-resize]")) return;
        const control = (e.target as Element).closest("button, a, input, textarea");
        if (control && !p.mapRef.current.contains(control)) return;
        e.preventDefault(); // no text selection, no focus flicker
        p.mapRef.current.focus();
      }}
      className="flex w-64 shrink-0 flex-col border-r border-line bg-panel"
    >
      <div className="px-3 pt-3 pb-1">
        <div className="relative">
          <svg
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Clear first, then leave the box. Don't let the app-wide Esc react.
                e.stopPropagation();
                if (p.query) p.onQuery("");
                else e.currentTarget.blur();
              } else if (e.key === "Enter" && !p.filesSide && p.conversations[0]) {
                p.onOpenChat(p.conversations[0].id);
              }
            }}
            placeholder="Search"
            aria-label={p.filesSide ? "Search files" : "Search chats"}
            className="w-full rounded-md border border-line bg-bg py-0.5 pr-2 pl-8 text-[13px] leading-5 outline-none placeholder:text-muted focus:border-line-strong"
          />
        </div>
        {/* Home, then Chats and Files as icons: one row */}
        <div className="mt-2 flex items-center gap-1">
          <button onClick={p.onHome} className={`${NAV} gap-2 px-2.5 ${p.view === "home" ? ON : OFF}`}>
            <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5H9.5v-4h-3v4H3a.5.5 0 0 1-.5-.5V7Z" />
            </svg>
            Home
          </button>
          <button onClick={p.onChats} className={`${NAV} w-9 justify-center ${p.view === "chats" ? ON : OFF}`} title="Chats" aria-label="Chats" aria-pressed={p.view === "chats"}>
            <svg className="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11H4a1.5 1.5 0 0 1-1.5-1.5V4Z" />
            </svg>
          </button>
          <button onClick={p.onFiles} className={`${NAV} w-9 justify-center ${p.view === "files" ? ON : OFF}`} title="Files" aria-label="Files" aria-pressed={p.view === "files"}>
            <svg className="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
            </svg>
          </button>
        </div>
        {p.view === "chats" && (
          <button onClick={p.onNewChat} className="mt-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted hover:bg-hover hover:text-fg">
            <span className="w-3.5 text-center text-base leading-none">+</span>
            New chat
          </button>
        )}
      </div>

      {p.view === "home" && !p.query.trim() ? null : p.filesSide ? (
        p.files && <FileTree entries={p.files} activePath={p.activeNote} filter={p.query} {...p.fileActions} />
      ) : (
        <div ref={split} className="flex min-h-0 flex-1 flex-col">
          {/* With a map, the list takes its share of the height (drag the line to change it); without one, all of it. */}
          <nav style={p.map ? { height: `${listShare * 100}%` } : undefined} className={`${p.map ? "shrink-0" : "min-h-0 flex-1"} overflow-y-auto px-2 pb-3`}>
            {p.searching && p.conversations.length === 0 && <p className="px-3 py-2 text-sm text-muted">No chats match “{p.query.trim()}”</p>}
            {p.conversations.map((c) =>
              c.id === p.renamingChat ? (
                <div key={c.id} className="flex px-2 py-1">
                  <RenameInput initial={c.title} onDone={(name) => p.onRenameChat(c.id, name)} className="px-1.5 py-0.5 leading-5" />
                </div>
              ) : (
                <button
                  key={c.id}
                  onClick={() => p.onOpenChat(c.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    p.onChatMenu(c.id, e.clientX, e.clientY);
                  }}
                  className={`block w-full truncate rounded-md px-3 py-1.5 text-left text-[13px] leading-5 ${
                    c.id === p.activeChat ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
                  }`}
                >
                  {c.title}
                </button>
              ),
            )}
          </nav>
          {p.map && (
            <>
              <div
                data-resize
                role="separator"
                aria-orientation="horizontal"
                title="Drag to resize · double-click to reset"
                onPointerDown={startResize}
                onDoubleClick={() => saveShare(DEFAULT_SHARE)}
                className="group relative h-3 shrink-0 cursor-row-resize"
              >
                <div className="absolute inset-x-0 top-1/2 h-px bg-line group-hover:h-0.5 group-hover:bg-line-strong" />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">{p.map}</div>
            </>
          )}
        </div>
      )}

      {p.demo && (
        <div className="mx-3 mt-auto mb-2 rounded-md border border-line px-2.5 py-2 text-[11px] leading-4 text-muted">
          <span className="font-medium text-fg">Demo.</span> AI replies are simulated. Your notes and chats are private to you and reset after a while.{" "}
          <a href="https://github.com/keanulim/flow" target="_blank" rel="noreferrer" className="underline hover:text-fg">
            Code
          </a>
        </div>
      )}
      <div className={`${p.demo ? "" : "mt-auto "}border-t border-line px-3 py-2`}>
        <button
          onClick={p.onSettings}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted hover:bg-hover hover:text-fg"
          title={`Settings (${MOD},)`}
        >
          <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="2" />
            <path d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.24 1.24M11.36 11.36l1.24 1.24M3.4 12.6l1.24-1.24M11.36 4.64l1.24-1.24" />
          </svg>
          Settings
        </button>
      </div>
    </aside>
  );
}
