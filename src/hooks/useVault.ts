"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client";
import { listNotes, listOtherFiles, resolveFile, resolveNote } from "@/lib/notes";
import type { VaultEntry } from "@/lib/vault";
import type { NoteEditorHandle } from "@/components/NoteEditor";

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * The notes vault as the app sees it: the file list, the open note, the trail
 * of notes left by following [[links]] (for "← back"), and file operations.
 *
 * `editor` is the open note's editor; operations that leave or move a note
 * save its pending edits through it first.
 */
export function useVault(report: (e: unknown) => void) {
  const [files, setFiles] = useState<VaultEntry[] | null>(null); // null until first loaded
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [noteHistory, setNoteHistory] = useState<string[]>([]);
  const editor = useRef<NoteEditorHandle>(null);

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

  /** Back along the trail of followed links, skipping notes deleted since. */
  const goBack = useCallback(async () => {
    const prev = [...noteHistory].reverse().find((p) => noteList.some((n) => n.path === p));
    if (!prev) return setNoteHistory([]);
    await editor.current?.flush();
    setNoteHistory((h) => h.slice(0, h.lastIndexOf(prev)));
    setOpenNote(prev);
  }, [noteHistory, noteList]);

  /** Open a note directly (not through a link): starts a fresh trail. */
  const openFresh = useCallback((path: string) => {
    setNoteHistory([]);
    setOpenNote(path);
  }, []);

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
        const { path } = (await (
          await api("/api/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }) })
        ).json()) as { path: string };
        setOpenNote((open) => (open === from ? path : open?.startsWith(from + "/") ? path + open.slice(from.length) : open));
      } catch (e) {
        report(e);
      }
      await loadFiles();
    },
    [loadFiles, report],
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

  const moveEntry = useCallback(
    (path: string, toFolder: string) => moveEntryTo(path, (toFolder ? toFolder + "/" : "") + path.split("/").pop()),
    [moveEntryTo],
  );

  /** Move to the vault's .trash. */
  const deleteEntry = useCallback(
    async (path: string) => {
      // Deleting the open note (or its folder): don't try to save it afterwards.
      if (openNote && (openNote === path || openNote.startsWith(path + "/"))) editor.current?.discard();
      try {
        await api(`/api/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
        setOpenNote((open) => (open === path || open?.startsWith(path + "/") ? null : open));
      } catch (e) {
        report(e);
      }
      await loadFiles();
    },
    [openNote, loadFiles, report],
  );

  return {
    files,
    loadFiles,
    openNote,
    openFresh,
    noteHistory,
    goBack,
    editor,
    noteList,
    resolveLink,
    resolveEmbed,
    addImage,
    openLink,
    createEntry,
    renameEntry,
    moveEntry,
    deleteEntry,
  };
}
