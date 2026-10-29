"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client";
import { listNotes, listOtherFiles, resolveFile, resolveNote } from "@/lib/notes";
import type { VaultEntry } from "@/lib/vault";
import type { NoteEditorHandle } from "@/components/NoteEditor";
import { HOME_NOTE } from "@/lib/home-note";

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const HOME_PATH = `${HOME_NOTE}.md`; // reached with the Home button: never a tab
const TABS_KEY = "flow.tabs";
function savedTabs(): { tabs: string[]; active: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as { tabs?: unknown; active?: unknown } | null;
    if (Array.isArray(saved?.tabs) && saved.tabs.every((p) => typeof p === "string")) {
      return { tabs: saved.tabs as string[], active: typeof saved.active === "string" ? saved.active : null };
    }
  } catch {} // no localStorage (on the server), or blocked
  return { tabs: [], active: null };
}

/** `p`, or where it is after `from` (a note or a folder) moved to `to`. */
const movedPath = (p: string, from: string, to: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);

/**
 * The notes vault as the app sees it: the file list, the open note, the trail
 * of notes left by following [[links]] (for "← back"), the open tabs, and file operations.
 *
 * Tabs work like Obsidian's: opening a note any ordinary way (a click, a link)
 * shows it in the current tab, in place of what was there; openInTab gives it
 * a tab of its own. The open note is always the active tab (except Home).
 *
 * `editor` is the open note's editor; operations that leave or move a note
 * save its pending edits through it first.
 */
export function useVault(report: (e: unknown) => void, onOpenNoteRelinked?: () => void) {
  // A rename or move rewrote links in the open note on disk: it must be loaded again.
  const relinked = useRef(onOpenNoteRelinked);
  relinked.current = onOpenNoteRelinked;
  const [files, setFiles] = useState<VaultEntry[] | null>(null); // null until first loaded
  const [openNote, setOpenNote] = useState<string | null>(null);
  const openRef = useRef(openNote); // the open note right now, for async work started earlier
  openRef.current = openNote;
  const [noteHistory, setNoteHistory] = useState<string[]>([]);
  const editor = useRef<NoteEditorHandle>(null);
  // Tabs from last time. (Read on first render: the tab bar shows only once a note is open, after
  // loading, so the server's render, with no tabs, is the same.)
  const [saved] = useState(savedTabs);
  const [tabs, setTabs] = useState(saved.tabs);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // The tab shown last (stays set while on Home). While a replace waits (below), still the tab being replaced.
  const activeTab = useRef<string | null>(saved.active);
  // A click in the sidebar: the next note opened takes over its tab only after a moment (see below).
  const deferTab = useRef(false);
  // That wait: the tab `was` will show `path` (opened already) unless a double-click gives it a tab of its own.
  const pending = useRef<{ path: string; was: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  /** Finish a waiting replace now (before anything else changes the tabs). */
  const settleTab = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    if (activeTab.current === p.was) activeTab.current = p.path;
    setTabs((t) => (t.includes(p.path) ? t.filter((x) => x !== p.was) : t.map((x) => (x === p.was ? p.path : x))));
  }, []);

  // A note opened in the current tab takes the place of the one there (none yet: a first tab).
  // Opened from the sidebar, the tab changes a moment later: if it's the start of a double-click,
  // the note gets a tab of its own instead (openInTab) and the current tab never flickers.
  useEffect(() => {
    const defer = deferTab.current;
    deferTab.current = false;
    if (!openNote || openNote === HOME_PATH) return;
    const p = pending.current;
    if (p) {
      clearTimeout(p.timer);
      pending.current = null;
    }
    const slot = p ? p.was : activeTab.current; // a waiting replace never happened: its tab is still `was`
    if (tabsRef.current.includes(openNote)) {
      activeTab.current = openNote; // switching tabs
      return;
    }
    const i = slot ? tabsRef.current.indexOf(slot) : -1;
    if (i < 0) {
      activeTab.current = openNote;
      setTabs((t) => (t.includes(openNote) ? t : [...t, openNote]));
      return;
    }
    const replace = () => {
      pending.current = null;
      if (openRef.current === openNote) activeTab.current = openNote;
      setTabs((t) => (t.includes(openNote) ? t : t.map((x) => (x === slot ? openNote : x))));
    };
    if (!defer) return replace();
    activeTab.current = slot;
    pending.current = { path: openNote, was: slot!, timer: setTimeout(replace, 350) };
  }, [openNote]);

  // Tabs are remembered in this browser.
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active: activeTab.current }));
    } catch {}
  }, [tabs, openNote]);

  /** Reload the file list. Returns it, or null if that failed (already reported). */
  const loadFiles = useCallback(async (): Promise<VaultEntry[] | null> => {
    try {
      const list: VaultEntry[] = await (await api("/api/files")).json();
      setFiles(list);
      return list;
    } catch (e) {
      report(e);
      return null;
    }
  }, [report]);

  // Resolved once a new file list has been rendered (see addImage).
  const listRendered = useRef<(() => void)[]>([]);
  useEffect(() => {
    const waiting = listRendered.current;
    listRendered.current = [];
    waiting.forEach((resolve) => resolve());
  }, [files]);

  const noteList = useMemo(() => listNotes(files ?? []), [files]);
  const otherFiles = useMemo(() => listOtherFiles(files ?? []), [files]);

  // Tabs of files that are gone (deleted, or renamed outside Flow) close.
  useEffect(() => {
    if (!files) return;
    const exists = new Set([...noteList, ...otherFiles].map((f) => f.path));
    setTabs((t) => (t.every((p) => exists.has(p)) ? t : t.filter((p) => exists.has(p))));
  }, [files, noteList, otherFiles]);

  /** The vault path an embed like ![[photo.png]] shows, or null. */
  const resolveEmbed = useCallback((target: string, from: string | null) => resolveFile(target, from, otherFiles), [otherFiles]);

  /**
   * Save an image pasted or dropped into a note, in the note's folder (where
   * Obsidian puts it by default). Returns what to embed: the file's name, or
   * its full path if another image already has that name.
   *
   * Resolves only after the new file list has rendered: the editor draws the
   * embed as soon as it's inserted, and with the old list the image would show
   * as "not found" (setFiles doesn't take effect until React renders).
   */
  const addImage = useCallback(
    async (file: File, notePath: string | null): Promise<string | null> => {
      const body = new FormData();
      body.append("folder", notePath ? folderOf(notePath) : "");
      body.append("file", file);
      try {
        const { path } = (await (await api("/api/files/image", { method: "POST", body })).json()) as { path: string };
        const rendered = new Promise<void>((resolve) => listRendered.current.push(resolve));
        const list = await loadFiles();
        if (list) await rendered;
        const name = path.split("/").pop()!;
        const sameName = listOtherFiles(list ?? []).filter((f) => f.name.toLowerCase() === name.toLowerCase());
        return sameName.length > 1 ? path : name;
      } catch (e) {
        report(e);
        return null;
      }
    },
    [loadFiles, report],
  );

  /** Which note a link points to: an exact "folder/name", else a same-named note, preferring the current folder. */
  const resolveLink = useCallback((target: string, from: string | null) => resolveNote(target, from, noteList), [noteList]);

  /** Follow a link: open the note, creating it next to the current one if it doesn't exist yet. */
  const openLink = useCallback(
    async (target: string) => {
      const from = openNote;
      let path = resolveLink(target, from);
      if (!path) {
        try {
          path = ((await (
            await api("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent: from ? folderOf(from) : "", name: target, type: "file" }) })
          ).json()) as { path: string }).path;
        } catch (e) {
          return report(e);
        }
        await loadFiles();
      }
      if (path === from) return;
      await editor.current?.flush(); // save the note we're leaving
      if (from) setNoteHistory((h) => [...h, from]);
      setOpenNote(path);
    },
    [openNote, resolveLink, loadFiles, report],
  );

  /** Go to a note by path the way a link does (saving the current one, and "← back" returns). */
  const goToNote = useCallback(
    async (path: string) => {
      const from = openNote;
      if (path === from) return;
      await editor.current?.flush();
      if (from) setNoteHistory((h) => [...h, from]);
      setOpenNote(path);
    },
    [openNote],
  );

  /** Back along the trail of followed links, skipping notes deleted since. */
  const goBack = useCallback(async () => {
    const prev = [...noteHistory].reverse().find((p) => noteList.some((n) => n.path === p));
    if (!prev) return setNoteHistory([]);
    await editor.current?.flush();
    setNoteHistory((h) => h.slice(0, h.lastIndexOf(prev)));
    setOpenNote(prev);
  }, [noteHistory, noteList]);

  /** A click on a note in the sidebar: like openFresh, but its tab changes after a moment, in case it's a double-click. */
  const openFromSidebar = useCallback((path: string) => {
    if (path === openRef.current) return;
    deferTab.current = true;
    setNoteHistory([]);
    setOpenNote(path);
  }, []);

  /** Open a note directly (not through a link): starts a fresh trail. null: no note open. */
  const openFresh = useCallback((path: string | null) => {
    setNoteHistory([]);
    setOpenNote(path);
  }, []);

  /** Switch to an open tab. */
  const selectTab = useCallback(async (path: string) => {
    if (path === openRef.current) return;
    await editor.current?.flush();
    setNoteHistory([]);
    setOpenNote(path);
  }, []);

  /**
   * Open a note in a tab of its own, just after the current one (already in a
   * tab: switch to it). A double-click's first click has just opened the note,
   * its tab not yet changed: the tab keeps its note, and this one gets a new tab.
   */
  const openInTab = useCallback(async (path: string) => {
    const p = pending.current;
    if (p && p.path === path) {
      // The double-click's first click opened it, and its tab hasn't changed yet: a new tab after it instead.
      clearTimeout(p.timer);
      pending.current = null;
      activeTab.current = path;
      setTabs((t) => {
        const i = t.indexOf(p.was);
        return t.includes(path) ? t : i < 0 ? [...t, path] : [...t.slice(0, i + 1), path, ...t.slice(i + 1)];
      });
      return;
    }
    settleTab();
    if (path === openRef.current) return;
    await editor.current?.flush();
    setTabs((t) => {
      if (t.includes(path)) return t;
      const i = activeTab.current ? t.indexOf(activeTab.current) : -1;
      return i < 0 ? [...t, path] : [...t.slice(0, i + 1), path, ...t.slice(i + 1)];
    });
    setNoteHistory([]);
    setOpenNote(path);
  }, [settleTab]);

  /** Close a tab. Closing the open one shows the tab next to it (none left: no note). */
  const closeTab = useCallback(async (path: string) => {
    settleTab();
    const t = tabsRef.current;
    const i = t.indexOf(path);
    if (i < 0) return;
    const rest = t.filter((p) => p !== path);
    if (openRef.current === path) {
      await editor.current?.flush();
      const next = rest[Math.min(i, rest.length - 1)] ?? null;
      activeTab.current = next;
      setNoteHistory([]);
      setOpenNote(next);
    }
    setTabs(rest);
  }, [settleTab]);

  /** Drag a tab to reorder: put it at `index` among the tabs. */
  const moveTab = useCallback(
    (path: string, index: number) => {
      settleTab();
      setTabs((t) => {
        const rest = t.filter((p) => p !== path);
        return rest.length === t.length ? t : [...rest.slice(0, index), path, ...rest.slice(index)];
      });
    },
    [settleTab],
  );

  /** Tabs follow a note or folder that was renamed or moved. */
  const moveTabs = useCallback(
    (from: string, to: string) => {
      settleTab();
      setTabs((t) => t.map((p) => movedPath(p, from, to)));
      if (activeTab.current) activeTab.current = movedPath(activeTab.current, from, to);
    },
    [settleTab],
  );

  /** Create "Untitled" / "New folder", adding a number if the name is taken. A new note opens. */
  const createEntry = useCallback(
    async (parent: string, type: "file" | "folder") => {
      const base = type === "file" ? "Untitled" : "New folder";
      for (let n = 0; n < 100; n++) {
        const name = n ? `${base} ${n}` : base;
        const res = await fetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parent, name, type }),
        }).catch(() => null);
        if (res?.status === 409) continue; // taken: try the next number
        if (!res?.ok) {
          report(new ApiError(res ? ((await res.json().catch(() => ({}))).error ?? "Couldn't create it") : "Can't reach the Flow server. Is it running?"));
          return null;
        }
        const { path } = (await res.json()) as { path: string };
        await loadFiles();
        if (type === "file") setOpenNote(path);
        return path;
      }
      return null;
    },
    [loadFiles, report],
  );

  /** Rename or move; keeps the open note open if it (or its folder) moved. */
  const moveEntryTo = useCallback(
    async (from: string, to: string) => {
      await editor.current?.flush(); // save pending edits under the old name first
      try {
        const { path, relinked: rewritten = [] } = (await (
          await api("/api/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }) })
        ).json()) as { path: string; relinked?: string[] };
        const open = openRef.current;
        const nowOpen = open && movedPath(open, from, path);
        moveTabs(from, path);
        openRef.current = nowOpen; // right away: a group move continues with the next item before React re-renders
        setOpenNote(nowOpen);
        if (nowOpen && rewritten.includes(nowOpen)) relinked.current?.();
      } catch (e) {
        report(e);
      }
      await loadFiles();
    },
    [loadFiles, report, moveTabs],
  );

  const renameEntry = useCallback(
    (path: string, name: string) => {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      // Keep the file's ending (.md for notes, .png for an image) if the new name leaves it off.
      const ext = /\.[^./]+$/.exec(path)?.[0] ?? "";
      const isFolder = !!files && !listNotes(files).some((n) => n.path === path) && !listOtherFiles(files).some((f) => f.path === path);
      return moveEntryTo(path, parent + (!isFolder && ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name));
    },
    [moveEntryTo, files],
  );

  /**
   * Drag to arrange: put entries in `folder`, just before the item named
   * `before` (null = at the end), keeping their order. One at a time on the
   * server, each before the same item, so they end up together in order.
   */
  const placeEntries = useCallback(
    async (froms: string[], folder: string, before: string | null) => {
      await editor.current?.flush(); // save pending edits under the old path first
      for (const from of froms) {
        try {
          const { path, relinked: rewritten = [] } = (await (
            await api("/api/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, folder, before }) })
          ).json()) as { path: string; relinked?: string[] };
          const open = openRef.current;
        const nowOpen = open && movedPath(open, from, path);
        moveTabs(from, path);
        openRef.current = nowOpen; // right away: a group move continues with the next item before React re-renders
        setOpenNote(nowOpen);
        if (nowOpen && rewritten.includes(nowOpen)) relinked.current?.();
        } catch (e) {
          report(e);
          break; // e.g. a name already taken there: stop rather than half-scatter the rest
        }
      }
      await loadFiles();
    },
    [loadFiles, report, moveTabs],
  );

  /** Move entries to the vault's .trash. */
  const deleteEntries = useCallback(
    async (paths: string[]) => {
      const inside = (open: string | null, p: string) => !!open && (open === p || open.startsWith(p + "/"));
      settleTab();
      // Deleting the open note (or its folder): don't try to save it afterwards.
      if (paths.some((p) => inside(openNote, p))) editor.current?.discard();
      for (const path of paths) {
        try {
          await api(`/api/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
          // Its tabs close; if it was open, the tab next to it shows instead.
          const t = tabsRef.current;
          const rest = t.filter((p) => !inside(p, path));
          const open = openRef.current;
          if (inside(open, path)) {
            const i = t.indexOf(open!);
            const next = t.slice(i + 1).find((p) => rest.includes(p)) ?? t.slice(0, Math.max(i, 0)).reverse().find((p) => rest.includes(p)) ?? null;
            activeTab.current = next;
            openRef.current = next;
            setOpenNote(next);
          }
          tabsRef.current = rest;
          setTabs(rest);
        } catch (e) {
          report(e);
        }
      }
      await loadFiles();
    },
    [openNote, loadFiles, report, settleTab],
  );

  return {
    files,
    loadFiles,
    openNote,
    openFresh,
    openFromSidebar,
    noteHistory,
    goBack,
    tabs,
    selectTab,
    openInTab,
    closeTab,
    moveTab,
    /** The tab shown last, for coming back from Home or Chats. */
    lastTab: () => activeTab.current,
    editor,
    noteList,
    resolveLink,
    resolveEmbed,
    addImage,
    openLink,
    goToNote,
    createEntry,
    renameEntry,
    placeEntries,
    deleteEntries,
  };
}
