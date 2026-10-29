"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultEntry } from "@/lib/vault";
import ContextMenu from "./ContextMenu";
import RenameInput from "./RenameInput";

type Props = {
  entries: VaultEntry[];
  activePath: string | null;
  filter: string; // from the sidebar search box
  onOpen: (path: string) => void;
  /** Open a note in a new tab (double-click, or right-click → Open in new tab). */
  onOpenInTab: (path: string) => void;
  onCreate: (parent: string, type: "file" | "folder") => Promise<string | null>; // returns the new path
  onRename: (path: string, newName: string) => Promise<void>;
  /** Put entries in `folder` ("" = top level), just before the item named `before` (null = at the end), in this order. */
  onPlace: (paths: string[], folder: string, before: string | null) => Promise<void>;
  /** Move entries to the trash. */
  onDelete: (paths: string[]) => Promise<void>;
};

const EXPANDED_KEY = "flow.files.expanded";
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
/** Notes are shown without their .md ending. */
const label = (e: VaultEntry) => (e.type === "file" ? e.name.replace(/\.md$/i, "") : e.name);

/**
 * The vault's notes as a folder tree (images aren't listed), Obsidian style: click to open (double-click:
 * in a new tab), drag to arrange
 * (between rows, or into a folder; the empty area is the end of the top level). Right-click for rename and
 * delete (to the vault's .trash), and on folders or the empty area, new note /
 * new folder. Clicking a folder selects it as the
 * place new notes and folders go; each folder also has its own "+".
 *
 * Several at once: click one, then shift-click another to select everything
 * between them (as shown, open folders' contents included), or ⌘/Ctrl-click
 * to add or remove one. Drag any selected row to move them all; right-click
 * one to delete them all. Esc or a click on the empty area clears it.
 */
export default function FileTree({ entries: all, activePath, filter, onOpen, onOpenInTab, onCreate, onRename, onPlace, onDelete }: Props) {
  // Notes and folders only: images live in the vault for the notes that show them, but aren't listed.
  const entries = useMemo(() => notesOnly(all), [all]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  // While dragging: a line above/below a row (where it'll go), or a folder it'll go into ("" = the top level).
  const [dropTarget, setDropTarget] = useState<Drop | null>(null);
  // Where new items go: a clicked folder, "" for the top level, or null = follow the open note.
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);
  // Right-click menu: for an entry, or (entry null) for the empty area = the top level.
  const [menu, setMenu] = useState<{ entry: VaultEntry | null; x: number; y: number } | null>(null);
  // Several rows selected at once (shift-click a range, ⌘-click one more); `anchor` is where a range starts.
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

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
    void onDelete([e.path]);
  };

  /** The rows as shown, top to bottom (open folders' contents included): the order a shift-click range follows. */
  const shown = useMemo(() => visibleRows(entries, expanded), [entries, expanded]);

  /** Click (select this one), shift-click (everything from the anchor to here), ⌘-click (add or remove this one). */
  const select = (path: string, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const from = anchor.current ?? activePath; // no row clicked yet: the range starts at the open note
    if (ev.shiftKey && from && shown.includes(from)) {
      const [a, b] = [shown.indexOf(from), shown.indexOf(path)].sort((x, y) => x - y);
      setSelection(new Set(shown.slice(a, b + 1)));
      return "range";
    }
    if (ev.metaKey || ev.ctrlKey) {
      setSelection((sel) => {
        const next = new Set(sel.size ? sel : activePath ? [activePath] : []);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      anchor.current = path;
      return "toggle";
    }
    setSelection(new Set([path]));
    anchor.current = path;
    return "one";
  };
  const multi = selection.size > 1;

  /** Right-click → Delete N items. */
  const removeSelected = () => {
    const paths = topLevel(selection, shown);
    const folders = paths.filter((p) => entryAt(entries, p)?.type === "folder").length;
    const what = `${items(paths.length)}${folders ? ` (${folders === 1 ? "a folder" : "folders"} with everything in ${folders === 1 ? "it" : "them"})` : ""}`;
    if (!confirm(`Move ${what} to the trash?`)) return;
    setSelection(new Set());
    void onDelete(paths);
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
  // The row pressed, and once the drag starts, everything it carries (the selection, if it's part of it).
  const press = useRef<{ path: string; name: string; x: number; y: number; active: boolean; paths: string[] } | null>(null);
  const target = useRef<Drop | null>(null); // mirrors dropTarget for the pointerup handler
  const suppressClick = useRef(false); // the click that ends a drag shouldn't open the row
  const hoverOpen = useRef<{ folder: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef({ onPlace, setOpen, entries, expanded, selection, shown });
  latest.current = { onPlace, setOpen, entries, expanded, selection, shown };

  useEffect(() => {
    const setTarget = (t: Drop | null) => {
      target.current = t;
      setDropTarget((old) => (JSON.stringify(old) === JSON.stringify(t) ? old : t));
      // Hovering over a closed folder for a moment opens it, so you can drop deeper.
      const folder = t?.kind === "into" ? t.folder : null;
      if (hoverOpen.current?.folder !== folder) {
        if (hoverOpen.current) clearTimeout(hoverOpen.current.timer);
        hoverOpen.current = folder ? { folder, timer: setTimeout(() => latest.current.setOpen(folder, true), 600) } : null;
      }
    };
    // Holding near the top or bottom of the list while dragging scrolls it, so you can reach spots out of view.
    let scrollTimer: ReturnType<typeof setInterval> | null = null;
    let lastPointer = { x: 0, y: 0 };
    const autoScroll = (y: number) => {
      const list = document.querySelector<HTMLElement>("[data-file-tree]");
      const box = list?.getBoundingClientRect();
      const EDGE = 36;
      const speed = !box ? 0 : y < box.top + EDGE ? -(box.top + EDGE - y) / 3 : y > box.bottom - EDGE ? (y - (box.bottom - EDGE)) / 3 : 0;
      if (!speed || !list) {
        if (scrollTimer) clearInterval(scrollTimer);
        scrollTimer = null;
        return;
      }
      if (scrollTimer) clearInterval(scrollTimer);
      scrollTimer = setInterval(() => {
        list.scrollTop += Math.max(-14, Math.min(14, speed));
        aim(lastPointer.x, lastPointer.y); // what's under the pointer changed
      }, 16);
    };
    const end = () => {
      if (scrollTimer) clearInterval(scrollTimer);
      scrollTimer = null;
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
        // Dragging a selected row carries the whole selection; any other row, just itself.
        const { selection: sel, shown: rows } = latest.current;
        p.paths = sel.size > 1 && sel.has(p.path) ? topLevel(sel, rows) : [p.path];
      }
      setGhost({ name: p.paths.length > 1 ? items(p.paths.length) : p.name, x: ev.clientX, y: ev.clientY });
      lastPointer = { x: ev.clientX, y: ev.clientY };
      aim(ev.clientX, ev.clientY);
      autoScroll(ev.clientY);
    };
    /** The drop spot under the pointer: above/below a row, into a folder, or the end of the top level. */
    const aim = (x: number, y: number) => {
      const p = press.current;
      if (!p?.active) return;
      const el = document.elementFromPoint(x, y);
      const rowEl = el?.closest<HTMLElement>("[data-entry-path]");
      let t: Drop | null = null;
      if (rowEl) {
        // Where on the row: top or bottom edge = above or below it; a folder's middle = into it.
        const path = rowEl.dataset.entryPath!;
        const isFolder = rowEl.dataset.entryType === "folder";
        const r = rowEl.getBoundingClientRect();
        const f = (y - r.top) / r.height;
        t = isFolder && f > 0.25 && f < 0.75 ? { kind: "into", folder: path } : { kind: "line", path, edge: f < 0.5 ? "top" : "bottom" };
      } else if (el?.closest("[data-file-tree]")) {
        t = { kind: "into", folder: "" }; // the empty area: the end of the top level
      }
      // Not into anything being dragged, or a folder inside it.
      const dest = t && placement(t, latest.current.entries, latest.current.expanded).folder;
      if (dest !== null && dest !== undefined && p.paths.some((m) => dest === m || dest.startsWith(m + "/"))) t = null;
      if (t?.kind === "line" && p.paths.includes(t.path)) t = null; // next to itself: nowhere to go
      setTarget(t);
    };
    const onUp = () => {
      const p = press.current;
      const t = target.current;
      if (p?.active) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        if (t) {
          const placed = placement(t, latest.current.entries, latest.current.expanded);
          const { folder } = placed;
          let { before } = placed;
          const siblings = childrenOf(latest.current.entries, folder).map((e) => e.name);
          // "Before" one of the dragged items: before the first item after it that stays put.
          const moving = new Set(p.paths.filter((m) => parentOf(m) === folder).map((m) => m.split("/").pop()!));
          if (before !== null && moving.has(before)) before = siblings.slice(siblings.indexOf(before)).find((n) => !moving.has(n)) ?? null;
          const name = p.path.split("/").pop()!;
          const here = p.paths.length === 1 && parentOf(p.path) === folder && (before === name || siblings[siblings.indexOf(name) + 1] === (before ?? undefined));
          if (!here) {
            if (p.paths.length > 1) setSelection(new Set()); // their paths change as they move
            void latest.current.onPlace(p.paths, folder, before).then(() => folder && latest.current.setOpen(folder, true));
          }
        }
      }
      end();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (press.current?.active) {
        ev.stopPropagation();
        end();
      } else if (latest.current.selection.size > 1 && !(ev.target as Element)?.closest?.("input, textarea, [contenteditable]")) {
        setSelection(new Set()); // Esc clears a multi-selection
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
          data-entry-path={e.path}
          data-entry-type={e.type}
          onPointerDown={(ev) => {
            if (ev.button !== 0 || renaming === e.path || (ev.target as Element).closest("button, input")) return;
            press.current = { path: e.path, name: label(e), x: ev.clientX, y: ev.clientY, active: false, paths: [e.path] };
          }}
          onClick={(ev) => {
            if (suppressClick.current) return;
            if (select(e.path, ev) !== "one") return; // shift/⌘-click only changes the selection
            if (isFolder) {
              setOpen(e.path, !open);
              setSelectedFolder(e.path);
            } else {
              setSelectedFolder(null);
              onOpen(e.path);
            }
          }}
          onDoubleClick={(ev) => {
            if (!isFolder && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) onOpenInTab(e.path);
          }}
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            // On a row outside the selection, the menu is for just that row.
            if (!selection.has(e.path)) {
              setSelection(new Set([e.path]));
              anchor.current = e.path;
            }
            setMenu({ entry: e, x: ev.clientX, y: ev.clientY });
          }}
          style={{ paddingLeft: 10 + depth * 14 }}
          className={`group relative flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-[13px] leading-5 ${
            dropTarget?.kind === "into" && dropTarget.folder === e.path
              ? "bg-hover text-fg ring-1 ring-line-strong"
              : (multi && selection.has(e.path)) || e.path === activePath || (isFolder && e.path === selectedFolder)
                ? "bg-hover text-fg"
                : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          {dropTarget?.kind === "line" && dropTarget.path === e.path && (
            // Where the dragged item will go: a line above or below this row, at its indent.
            <span
              className={`pointer-events-none absolute right-1 h-0.5 rounded-full bg-line-strong ${dropTarget.edge === "top" ? "-top-px" : "-bottom-px"}`}
              style={{ left: 10 + depth * 14 }}
            />
          )}
          <span className="flex w-4 shrink-0 justify-center text-muted">
            {isFolder && <Chevron open={open} />}
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
        className={`min-h-0 flex-1 overflow-y-auto px-2 pb-3 select-none ${dropTarget?.kind === "into" && dropTarget.folder === "" ? "bg-hover/50" : ""}`}
        onClick={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          setSelectedFolder("");
          setSelection(new Set());
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
                onDoubleClick={() => onOpenInTab(e.path)}
                className={`cursor-pointer rounded-md px-2.5 py-1.5 text-[13px] leading-5 ${e.path === activePath ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"}`}
              >
                <div className="truncate">{label(e)}</div>
                {parentOf(e.path) && <div className="truncate text-[11px] text-muted">{parentOf(e.path)}</div>}
              </div>
            ))
          ) : (
            <p className="px-3 py-2 text-sm text-muted">Nothing matches “{filter.trim()}”</p>
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
          items={
            menu.entry && multi && selection.has(menu.entry.path)
              ? [{ label: `Delete ${items(topLevel(selection, shown).length)}`, run: removeSelected, danger: true }]
              : [
            ...(menu.entry === null || menu.entry.type === "folder"
              ? [
                  { label: "New note", run: () => void create("file", menu.entry?.path ?? "") },
                  { label: "New folder", run: () => void create("folder", menu.entry?.path ?? "") },
                ]
              : []),
            ...(menu.entry?.type === "file" ? [{ label: "Open in new tab", run: () => onOpenInTab(menu.entry!.path) }] : []),
            ...(menu.entry
              ? [
                  { label: "Rename", run: () => setRenaming(menu.entry!.path), separator: true },
                  { label: "Delete", run: () => remove(menu.entry!), danger: true },
                ]
              : []),
                ]
          }
        />
      )}
    </div>
  );
}

/**
 * The folder arrow. Its style goes with the theme, picked in CSS (globals.css,
 * .chevron-*), so switching themes needs no re-render: sharp corners by default,
 * soft rounded ones in Mocha and Rosé, pixels in Neon.
 */
function Chevron({ open }: { open: boolean }) {
  return (
    <>
      <svg className={`chevron-sharp size-3 ${open ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="butt" strokeLinejoin="miter" aria-hidden="true">
        <path d="M6 3.5 10.5 8 6 12.5" />
      </svg>
      <svg className={`chevron-soft size-3 ${open ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3.5 10.5 8 6 12.5" />
      </svg>
      <PixelChevron open={open} />
    </>
  );
}

/**
 * Neon's folder arrow, drawn in pixels to match the lambda icon: five 2×2px
 * blocks making a ">" (or "v" when open), in a 10×10px box. crispEdges turns
 * off antialiasing. Open is drawn, not rotated, so it stays on whole pixels.
 */
function PixelChevron({ open }: { open: boolean }) {
  // One block per row, stepping right then back; shifted to the middle of the 5×5 grid.
  const right = [[0, 0], [1, 1], [2, 2], [1, 3], [0, 4]].map(([x, y]) => [x + 1, y]);
  const cells = open ? right.map(([x, y]) => [y, x]) : right; // flipped across the diagonal: "v"
  return (
    <svg className="chevron-pixel" width="10" height="10" viewBox="0 0 5 5" shapeRendering="crispEdges" fill="currentColor" aria-hidden="true">
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />
      ))}
    </svg>
  );
}

/** The tree without images (or any other non-note files). */
function notesOnly(entries: VaultEntry[]): VaultEntry[] {
  return entries.flatMap<VaultEntry>((e) => (e.type === "folder" ? [{ ...e, children: notesOnly(e.children) }] : /\.md$/i.test(e.name) ? [e] : []));
}

const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

/** Every row's path as shown, top to bottom: folders, then (if open) their contents. */
function visibleRows(entries: VaultEntry[], expanded: Set<string>): string[] {
  return entries.flatMap((e) => [e.path, ...(e.type === "folder" && expanded.has(e.path) ? visibleRows(e.children, expanded) : [])]);
}

/** Selected paths without any that sit inside another selected folder (they go with it), in shown order. */
function topLevel(selection: Set<string>, shown: string[]): string[] {
  const all = [...selection];
  const outer = all.filter((p) => !all.some((q) => q !== p && p.startsWith(q + "/")));
  return outer.sort((a, b) => shown.indexOf(a) - shown.indexOf(b));
}

/** The entry at a path, or undefined. */
function entryAt(entries: VaultEntry[], path: string): VaultEntry | undefined {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.type === "folder" && path.startsWith(e.path + "/")) return entryAt(e.children, path);
  }
  return undefined;
}

/** A drop spot while dragging: a line above/below a row, or into a folder ("" = the top level). */
type Drop = { kind: "line"; path: string; edge: "top" | "bottom" } | { kind: "into"; folder: string };

/** A folder's entries, in tree order ("" = the top level). */
function childrenOf(entries: VaultEntry[], folder: string): VaultEntry[] {
  let list = entries;
  for (const part of folder ? folder.split("/") : []) {
    const next = list.find((e) => e.type === "folder" && e.name === part);
    list = next?.type === "folder" ? next.children : [];
  }
  return list;
}

/**
 * Where a drop spot puts the item: which folder, and before which item (null = at the end).
 * Below an open folder is its first item, since that's what sits right under it.
 */
function placement(t: Drop, entries: VaultEntry[], expanded: Set<string>): { folder: string; before: string | null } {
  if (t.kind === "into") return { folder: t.folder, before: null };
  const folder = parentOf(t.path);
  const siblings = childrenOf(entries, folder);
  const i = siblings.findIndex((e) => e.path === t.path);
  if (t.edge === "top") return { folder, before: siblings[i]?.name ?? null };
  const row = siblings[i];
  if (row?.type === "folder" && expanded.has(row.path)) return { folder: row.path, before: row.children[0]?.name ?? null };
  return { folder, before: siblings[i + 1]?.name ?? null };
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

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-6 items-center justify-center rounded text-xs text-muted hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}
