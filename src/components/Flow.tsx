"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Thread } from "@/lib/db";
import { rehypeAnchors, type Anchor } from "@/lib/rehype-anchors";
import { rehypeFade } from "@/lib/rehype-fade";
import { STOPPED_NOTE } from "@/lib/shared";
import { api, ApiError, devMockHeader } from "@/lib/client";
import type { NoteEvent } from "@/lib/chat-note";
import { HOME_NOTE, HOME_WELCOME } from "@/lib/home-note";
import ThreadMap from "./ThreadMap";
import FileTree from "./FileTree";
import Settings from "./Settings";
import type { NoteEditorHandle } from "./NoteEditor";

// The notes editor (CodeMirror) is only downloaded once a note is opened, so
// the chat view doesn't load it.
const NoteEditor = dynamic(() => import("./NoteEditor"), { ssr: false });
import type { VaultEntry } from "@/lib/vault";
import type { LinkHost } from "@/lib/wikilinks";

type Pluggable = NonNullable<Options["rehypePlugins"]>[number]; // one entry of react-markdown's plugin list

type Tree = { threads: Thread[]; messages: Message[] };
const NO_MESSAGES: Message[] = [];
type Selection = { text: string; threadId: string; messageId: string; x: number; y: number };

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

/**
 * Navigation model: the center pane shows the *focused* thread (main, or any
 * side thread you've drilled into); the side panel shows the focused thread's
 * children. Branching from inside the side panel promotes that side thread to
 * the center, so you only ever see two levels at once.
 */
export default function Flow() {
  const [conversations, setConversations] = useState<Thread[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree>({ threads: [], messages: [] });
  const [sideId, setSideId] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(true);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const mainInput = useRef<HTMLTextAreaElement>(null);
  const sideInput = useRef<HTMLTextAreaElement>(null);
  const mainScroll = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const aborters = useRef(new Map<string, AbortController>()); // per thread, for Stop
  const pending = useRef(new Map<string, string>()); // streamed text not yet on screen
  const flushScheduled = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [home, setHome] = useState(false); // Home page instead of a conversation
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [files, setFiles] = useState<VaultEntry[] | null>(null); // the vault, loaded on Home
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [noteHistory, setNoteHistory] = useState<string[]>([]); // notes left by following [[links]], for "← back"
  const editor = useRef<NoteEditorHandle>(null);
  const [matches, setMatches] = useState<Set<string> | null>(null); // null = not searching

  // Every action catches its own failures and lands here, so a dead server or
  // a bad response shows a short notice instead of an unhandled rejection.
  const report = useCallback((e: unknown) => {
    console.warn("[flow]", e);
    setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
  }, []);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  // ---------- data ----------

  const loadConversations = useCallback(async (): Promise<Thread[]> => {
    try {
      const list: Thread[] = await (await api("/api/threads")).json();
      setConversations(list);
      return list;
    } catch (e) {
      report(e);
      return [];
    }
  }, [report]);

  const loadTree = useCallback(
    async (id: string) => {
      try {
        const t: Tree = await (await api(`/api/threads/${id}`)).json();
        setTree(t);
      } catch (e) {
        report(e);
      }
    },
    [report],
  );

  useEffect(() => {
    void loadConversations(); // for the sidebar and the Chats button; startup itself opens Home (below)
  }, [loadConversations]);

  useEffect(() => {
    setFocusId(rootId);
    setSideId(null);
    if (!rootId) return setTree({ threads: [], messages: [] });
    loadTree(rootId);
  }, [rootId, loadTree]);

  // Search titles and message text (side threads included) as you type. Debounced,
  // and a newer keystroke cancels an older request so results can't arrive out of order.
  // Re-runs when the conversation list changes, so new messages become searchable.
  useEffect(() => {
    const q = query.trim();
    if (!q || home) return setMatches(null); // on Home the file tree filters by name
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const ids: string[] = await (await api(`/api/search?q=${encodeURIComponent(q)}`)).json();
        if (!cancelled) setMatches(new Set(ids));
      } catch (e) {
        if (!cancelled) report(e);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, conversations, home, report]);
  const shownConversations = matches ? conversations.filter((c) => matches.has(c.id)) : conversations;

  const byId = useMemo(() => new Map(tree.threads.map((t) => [t.id, t])), [tree.threads]);
  const childrenOf = useCallback(
    (id: string) => tree.threads.filter((t) => t.parentThreadId === id).sort((a, b) => a.createdAt - b.createdAt),
    [tree.threads],
  );
  // Group once per change instead of filtering the whole list for every thread
  // on every render. Each thread's array keeps its identity until it changes.
  const messagesByThread = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const m of tree.messages) map.set(m.threadId, [...(map.get(m.threadId) ?? []), m]);
    return map;
  }, [tree.messages]);
  const messagesOf = useCallback((threadId: string) => messagesByThread.get(threadId) ?? NO_MESSAGES, [messagesByThread]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of tree.messages) c.set(m.threadId, (c.get(m.threadId) ?? 0) + 1);
    return c;
  }, [tree.messages]);

  const focus = focusId ?? rootId;
  const focusThread = focus ? byId.get(focus) : undefined;
  const focusMessages = useMemo(() => (focus ? messagesOf(focus) : []), [focus, messagesOf]);
  // Every branch of the center thread (drawn as highlights) vs. the real side
  // threads (listed in the panel and the map). Unsaved "ask on the side"
  // branches (kind "oneoff") are only the former.
  const branches = useMemo(() => (focus ? childrenOf(focus) : []), [focus, childrenOf]);
  const sideThreads = useMemo(() => branches.filter((t) => t.kind !== "oneoff"), [branches]);
  const activeSide = branches.find((t) => t.id === sideId) ?? null;
  const activeIsOneOff = activeSide?.kind === "oneoff";
  const showSide = sideOpen && (sideThreads.length > 0 || activeIsOneOff);

  // Main › first side › … › focus, for the breadcrumbs.
  const lineage = useMemo(() => {
    const out: Thread[] = [];
    for (let t = focus ? byId.get(focus) : undefined; t; t = t.parentThreadId ? byId.get(t.parentThreadId) : undefined) {
      out.unshift(t);
    }
    return out;
  }, [focus, byId]);

  // ---------- navigation ----------

  /** Reload the vault's file list. Returns it, or null if that failed (already reported). */
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

  // ---------- [[links]] between notes ----------

  const noteList = useMemo(() => {
    const out: { path: string; name: string; folder: string }[] = [];
    const walk = (list: VaultEntry[]) =>
      list.forEach((e) => {
        if (e.type === "folder") walk(e.children);
        else out.push({ path: e.path, name: e.name.replace(/\.md$/i, ""), folder: e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "" });
      });
    walk(files ?? []);
    return out;
  }, [files]);

  /** Which note a link points to: an exact "folder/name", else a same-named note, preferring the current folder. */
  const resolveLink = useCallback(
    (target: string, from: string | null): string | null => {
      const t = target.replace(/\.md$/i, "").toLowerCase();
      if (t.includes("/")) return noteList.find((n) => n.path.toLowerCase() === `${t}.md`)?.path ?? null;
      const matches = noteList.filter((n) => n.name.toLowerCase() === t);
      if (!matches.length) return null;
      const here = from?.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
      return (matches.find((n) => n.folder === here) ?? [...matches].sort((a, b) => a.path.length - b.path.length)[0]).path;
    },
    [noteList],
  );

  /** Follow a link: open the note, creating it next to the current one if it doesn't exist yet. */
  const openLink = useCallback(
    async (target: string) => {
      const from = openNote;
      let path = resolveLink(target, from);
      if (!path) {
        const folder = from?.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
        try {
          path = ((await (
            await api("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent: folder, name: target, type: "file" }) })
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

  // ---------- links from notes to chats ----------

  type ThreadInfo = Pick<Thread, "id" | "parentThreadId" | "title" | "kind">;
  const [chatIndex, setChatIndex] = useState<ThreadInfo[]>([]); // every chat and branch, for [[ suggestions
  const loadChatIndex = useCallback(async () => {
    try {
      setChatIndex(await (await api("/api/threads?all=1")).json());
    } catch (e) {
      report(e);
    }
  }, [report]);
  const chatOptions = useMemo(() => {
    const byId = new Map(chatIndex.map((t) => [t.id, t]));
    const rootOf = (t: ThreadInfo) => {
      while (t.parentThreadId && byId.has(t.parentThreadId)) t = byId.get(t.parentThreadId)!;
      return t;
    };
    return chatIndex.map((t) => ({
      id: t.id,
      title: t.title,
      detail: t.parentThreadId ? `${t.kind === "oneoff" ? "side question" : "branch"} · ${rootOf(t).title.slice(0, 30)}` : "chat",
    }));
  }, [chatIndex]);

  useEffect(() => void loadChatIndex(), [loadChatIndex]);
  // Fetch the notes editor in the background once the page is idle, so opening
  // Home is instant without making the first load heavier.
  useEffect(() => {
    const prefetch = () => void import("./NoteEditor");
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(prefetch, { timeout: 5000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(prefetch, 2000);
    return () => clearTimeout(t);
  }, []);
  // Re-style links when either list changes (exists / not created yet / chat deleted).
  const linksVersion = useMemo(() => ({}), [files, chatIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // A linked chat to show once its conversation has loaded (it may be a branch deep inside it).
  const [pendingChat, setPendingChat] = useState<string | null>(null);
  const openChat = useCallback(
    async (id: string) => {
      try {
        const { rootId: root } = (await (await api(`/api/threads/${id}/root`)).json()) as { rootId: string };
        await editor.current?.flush();
        setPendingChat(id);
        setHome(false);
        setQuery("");
        setRootId(root);
      } catch (e) {
        report(e);
      }
    },
    [report],
  );

  const linkHost = useMemo<LinkHost>(
    () => ({
      exists: (target) => resolveLink(target, openNote) !== null,
      open: (target) => void openLink(target),
      notes: () => noteList.map(({ name, folder }) => ({ name, folder })),
      chats: () => chatOptions,
      chatExists: (id) => chatIndex.some((t) => t.id === id),
      openChat: (id) => void openChat(id),
    }),
    [resolveLink, openNote, openLink, noteList, chatOptions, chatIndex, openChat],
  );

  const goBack = useCallback(async () => {
    const prev = [...noteHistory].reverse().find((p) => noteList.some((n) => n.path === p)); // skip deleted notes
    if (!prev) return setNoteHistory([]);
    await editor.current?.flush();
    setNoteHistory((h) => h.slice(0, h.lastIndexOf(prev)));
    setOpenNote(prev);
  }, [noteHistory, noteList]);

  /** Opening a note from the sidebar starts a fresh trail. */
  const openFromSidebar = useCallback((path: string) => {
    setNoteHistory([]);
    setOpenNote(path);
  }, []);

  const lastConversation = useRef<string | null>(null); // where "Chats" returns to from Home

  /** Home opens its own note, Home.md at the top of the vault. If it isn't there, it's created with a welcome guide. */
  const goHome = useCallback(async () => {
    lastConversation.current = rootId;
    setHome(true);
    setRootId(null); // clears the tree, map and side panel
    setQuery("");
    void loadChatIndex();
    await editor.current?.flush(); // if a note is open, save it before switching
    const path = `${HOME_NOTE}.md`;
    const list = await loadFiles();
    if (!list) return; // couldn't reach the server (already reported)
    if (!list.some((e) => e.type === "file" && e.path === path)) {
      // No Home note yet: create it, starting with the guide to Flow.
      try {
        await api("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent: "", name: HOME_NOTE, type: "file" }) });
        await api("/api/files/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content: HOME_WELCOME }) });
      } catch (e) {
        return report(e);
      }
      await loadFiles();
    }
    setNoteHistory([]);
    setOpenNote(path);
  }, [rootId, loadFiles, loadChatIndex, report]);

  // The app starts on Home. (Once: goHome changes whenever the open chat does.)
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void goHome();
  }, [goHome]);

  /** Leave Home: back to the last conversation, else the most recent one. */
  const goToChats = useCallback(() => {
    const id = conversations.some((c) => c.id === lastConversation.current) ? lastConversation.current : (conversations[0]?.id ?? null);
    setHome(false);
    setQuery("");
    setRootId(id);
  }, [conversations]);

  /**
   * Turn the focused chat (and everything branched off it, nothing above) into
   * a note. The note opens on Home straight away and fills in as it's written:
   * the server streams one JSON event per line (see NoteEvent).
   */
  const [makingNote, setMakingNote] = useState<string | null>(null); // thread id being summarized
  const [liveNote, setLiveNote] = useState<{ path: string; markdown: string } | null>(null);
  const makeNote = useCallback(
    async (threadId: string) => {
      setMakingNote(threadId);
      let path: string | null = null;
      let finished = false;
      try {
        const res = await api(`/api/threads/${threadId}/note`, { method: "POST", headers: devMockHeader() });
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop()!; // a partial line waits for the rest
          for (const line of lines.filter(Boolean)) {
            const e = JSON.parse(line) as NoteEvent;
            if (e.type === "start") {
              path = e.path;
              setLiveNote({ path, markdown: "" });
              void loadChatIndex(); // fresh chat titles for [[ suggestions
              await loadFiles(); // before switching, so Home doesn't flash an empty file list
              lastConversation.current = rootId; // "Chats" comes back here
              setHome(true);
              setRootId(null);
              setQuery("");
              setNoteHistory([]);
              setOpenNote(path);
            } else if (e.type === "snapshot") {
              setLiveNote((n) => (n && { ...n, markdown: e.markdown }));
            } else if (e.type === "done") {
              finished = true;
            } else if (e.type === "error") {
              throw new ApiError(`The note stopped partway: ${e.error}`);
            }
          }
        }
        // The server keeps going without us, so the note will still be finished and saved.
        if (!finished) throw new ApiError("Lost the live view. The note is still being written and will be saved; reopen it in a moment.");
      } catch (e) {
        report(e);
      } finally {
        setLiveNote(null); // the editor reloads the saved file
        setMakingNote(null);
      }
    },
    [rootId, loadFiles, loadChatIndex, report],
  );

  // ---------- vault (Home) ----------

  /** Create "Untitled" / "New folder", adding a number if the name is taken. */
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
      const isNote = path.toLowerCase().endsWith(".md");
      return moveEntryTo(path, parent + (isNote && !name.toLowerCase().endsWith(".md") ? `${name}.md` : name));
    },
    [moveEntryTo],
  );

  const moveEntry = useCallback(
    (path: string, toFolder: string) => moveEntryTo(path, (toFolder ? toFolder + "/" : "") + path.split("/").pop()),
    [moveEntryTo],
  );

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

  /** Put `threadId` in the center, optionally with one of its children open on the side. */
  const goTo = useCallback((threadId: string, side: string | null = null, moveKeyboardFocus = true) => {
    setFocusId(threadId);
    setSideId(side);
    setSideOpen(!!side);
    setSelection(null);
    if (moveKeyboardFocus) requestAnimationFrame(() => (side ? sideInput : mainInput).current?.focus());
  }, []);

  /** Show a conversation (leaving Home). Re-selecting the open one returns to its main thread. */
  const openConversation = useCallback(
    (id: string) => {
      setHome(false);
      if (id === rootId) goTo(id);
      else setRootId(id);
    },
    [rootId, goTo],
  );

  /** Open a child thread: on the side if it hangs off the center thread, else drill in. */
  const openThread = useCallback(
    (id: string) => {
      const t = byId.get(id);
      if (!t?.parentThreadId) return;
      if (t.parentThreadId === focus) {
        setSideId(id);
        setSideOpen(true);
        requestAnimationFrame(() => sideInput.current?.focus());
      } else {
        goTo(t.parentThreadId, id);
      }
    },
    [byId, focus, goTo],
  );

  // Show a linked chat once its conversation is loaded: a side question opens on
  // the side of its parent, any other thread in the center.
  useEffect(() => {
    if (!pendingChat) return;
    const t = byId.get(pendingChat);
    if (!t) return; // not loaded yet
    setPendingChat(null);
    if (!t.parentThreadId) return; // the main chat: already in the center
    if (t.kind === "oneoff") goTo(t.parentThreadId, t.id);
    else goTo(t.id);
  }, [pendingChat, byId, goTo]);

  const goUp = useCallback(() => {
    if (focusThread?.parentThreadId) goTo(focusThread.parentThreadId, focusThread.id);
  }, [focusThread, goTo]);

  const jumpToSource = useCallback((messageId: string) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(messageId);
    setTimeout(() => setFlashId(null), 1200);
  }, []);

  // ---------- actions ----------

  /** Throws on failure; callers catch. */
  const newConversation = useCallback(async () => {
    const t: Thread = await (await api("/api/threads", { method: "POST", body: "{}" })).json();
    await loadConversations();
    setHome(false);
    setRootId(t.id);
    mainInput.current?.focus();
    return t.id;
  }, [loadConversations]);

  /**
   * Streamed chunks arrive far faster than the screen refreshes. Buffer them
   * and apply them in one state update per animation frame, so a long reply
   * causes at most ~60 renders a second instead of one per token.
   *
   * The 50ms timer is a fallback: some windows report themselves visible but
   * don't paint, and requestAnimationFrame never fires there, which would
   * freeze the streaming text until the reply finished.
   */
  function queueStreamText(threadId: string, chunk: string) {
    pending.current.set(threadId, (pending.current.get(threadId) ?? "") + chunk);
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    let done = false;
    const flush = () => {
      if (done) return;
      done = true;
      flushScheduled.current = false;
      const batch = new Map(pending.current);
      pending.current.clear();
      setStreaming((s) => {
        const next = { ...s };
        for (const [id, text] of batch) if (id in next) next[id] += text;
        return next;
      });
    };
    requestAnimationFrame(flush);
    setTimeout(flush, 50);
  }

  /** Stop generating in a thread. The server sees the disconnect and cancels the model call. */
  const stop = useCallback((threadId: string) => aborters.current.get(threadId)?.abort(), []);

  const send = useCallback(
    async (threadId: string | null, content: string) => {
      const text = content.trim();
      if (!text) return;
      let target: string;
      try {
        target = threadId ?? (await newConversation());
      } catch (e) {
        return report(e);
      }

      // Optimistic: show the user's message and an empty streaming reply immediately.
      const tempId = `temp-${Date.now()}`;
      const temp: Message = { id: tempId, threadId: target, role: "user", content: text, createdAt: Date.now() };
      setTree((t) => ({ ...t, messages: [...t.messages, temp] }));
      setStreaming((s) => ({ ...s, [target]: "" }));

      const aborter = new AbortController();
      aborters.current.set(target, aborter);
      // We choose the ids, so we know them even if the reply is stopped before
      // the server sends anything back (headers wait for the first chunk).
      const ids = { user: crypto.randomUUID(), assistant: crypto.randomUUID() };
      let received = "";
      let stopped = false;
      let failed = false;
      try {
        const res = await api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...devMockHeader() },
          body: JSON.stringify({ threadId: target, content: text, userMessageId: ids.user, assistantMessageId: ids.assistant }),
          signal: aborter.signal,
        });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          received += chunk;
          queueStreamText(target, chunk);
        }
      } catch (e) {
        if (aborter.signal.aborted) stopped = true; // the user pressed Stop: not an error
        else {
          failed = true; // the server most likely never saved this turn
          report(e);
        }
      } finally {
        aborters.current.delete(target);
      }

      // Update the local copy with exactly what the server saved, instead of
      // re-downloading the whole conversation. Upsert by id, so it's harmless
      // if a conversation load already brought these rows in.
      setTree((t) => {
        const messages = t.messages.filter((m) => m.id !== tempId);
        if (!failed) {
          const now = Date.now();
          const add = [
            { id: ids.user, threadId: target, role: "user" as const, content: text, createdAt: now },
            { id: ids.assistant, threadId: target, role: "assistant" as const, content: (received || "") + (stopped ? STOPPED_NOTE : "") || "_(empty reply)_", createdAt: now + 1 },
          ].filter((m) => !messages.some((x) => x.id === m.id));
          messages.push(...add);
        }
        return { ...t, messages };
      });
      pending.current.delete(target);
      setStreaming((s) => {
        const rest = { ...s };
        delete rest[target];
        return rest;
      });
      loadConversations(); // cheap: titles only, picks up a new chat's title
    },
    [newConversation, loadConversations, report],
  );

  /** Branch from a message in `fromThreadId`. Branching from the side panel drills into it. */
  const fork = useCallback(
    // Branches start as one-offs; they join the map only when the user saves them.
    async (fromThreadId: string, messageId: string, anchorText: string | null, kind: Thread["kind"] = "oneoff") => {
      if (!rootId) return;
      let t: Thread;
      try {
        t = await (
          await api("/api/threads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parentThreadId: fromThreadId, forkMessageId: messageId, anchorText, kind }),
          })
        ).json();
      } catch (e) {
        return report(e);
      }
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      setTree((tr) => ({ ...tr, threads: [...tr.threads, t] }));
      if (fromThreadId === focus) {
        setSideId(t.id);
        setSideOpen(true);
        requestAnimationFrame(() => sideInput.current?.focus());
      } else {
        goTo(fromThreadId, t.id);
      }
    },
    [rootId, focus, goTo, report],
  );

  const saveToMap = useCallback(
    async (id: string) => {
      let saved: Thread;
      try {
        saved = await (
          await api(`/api/threads/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "thread" }),
          })
        ).json();
      } catch (e) {
        return report(e);
      }
      // It stays open on the side, now as a regular thread.
      setTree((t) => ({ ...t, threads: t.threads.map((x) => (x.id === id ? saved : x)) }));
    },
    [report],
  );

  const deleteThread = useCallback(
    async (id: string) => {
      try {
        await api(`/api/threads/${id}`, { method: "DELETE" });
      } catch (e) {
        return report(e);
      }
      if (sideId === id) setSideId(null);
      // Mirror the database's cascade: the thread, its descendants, and their messages.
      setTree((t) => {
        const gone = new Set([id]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const x of t.threads) {
            if (x.parentThreadId && gone.has(x.parentThreadId) && !gone.has(x.id)) {
              gone.add(x.id);
              grew = true;
            }
          }
        }
        return {
          threads: t.threads.filter((x) => !gone.has(x.id)),
          messages: t.messages.filter((m) => !gone.has(m.threadId)),
        };
      });
    },
    [sideId, report],
  );

  // ---------- text selection -> "ask on the side", highlight clicks ----------

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return setSelection(null);
    const host = (n: Node | null) =>
      (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-fork-id]");
    const a = host(sel.anchorNode);
    const b = host(sel.focusNode);
    const text = sel.toString().trim();
    if (!a || a !== b || !text) return setSelection(null);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({
      text,
      threadId: a.dataset.forkThread!,
      messageId: a.dataset.forkId!,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  }, []);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const mark = (e.target as Element).closest<HTMLElement>("mark[data-thread-id]");
      // Ignore clicks that end a text selection, so you can still highlight across a mark.
      if (!mark || !window.getSelection()?.isCollapsed) return;
      openThread(mark.dataset.threadId!);
    },
    [openThread],
  );

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (selection) return void fork(selection.threadId, selection.messageId, selection.text);
        const lastReply = [...focusMessages].reverse().find((m) => m.role === "assistant" && !m.id.startsWith("temp-"));
        if (focus && lastReply) fork(focus, lastReply.id, null);
        return;
      }
      // ⌘⌥← (as in Obsidian): ⌘[ is taken by the browser's Back and the editor's outdent.
      if (mod && e.altKey && e.key === "ArrowLeft" && home && noteHistory.length) {
        e.preventDefault();
        void goBack();
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        setSideOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        if (selection) return setSelection(null);
        if (e.shiftKey) return void (rootId && goTo(rootId));
        if (showSide) {
          setSideOpen(false);
          mainInput.current?.focus();
        } else {
          goUp();
        }
        return;
      }
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && sideThreads.length) {
        e.preventDefault();
        const i = sideThreads.findIndex((t) => t.id === sideId);
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = sideThreads[(i + step + sideThreads.length) % sideThreads.length];
        openThread(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, fork, focus, focusMessages, rootId, goTo, goUp, showSide, sideThreads, sideId, openThread, home, noteHistory, goBack]);

  // Keep the center pinned to the bottom while it streams (only if already near the bottom).
  useEffect(() => {
    const el = mainScroll.current;
    if (!el || !focus || streaming[focus] === undefined) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [streaming, focus]);

  const nested = !!focusThread?.parentThreadId;

  // The Home note is reached with the Home button, not listed with the other files;
  // the button is highlighted only while that note is open.
  const homePath = `${HOME_NOTE}.md`;
  const onHomeNote = home && openNote === homePath;
  const sidebarFiles = useMemo(() => files?.filter((e) => e.path !== homePath) ?? null, [files, homePath]);

  // Map props that stay the same object until they really change, so the
  // memoized map skips the many re-renders while a reply streams.
  const mapThreads = useMemo(() => tree.threads.filter((t) => t.kind !== "oneoff"), [tree.threads]);
  const streamingKey = Object.keys(streaming).sort().join(","); // which threads stream, not their text
  const streamingIds = useMemo(() => new Set(streamingKey ? streamingKey.split(",") : []), [streamingKey]);
  const onMapNavigate = useCallback((id: string) => goTo(id, null, false), [goTo]);
  const onMapExit = useCallback(() => mainInput.current?.focus(), []);

  // ---------- render ----------

  return (
    <div className="flex h-dvh text-[15px]">
      {/* Conversations + map */}
      <aside
        // Clicking anywhere on the sidebar except its own buttons (conversation
        // list, + New) enters map mode, so WASD works without aiming at a dot.
        onMouseDown={(e) => {
          // On Home there's no map: leave clicks alone (otherwise preventDefault
          // below would keep focus stuck in a file's rename box).
          if (home || !mapRef.current) return;
          const target = e.target as Element;
          const control = target.closest("button, a, input, textarea");
          if (control && !mapRef.current?.contains(control)) return;
          e.preventDefault(); // no text selection, no focus flicker
          mapRef.current?.focus();
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
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  // Clear first, then leave the box. Don't let the app-wide Esc react.
                  e.stopPropagation();
                  if (query) setQuery("");
                  else e.currentTarget.blur();
                } else if (e.key === "Enter" && !home && shownConversations[0]) {
                  openConversation(shownConversations[0].id);
                }
              }}
              placeholder={home ? "Search files" : "Search"}
              aria-label={home ? "Search files" : "Search chats"}
              className="w-full rounded-md border border-line bg-bg py-1 pr-2 pl-8 text-sm outline-none placeholder:text-muted focus:border-line-strong"
            />
          </div>
          <button
            onClick={goHome}
            className={`mt-2 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${
              onHomeNote ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5H9.5v-4h-3v4H3a.5.5 0 0 1-.5-.5V7Z" />
            </svg>
            Home
          </button>
          {home ? (
            <button
              onClick={goToChats}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted hover:bg-hover hover:text-fg"
            >
              <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11H4a1.5 1.5 0 0 1-1.5-1.5V4Z" />
              </svg>
              Chats
            </button>
          ) : (
            <button
              onClick={() => newConversation().catch(report)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted hover:bg-hover hover:text-fg"
            >
              <span className="w-3.5 text-center text-base leading-none">+</span>
              New chat
            </button>
          )}
        </div>
        {home ? (
          sidebarFiles && (
            <FileTree
              entries={sidebarFiles}
              activePath={openNote}
              filter={query}
              onOpen={openFromSidebar}
              onCreate={createEntry}
              onRename={renameEntry}
              onMove={moveEntry}
              onDelete={deleteEntry}
            />
          )
        ) : (
          <>
        <nav className="max-h-[35%] shrink-0 overflow-y-auto px-2 pb-3">
          {matches && shownConversations.length === 0 && <p className="px-3 py-2 text-sm text-muted">No chats match “{query.trim()}”</p>}
          {shownConversations.map((c) => (
            <button
              key={c.id}
              onClick={() => openConversation(c.id)}
              className={`block w-full truncate rounded-md px-3 py-1.5 text-left text-[13px] leading-5 ${
                c.id === rootId ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              {c.title}
            </button>
          ))}
        </nav>
        {rootId && focus && tree.threads.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col border-t border-line">
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              <ThreadMap
                ref={mapRef}
                threads={mapThreads}
                rootId={rootId}
                focusId={focus}
                sideId={showSide ? sideId : null}
                counts={counts}
                streaming={streamingIds}
                onNavigate={onMapNavigate}
                onExit={onMapExit}
              />
            </div>
          </div>
        )}
          </>
        )}
        <div className="mt-auto border-t border-line px-3 py-2">
          <button
            onClick={() => setSettingsOpen(true)}
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

      {home ? (
        <main className="min-w-0 flex-1">
          {openNote ? (
            <NoteEditor
              // Remounts when a note finishes writing, so it loads the saved file.
              key={liveNote?.path === openNote ? "live" : "file"}
              live={liveNote?.path === openNote ? liveNote.markdown : undefined}
              ref={editor}
              path={openNote}
              onError={report}
              links={linkHost}
              linksVersion={linksVersion}
              back={
                noteHistory.length
                  ? { label: noteHistory.at(-1)!.split("/").pop()!.replace(/\.md$/i, ""), go: () => void goBack() }
                  : undefined
              }
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">Open a note from the sidebar, or create one.</div>
          )}
        </main>
      ) : (
        <>
      {/* Center: the focused thread */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {focus && focusMessages.length > 0 && (
          <button
            onClick={() => makeNote(focus)}
            disabled={!!makingNote}
            className="absolute top-2.5 right-4 z-10 rounded-md border border-line bg-bg px-2.5 py-1 text-xs text-muted hover:text-fg disabled:cursor-wait disabled:opacity-70"
            title={nested ? "Summarize this branch and its branches into a note" : "Summarize this chat and its branches into a note"}
          >
            {makingNote === focus ? (
              <>
                <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />
                Making note…
              </>
            ) : (
              "Make note"
            )}
          </button>
        )}
        {nested && focusThread && (
          <header className="border-b border-line bg-accent-soft/60 py-3 pr-32 pl-6">
            <nav className="flex flex-wrap items-center gap-1 text-sm">
              {lineage.map((t, i) => (
                <span key={t.id} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <span className="text-muted">›</span>}
                  <button
                    onClick={() => goTo(t.id)}
                    className={`max-w-48 truncate rounded px-1 ${t.id === focus ? "font-medium text-fg" : "text-muted hover:text-fg"}`}
                  >
                    {t.parentThreadId ? t.title : "Main"}
                  </button>
                </span>
              ))}
            </nav>
            <button
              onClick={() => {
                goUp();
                if (focusThread.forkMessageId) setTimeout(() => jumpToSource(focusThread.forkMessageId!), 50);
              }}
              className="mt-1.5 block max-w-full truncate border-l-2 border-accent pl-2 text-left text-sm text-muted hover:text-fg"
              title="Go up to where this branched (Esc)"
            >
              {focusThread.anchorText ? `“${focusThread.anchorText}”` : "About the whole reply"}
            </button>
          </header>
        )}
        <div ref={mainScroll} onMouseUp={onMouseUp} onClick={onClick} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-8">
            {!rootId && <p className="mt-24 text-center text-muted">Start a conversation. Side questions stay out of its way.</p>}
            {focus && (
              <MessageList
                threadId={focus}
                messages={focusMessages}
                childThreads={branches}
                activeChildId={showSide ? sideId : null}
                flashId={flashId}
                onFork={(messageId) => fork(focus, messageId, null)}
                onOpen={openThread}
              />
            )}
            {focus && streaming[focus] !== undefined && <StreamingBubble content={streaming[focus]} />}
          </div>
        </div>
        <Composer
          ref={mainInput}
          onStop={() => focus && stop(focus)}
          busy={!!focus && streaming[focus] !== undefined}
          placeholder={nested ? "Continue this side thread…" : "Message the main thread…"}
          onSend={(text) => send(focus, text)}
          autoFocus
        />
      </main>

      {/* Side panel: children of the focused thread */}
      {showSide && (
        <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="font-medium">Side threads · {sideThreads.length}</span>
            <button onClick={() => setSideOpen(false)} className="text-muted hover:text-fg" title="Close (Esc)">
              ✕
            </button>
          </div>
          <div className="max-h-[35%] shrink-0 overflow-y-auto border-b border-line px-2 pb-2">
            {sideThreads.map((t) => (
              <div
                key={t.id}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                  t.id === sideId ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <button onClick={() => openThread(t.id)} className="min-w-0 flex-1 truncate text-left">
                  {streaming[t.id] !== undefined && <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />}
                  {t.title}
                </button>
                {(() => {
                  const n = childrenOf(t.id).filter((c) => c.kind !== "oneoff").length;
                  return n > 0 && <span className="text-xs text-accent" title="Has side threads">⑂{n}</span>;
                })()}
                <span className="text-xs tabular-nums">{counts.get(t.id) ?? 0}</span>
                <button onClick={() => deleteThread(t.id)} className="hidden text-xs group-hover:block hover:text-fg" title="Delete (and its side threads)">
                  ✕
                </button>
              </div>
            ))}
          </div>

          {activeSide ? (
            <>
              <div onMouseUp={onMouseUp} onClick={onClick} className="flex-1 overflow-y-auto px-4 py-4">
                <div className="mb-4 flex items-start gap-2">
                  <button
                    onClick={() => activeSide.forkMessageId && jumpToSource(activeSide.forkMessageId)}
                    className="min-w-0 flex-1 border-l-2 border-accent pl-3 text-left text-sm text-muted hover:text-fg"
                    title="Jump to where this branched"
                  >
                    {activeSide.anchorText ? `“${activeSide.anchorText}”` : "About the whole reply"}
                    <span className="mt-1 block text-xs text-accent">↖ jump to source</span>
                  </button>
                  {activeIsOneOff ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded-md border border-dashed border-accent/60 px-2 py-1 text-xs text-accent" title="Not in the map. Reopen it from its highlight.">
                        Not in map
                      </span>
                      <button
                        onClick={() => saveToMap(activeSide.id)}
                        className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
                        title="Turn this into a regular side thread"
                      >
                        Save to map
                      </button>
                      <button onClick={() => deleteThread(activeSide.id)} className="rounded-md px-1.5 py-1 text-xs text-muted hover:text-fg" title="Delete">
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => goTo(activeSide.id)}
                      className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-fg"
                      title="Open this thread in the center"
                    >
                      ⤢ Expand
                    </button>
                  )}
                </div>
                <MessageList
                  threadId={activeSide.id}
                  messages={messagesOf(activeSide.id)}
                  childThreads={childrenOf(activeSide.id)}
                  activeChildId={null}
                  flashId={null}
                  onFork={(messageId) => fork(activeSide.id, messageId, null)}
                  onOpen={openThread}
                  canBranch={!activeIsOneOff}
                  compact
                />
                {streaming[activeSide.id] !== undefined && <StreamingBubble content={streaming[activeSide.id]} compact />}
              </div>
              <Composer
                ref={sideInput}
                onStop={() => stop(activeSide.id)}
                busy={streaming[activeSide.id] !== undefined}
                placeholder={activeIsOneOff ? "Follow up…  (Esc to return)" : "Ask on the side…  (Esc to return)"}
                onSend={(text) => send(activeSide.id, text)}
                compact
              />
            </>
          ) : (
            <p className="p-6 text-sm text-muted">Pick a side thread, or highlight text in a reply and press {MOD}K.</p>
          )}
        </aside>
      )}
        </>
      )}

      {settingsOpen && <Settings onClose={closeSettings} />}

      {error && (
        <div
          role="alert"
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-bg px-4 py-2.5 text-sm shadow-lg"
        >
          <span className="size-2 shrink-0 rounded-full bg-danger" />
          {error}
          <button onClick={() => setError(null)} className="text-muted hover:text-fg" title="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* Floating "ask on the side" button for highlighted text */}
      {selection && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{ left: selection.x, top: selection.y - 40 }}
          className="fixed z-50 flex -translate-x-1/2 overflow-hidden rounded-md bg-fg text-xs font-medium text-bg shadow-lg"
        >
          <button onClick={() => fork(selection.threadId, selection.messageId, selection.text)} className="px-3 py-1.5 hover:bg-bg/15">
            Ask on the side <span className="opacity-60">{MOD}K</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** A thread's messages, with its side threads drawn as highlights (or chips, for whole-reply branches). */
function MessageList({
  threadId,
  messages,
  childThreads,
  activeChildId,
  flashId,
  onFork,
  onOpen,
  compact,
  canBranch = true,
}: {
  threadId: string;
  messages: Message[];
  childThreads: Thread[];
  activeChildId: string | null;
  flashId: string | null;
  onFork: (messageId: string) => void;
  onOpen: (threadId: string) => void;
  compact?: boolean;
  canBranch?: boolean;
}) {
  return messages.map((m) => {
    const branches = childThreads.filter((t) => t.forkMessageId === m.id);
    const saved = !m.id.startsWith("temp-");
    return (
      <div
        key={m.id}
        id={compact ? undefined : `msg-${m.id}`}
        className={`${compact ? "mb-4" : "mb-6"} rounded-lg transition-colors duration-700 ${flashId === m.id ? "bg-accent-soft" : ""}`}
      >
        <Bubble
          message={m}
          threadId={threadId}
          forkable={m.role === "assistant" && saved && canBranch}
          compact={compact}
          anchors={branches
            .filter((t) => t.anchorText)
            .map((t) => ({ threadId: t.id, text: t.anchorText!, active: t.id === activeChildId, oneOff: t.kind === "oneoff" }))}
        />
        {m.role === "assistant" && saved && canBranch && (
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
            {branches
              .filter((t) => !t.anchorText)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => onOpen(t.id)}
                  className={`max-w-64 truncate rounded-full border px-2.5 py-0.5 text-xs ${t.kind === "oneoff" ? "border-dashed" : ""} ${
                    t.id === activeChildId ? "border-accent text-accent" : "border-line text-muted hover:text-fg"
                  }`}
                >
                  ↳ {t.title}
                </button>
              ))}
            <button onClick={() => onFork(m.id)} className="rounded-full px-2 py-0.5 text-xs text-muted opacity-60 hover:opacity-100">
              + ask on the side
            </button>
          </div>
        )}
      </div>
    );
  });
}

type BubbleProps = {
  message: Pick<Message, "role" | "content"> & { id?: string };
  threadId?: string;
  forkable?: boolean;
  compact?: boolean;
  anchors?: Anchor[];
  /** A reply still streaming in: where each chunk starts, so new text fades in. */
  fade?: { starts: number[]; source: string };
};

/**
 * Memoized: rendering Markdown and running the highlight plugin is the most
 * expensive thing on screen, and most re-renders (every streamed chunk,
 * every keystroke) don't change a finished message. `anchors` is a fresh
 * array on every parent render, so compare it by value, not identity.
 */
const Bubble = memo(BubbleView, (a, b) =>
  a.message.content === b.message.content &&
  a.message.role === b.message.role &&
  a.message.id === b.message.id &&
  a.threadId === b.threadId &&
  a.forkable === b.forkable &&
  a.compact === b.compact &&
  a.fade?.starts.length === b.fade?.starts.length &&
  sameAnchors(a.anchors, b.anchors),
);

/**
 * The reply being streamed. Remembers where each arrival of text began, so
 * each one fades in as it appears instead of popping in. Unmounts when the
 * reply finishes, and the saved message renders plainly in its place.
 */
function StreamingBubble({ content, compact }: { content: string; compact?: boolean }) {
  const [track] = useState(() => ({ length: 0, starts: [] as number[] }));
  if (content.length > track.length) {
    track.starts.push(track.length);
    track.length = content.length;
  }
  if (!content) return <Bubble message={{ role: "assistant", content: "…" }} compact={compact} />;
  return <Bubble message={{ role: "assistant", content }} compact={compact} fade={{ starts: [...track.starts], source: content }} />;
}

function sameAnchors(a: Anchor[] = [], b: Anchor[] = []) {
  return (
    a.length === b.length &&
    a.every((x, i) => x.threadId === b[i].threadId && x.text === b[i].text && x.active === b[i].active && x.oneOff === b[i].oneOff)
  );
}

function BubbleView({ message, threadId, forkable, compact, anchors, fade }: BubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl bg-user px-4 py-2.5 ${compact ? "text-sm" : ""}`}>{message.content}</div>
      </div>
    );
  }
  return (
    <div
      data-fork-id={forkable ? message.id : undefined}
      data-fork-thread={forkable ? threadId : undefined}
      className={`md px-1 ${compact ? "text-sm" : ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[...(anchors?.length ? [[rehypeAnchors, { anchors }] satisfies Pluggable] : []), ...(fade ? [[rehypeFade, fade] satisfies Pluggable] : [])]}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}

function Composer({
  ref,
  busy,
  placeholder,
  onSend,
  onStop,
  compact,
  autoFocus,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  busy: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div className={`relative ${compact ? "border-t border-line p-3" : "mx-auto w-full max-w-3xl px-6 pb-6"}`}>
      {busy && (
        <button
          onClick={onStop}
          className={`absolute z-10 flex items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 py-1 text-xs text-muted shadow-sm hover:text-fg ${
            compact ? "right-5 bottom-5" : "right-8 bottom-8"
          }`}
          title="Stop generating"
        >
          <span className="size-2 rounded-[2px] bg-current" />
          Stop
        </button>
      )}
      <textarea
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        rows={compact ? 2 : 3}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (busy || !value.trim()) return;
            onSend(value);
            setValue("");
          }
        }}
        className="w-full resize-none rounded-xl border border-line bg-bg px-4 py-3 outline-none placeholder:text-muted focus:border-line-strong"
      />
    </div>
  );
}
