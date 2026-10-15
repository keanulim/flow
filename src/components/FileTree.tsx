"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultEntry } from "@/lib/vault";

type Props = {
  entries: VaultEntry[];
  activePath: string | null;
  filter: string; // from the sidebar search box
  onOpen: (path: string) => void;
  onCreate: (parent: string, type: "file" | "folder") => Promise<string | null>; // returns the new path
  onRename: (path: string, newName: string) => Promise<void>;
  onMove: (path: string, toFolder: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
};

const EXPANDED_KEY = "flow.files.expanded";
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const label = (e: VaultEntry) => (e.type === "file" ? e.name.replace(/\.md$/i, "") : e.name);

/**
 * The vault as a folder tree, Obsidian style: click to open, drag onto a folder
 * (or the empty area for the top level) to move. Right-click for rename and
 * delete (to the vault's .trash), and on folders or the empty area, new note /
 * new folder. Double-click also renames. Clicking a folder selects it as the
 * place new notes and folders go; each folder also has its own "+".
 */
export default function FileTree({ entries, activePath, filter, onOpen, onCreate, onRename, onMove, onDelete }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder path, "" = top level
  // Where new items go: a clicked folder, "" for the top level, or null = follow the open note.
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);
  // Right-click menu: for an entry, or (entry null) for the empty area = the top level.
  const [menu, setMenu] = useState<{ entry: VaultEntry | null; x: number; y: number } | null>(null);

  // Remember open folders across visits (read after mount: no localStorage on the server).
  useEffect(() => {
    try {
      setExpanded(new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]")));
    } catch {}
  }, []);
  const setOpen = (path: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });

  // Keep the open note's folders expanded so it's visible.
  useEffect(() => {
    if (!activePath) return;
    for (let p = parentOf(activePath); p; p = parentOf(p)) if (!expanded.has(p)) setOpen(p, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // New items go into the selected folder, else the open note's folder, else the top level.
  const targetFolder = selectedFolder ?? (activePath ? parentOf(activePath) : "");
  const create = async (type: "file" | "folder", parent = targetFolder) => {
    const path = await onCreate(parent, type);
    if (!path) return;
    if (parent) setOpen(parent, true);
    setRenaming(path); // name it right away
  };

  const remove = (e: VaultEntry) => {
    if (e.type === "folder" && e.children.length && !confirm(`Move the folder “${e.name}” and everything in it to the trash?`)) return;
    void onDelete(e.path);
  };

  // Search: a flat list of notes whose name or folder matches.
  const q = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    const out: VaultEntry[] = [];
    const walk = (list: VaultEntry[]) =>
      list.forEach((e) => (e.type === "folder" ? walk(e.children) : e.path.toLowerCase().includes(q) && out.push(e)));
    walk(entries);
    return out;
  }, [entries, q]);

  // ---- Dragging, with pointer events instead of the browser's HTML5 drag and
  // drop, which behaves differently per browser and often never starts.
  const press = useRef<{ path: string; name: string; x: number; y: number; active: boolean } | null>(null);
  const target = useRef<string | null>(null); // mirrors dropTarget for the pointerup handler
  const suppressClick = useRef(false); // the click that ends a drag shouldn't open the row
  const hoverOpen = useRef<{ folder: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef({ onMove, setOpen });
  latest.current = { onMove, setOpen };

  useEffect(() => {
    const setTarget = (t: string | null) => {
      target.current = t;
      setDropTarget(t);
      // Hovering a closed folder for a moment opens it, so you can drop deeper.
      if (hoverOpen.current?.folder !== t) {
        if (hoverOpen.current) clearTimeout(hoverOpen.current.timer);
        hoverOpen.current = t ? { folder: t, timer: setTimeout(() => latest.current.setOpen(t, true), 600) } : null;
      }
    };
    const end = () => {
      press.current = null;
      setGhost(null);
      setTarget(null);
      document.body.style.cursor = "";
    };
    const onMovePointer = (ev: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.active) {
        if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 5) return; // still a click
        p.active = true;
        document.body.style.cursor = "grabbing";
        window.getSelection()?.removeAllRanges();
      }
      setGhost({ name: p.name, x: ev.clientX, y: ev.clientY });
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const folder = el?.closest<HTMLElement>("[data-folder-path]")?.dataset.folderPath;
      let t = folder ?? (el?.closest("[data-file-tree]") ? "" : null);
      if (t !== null && (t === p.path || t.startsWith(p.path + "/"))) t = null; // not into itself
      setTarget(t);
    };
    const onUp = () => {
      const p = press.current;
      const t = target.current;
      if (p?.active) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        if (t !== null && parentOf(p.path) !== t) {
          void latest.current.onMove(p.path, t).then(() => t && latest.current.setOpen(t, true));
        }
      }
      end();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && press.current?.active) {
        ev.stopPropagation();
        end();
      }
    };
    window.addEventListener("pointermove", onMovePointer);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMovePointer);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const row = (e: VaultEntry, depth: number) => {
    const isFolder = e.type === "folder";
    const open = isFolder && expanded.has(e.path);
    return (
      <div key={e.path}>
        <div
          data-folder-path={isFolder ? e.path : undefined}
          onPointerDown={(ev) => {
            if (ev.button !== 0 || renaming === e.path || (ev.target as Element).closest("button, input")) return;
            press.current = { path: e.path, name: label(e), x: ev.clientX, y: ev.clientY, active: false };
          }}
          onClick={() => {
            if (suppressClick.current) return;
            if (isFolder) {
              setOpen(e.path, !open);
              setSelectedFolder(e.path);
            } else {
              setSelectedFolder(null);
              onOpen(e.path);
            }
          }}
          onDoubleClick={() => setRenaming(e.path)}
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setMenu({ entry: e, x: ev.clientX, y: ev.clientY });
          }}
          style={{ paddingLeft: 10 + depth * 14 }}
          className={`group flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-sm ${
            dropTarget === e.path
              ? "bg-hover text-fg ring-1 ring-stone-400"
              : e.path === activePath || (isFolder && e.path === selectedFolder)
                ? "bg-hover text-fg"
                : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          <span className="flex w-4 shrink-0 justify-center text-muted">
            {isFolder && (
              <svg
                className={`size-3.5 ${open ? "rotate-90" : ""}`}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 3.5 10.5 8 6 12.5" />
              </svg>
            )}
          </span>
          {renaming === e.path ? (
            <RenameInput
              initial={label(e)}
              onDone={async (name) => {
                setRenaming(null);
                if (name && name !== label(e)) await onRename(e.path, name);
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{label(e)}</span>
          )}
          {renaming !== e.path && isFolder && (
            <span className="hidden shrink-0 group-hover:flex">
              <IconButton title={`New note in ${e.name}`} onClick={() => void create("file", e.path)}>
                +
              </IconButton>
            </span>
          )}
        </div>
        {open && e.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-xs font-medium tracking-wider text-muted uppercase">Files</span>
        <span className="flex gap-0.5">
          <IconButton title={`New note${targetFolder ? ` in ${targetFolder}` : ""}`} onClick={() => void create("file")}>
            <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5L9 2Z M9 2v3.5h3.5 M8 8v4 M6 10h4" />
            </svg>
          </IconButton>
          <IconButton title={`New folder${targetFolder ? ` in ${targetFolder}` : ""}`} onClick={() => void create("folder")}>
            <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z M8 7v4 M6 9h4" />
            </svg>
          </IconButton>
        </span>
      </div>

      {/* The empty area is the drop target for "move to the top level";
          clicking it makes the top level the place new items go. */}
      <div
        data-file-tree
        className={`min-h-0 flex-1 overflow-y-auto px-2 pb-3 select-none ${dropTarget === "" ? "bg-hover/50" : ""}`}
        onClick={(ev) => {
          if (ev.target === ev.currentTarget) setSelectedFolder("");
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenu({ entry: null, x: ev.clientX, y: ev.clientY });
        }}
      >
        {matches ? (
          matches.length ? (
            matches.map((e) => (
              <div
                key={e.path}
                onClick={() => onOpen(e.path)}
                className={`cursor-pointer rounded-md px-2.5 py-1.5 text-sm ${e.path === activePath ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"}`}
              >
                <div className="truncate">{label(e)}</div>
                {parentOf(e.path) && <div className="truncate text-[11px] text-muted">{parentOf(e.path)}</div>}
              </div>
            ))
          ) : (
            <p className="px-3 py-2 text-sm text-muted">No notes match “{filter.trim()}”</p>
          )
        ) : entries.length ? (
          entries.map((e) => row(e, 0))
        ) : (
          <p className="px-3 py-2 text-sm text-muted">No notes yet. Create one with the buttons above.</p>
        )}
      </div>
      {ghost && <DragGhost {...ghost} />}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(menu.entry === null || menu.entry.type === "folder"
              ? [
                  { label: "New note", run: () => void create("file", menu.entry?.path ?? "") },
                  { label: "New folder", run: () => void create("folder", menu.entry?.path ?? "") },
                ]
              : []),
            ...(menu.entry
              ? [
                  { label: "Rename", run: () => setRenaming(menu.entry!.path), separator: menu.entry.type === "folder" },
                  { label: "Delete", run: () => remove(menu.entry!), danger: true },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}

type MenuItem = { label: string; run: () => void; danger?: boolean; separator?: boolean };

/** A small menu at the pointer. Closes on a click elsewhere, Escape, scroll, or resize. */
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
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
            className={`block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-hover ${item.danger ? "text-red-600" : "text-fg"}`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

function DragGhost({ name, x, y }: { name: string; x: number; y: number }) {
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-md border border-line bg-bg px-2 py-1 text-xs text-fg shadow-md"
      style={{ left: x + 12, top: y + 8 }}
    >
      {name}
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
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
      className="min-w-0 flex-1 rounded border border-stone-300 bg-bg px-1 py-0 text-sm text-fg outline-none"
    />
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-6 items-center justify-center rounded text-xs text-muted hover:bg-stone-200/60 hover:text-fg"
    >
      {children}
    </button>
  );
}
