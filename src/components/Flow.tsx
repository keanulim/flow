"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, devMockHeader } from "@/lib/client";
import type { NoteEvent } from "@/lib/chat-note";
import type { Thread } from "@/lib/db";
import { HOME_NOTE, HOME_WELCOME } from "@/lib/home-note";
import { isNotePath, listNotes, listOtherFiles } from "@/lib/notes";
import type { LinkHost } from "@/lib/wikilinks";
import { useChatIndex } from "@/hooks/useChatIndex";
import { useConversation } from "@/hooks/useConversation";
import { useStreaming } from "@/hooks/useStreaming";
import { useVault } from "@/hooks/useVault";
import ThreadMap from "./ThreadMap";
import ThreadPane from "./chat/ThreadPane";
import SidePanel from "./chat/SidePanel";
import Sidebar from "./Sidebar";
import ContextMenu from "./ContextMenu";
import Settings from "./Settings";
import AssistantPanel from "./AssistantPanel";
import LambdaMark from "./LambdaMark";
import ImageView from "./ImageView";

// The notes editor (CodeMirror) is only downloaded once a note is opened, so
// the chat view doesn't load it.
const NoteEditor = dynamic(() => import("./NoteEditor"), { ssr: false });

type Selection = { text: string; threadId: string; messageId: string; x: number; y: number };

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";
const HOME_PATH = `${HOME_NOTE}.md`;

/**
 * The app: chats on one side, notes (Home) on the other. State and actions
 * live in hooks (conversation, streaming, vault, chat index); this component
 * connects them, owns moving between Home and chats, and lays out the page.
 */
export default function Flow() {
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [home, setHome] = useState(false); // the main area shows a note instead of a conversation
  // What the sidebar lists: files or chats. Separate from `home`: Home opens the
  // Home note without switching the sidebar, so you can be on Home with chats listed.
  const [filesSide, setFilesSide] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false); // the AI assistant beside the open note
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [selection, setSelection] = useState<Selection | null>(null); // highlighted text in a reply
  const [flashId, setFlashId] = useState<string | null>(null);

  const mainInput = useRef<HTMLTextAreaElement>(null);
  const sideInput = useRef<HTMLTextAreaElement>(null);
  const mainScroll = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const lastConversation = useRef<string | null>(null); // where "Chats" returns to from Home

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

  const clearSelection = useCallback(() => setSelection(null), []);
  const conv = useConversation({ report, mainInput, sideInput, onNavigate: clearSelection });
  const { conversations, loadConversations, rootId, setRootId, tree, setTree, counts } = conv;
  const { focus, focusMessages, sideThreads, sideId, showSide, setSideOpen } = conv;
  const { goTo, openThread, goUp, reveal, fork } = conv;

  const vault = useVault(report);
  const { files, loadFiles, openNote, openFresh, noteHistory, goBack, editor, noteList, resolveLink, openLink, resolveEmbed, addImage } = vault;
  const { loadChatIndex, chatOptions, chatExists } = useChatIndex(report);

  /** Start a conversation and show it. Throws on failure; callers catch. */
  const newConversation = useCallback(async () => {
    const t: Thread = await (await api("/api/threads", { method: "POST", body: "{}" })).json();
    await loadConversations();
    setHome(false);
    setFilesSide(false);
    setRootId(t.id);
    mainInput.current?.focus();
    return t.id;
  }, [loadConversations, setRootId]);

  // After a reply: refresh titles (the chat list, and a branch's own title once it's written).
  const { refreshThread } = conv;
  const onReplyDone = useCallback(
    (threadId: string) => {
      void loadConversations();
      if (threadId !== rootId) void refreshThread(threadId);
    },
    [loadConversations, refreshThread, rootId],
  );
  const { streaming, activity, send, retry, stop } = useStreaming({ report, setTree, newConversation, onReplyDone });

  // ---------- chat search ----------

  // Titles and message text (side threads included) as you type. Debounced,
  // and a newer keystroke cancels an older request so results can't arrive out of order.
  // Re-runs when the conversation list changes, so new messages become searchable.
  const [matches, setMatches] = useState<Set<string> | null>(null); // null = not searching
  useEffect(() => {
    const q = query.trim();
    if (!q || filesSide) return setMatches(null); // with files listed, the file tree filters by name
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
  }, [query, conversations, filesSide, report]);
  const shownConversations = matches ? conversations.filter((c) => matches.has(c.id)) : conversations;

  // ---------- moving between Home and chats ----------

  // Bumped by every navigation, so a slow one (Home creating its note, at
  // startup) can tell it was overtaken and not pull the view back.
  const navSeq = useRef(0);

  /** Home opens its own note, Home.md at the top of the vault (the sidebar stays as it is). If it isn't there, it's created with a welcome guide. */
  const goHome = useCallback(async () => {
    const nav = ++navSeq.current;
    lastConversation.current = rootId;
    setHome(true);
    setRootId(null); // clears the tree, map and side panel
    setQuery("");
    void loadChatIndex();
    await editor.current?.flush(); // if a note is open, save it before switching
    const list = await loadFiles();
    if (!list || nav !== navSeq.current) return; // couldn't reach the server (already reported), or the user went elsewhere
    if (!list.some((e) => e.type === "file" && e.path === HOME_PATH)) {
      // No Home note yet: create it, starting with the guide to Flow.
      try {
        await api("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent: "", name: HOME_NOTE, type: "file" }) });
        await api("/api/files/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: HOME_PATH, content: HOME_WELCOME }) });
      } catch (e) {
        return report(e);
      }
      await loadFiles();
    }
    if (nav !== navSeq.current) return; // the user went elsewhere meanwhile
    openFresh(HOME_PATH);
  }, [rootId, setRootId, editor, loadFiles, openFresh, loadChatIndex, report]);

  // The last note open other than Home, for coming back to Files.
  const lastNote = useRef<string | null>(null);
  useEffect(() => {
    if (openNote && openNote !== HOME_PATH) lastNote.current = openNote;
  }, [openNote]);

  /** Files: list the files and show the last note open there (none: an empty page, not Home). */
  const goToFiles = useCallback(async () => {
    navSeq.current++;
    setFilesSide(true);
    setQuery("");
    if (home && openNote && openNote !== HOME_PATH) return; // a note and its files are already showing
    if (!home) lastConversation.current = rootId;
    await editor.current?.flush(); // leaving Home: save it first
    // Pick the note from the list we already have, then switch the main area and
    // the note in one update. (Switching first and picking after reloading the
    // list showed Home, still the open note from before, for a moment.)
    const back = lastNote.current;
    const known = files ?? [];
    const exists = !!back && (listNotes(known).some((n) => n.path === back) || listOtherFiles(known).some((f) => f.path === back));
    setHome(true);
    setRootId(null);
    openFresh(exists ? back : null);
    void loadChatIndex();
    void loadFiles();
  }, [home, openNote, rootId, setRootId, editor, files, loadFiles, loadChatIndex, openFresh]);

  // Following a link out of Home (or opening a note any other way) brings the file list back.
  useEffect(() => {
    if (home && openNote && openNote !== HOME_PATH) setFilesSide(true);
  }, [home, openNote]);

  // The app starts on Home. (Once: goHome changes whenever the open chat does.)
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void goHome();
  }, [goHome]);

  /** Leave Home: back to the last conversation, else the most recent one. */
  const goToChats = useCallback(() => {
    navSeq.current++;
    const id = conversations.some((c) => c.id === lastConversation.current) ? lastConversation.current : (conversations[0]?.id ?? null);
    setHome(false);
    setFilesSide(false);
    setQuery("");
    setRootId(id);
  }, [conversations, setRootId]);

  /** Show a conversation (leaving Home). Re-selecting the open one returns to its main thread. */
  const openConversation = useCallback(
    (id: string) => {
      navSeq.current++;
      setHome(false);
    setFilesSide(false);
      if (id === rootId) goTo(id);
      else setRootId(id);
    },
    [rootId, goTo, setRootId],
  );

  /** Follow a link to a chat (or a branch deep inside one) from a note. */
  const openChat = useCallback(
    async (id: string) => {
      try {
        const { rootId: root } = (await (await api(`/api/threads/${id}/root`)).json()) as { rootId: string };
        await editor.current?.flush();
        reveal(id);
        setHome(false);
    setFilesSide(false);
        setQuery("");
        setRootId(root);
      } catch (e) {
        report(e);
      }
    },
    [editor, reveal, setRootId, report],
  );

  // Right-click a chat in the sidebar: rename it, or delete it with all its branches and side questions.
  const [chatMenu, setChatMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeChatMenu = useCallback(() => setChatMenu(null), []);
  const [renamingChat, setRenamingChat] = useState<string | null>(null);
  const renameChat = useCallback(
    async (id: string, name: string | null) => {
      setRenamingChat(null);
      const old = conversations.find((c) => c.id === id)?.title;
      if (!name || name === old) return; // Esc, empty, or unchanged
      try {
        await api(`/api/threads/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: name }) });
      } catch (e) {
        return report(e);
      }
      await loadConversations();
      void loadChatIndex(); // [[ suggestions show the new name
      if (id === rootId) void refreshThread(id); // the map shows it too
    },
    [conversations, rootId, loadConversations, loadChatIndex, refreshThread, report],
  );
  const deleteChat = useCallback(
    async (id: string) => {
      const title = conversations.find((c) => c.id === id)?.title ?? "this chat";
      if (!confirm(`Delete “${title}” with all its branches and side questions? This can't be undone.`)) return;
      try {
        await api(`/api/threads/${id}`, { method: "DELETE" }); // the database removes everything under it
      } catch (e) {
        return report(e);
      }
      if (lastConversation.current === id) lastConversation.current = null;
      const list = await loadConversations();
      void loadChatIndex(); // links to it now show as deleted
      if (rootId === id) setRootId(list[0]?.id ?? null); // it was open: show the next most recent
    },
    [conversations, rootId, setRootId, loadConversations, loadChatIndex, report],
  );

  /**
   * Turn the focused chat (and everything branched off it, nothing above) into
   * a note. The note opens on Home straight away and fills in as it's written:
   * the server streams one JSON event per line (see NoteEvent).
   */
  const [makingNote, setMakingNote] = useState<string | null>(null); // thread id being summarized
  // A note being written by the AI (Make note, or the assistant editing it): shown read-only as it changes.
  const [liveNote, setLiveNote] = useState<{ path: string; markdown: string; label: string } | null>(null);
  // The note assistant: save the editor before it reads the note, show its edits live, reload after an undo.
  const [noteVersion, setNoteVersion] = useState(0);
  const flushNote = useCallback(async () => {
    await editor.current?.flush();
  }, [editor]);
  const setAssistantLive = useCallback(
    (markdown: string | null) => setLiveNote(markdown === null || !openNote ? null : { path: openNote, markdown, label: "AI is editing…" }),
    [openNote],
  );
  const reloadNote = useCallback(() => setNoteVersion((v) => v + 1), []);

  const makeNote = useCallback(
    async (threadId: string) => {
      setMakingNote(threadId);
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
              setLiveNote({ path: e.path, markdown: "", label: "Writing from chat…" });
              void loadChatIndex(); // fresh chat titles for [[ suggestions
              await loadFiles(); // before switching, so Home doesn't flash an empty file list
              lastConversation.current = rootId; // "Chats" comes back here
              setHome(true);
              setFilesSide(true);
              setRootId(null);
              setQuery("");
              openFresh(e.path);
            } else if (e.type === "snapshot") {
              setLiveNote((n) => n && { ...n, markdown: e.markdown });
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
    [rootId, setRootId, loadFiles, openFresh, loadChatIndex, report],
  );

  // ---------- notes: links ----------

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
  const linksVersion = useMemo(() => ({}), [files, chatOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const linkHost = useMemo<LinkHost>(
    () => ({
      exists: (target) => resolveLink(target, openNote) !== null,
      open: (target) => void openLink(target),
      notes: () => noteList.map(({ name, folder }) => ({ name, folder })),
      chats: () => chatOptions,
      chatExists,
      openChat: (id) => void openChat(id),
      imageUrl: (target) => {
        const path = resolveEmbed(target, openNote);
        return path ? `/api/files/raw?path=${encodeURIComponent(path)}` : null;
      },
      saveImage: (file) => addImage(file, openNote),
    }),
    [resolveLink, openNote, openLink, noteList, chatOptions, chatExists, openChat, resolveEmbed, addImage],
  );

  // ---------- chats: text selection, highlights, clicks ----------

  const jumpToSource = useCallback((messageId: string) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(messageId);
    setTimeout(() => setFlashId(null), 1200);
  }, []);

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return setSelection(null);
    const host = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-fork-id]");
    const a = host(sel.anchorNode);
    const b = host(sel.focusNode);
    const text = sel.toString().trim();
    if (!a || a !== b || !text) return setSelection(null);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({ text, threadId: a.dataset.forkThread!, messageId: a.dataset.forkId!, x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  /**
   * Clicking anywhere in the center (messages, empty space, the message box)
   * closes the side panel, like clicking off a popover. Not when the click
   * opens a highlight, presses a button or link, or finishes selecting text.
   */
  const clickOffSide = useCallback(
    (e: React.MouseEvent) => {
      if (!showSide) return;
      if ((e.target as Element).closest("mark[data-thread-id], button, a")) return;
      if (!window.getSelection()?.isCollapsed) return;
      setSideOpen(false);
    },
    [showSide, setSideOpen],
  );

  /** A click on a highlight opens its side thread (unless it ends a text selection). */
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const mark = (e.target as Element).closest<HTMLElement>("mark[data-thread-id]");
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
        openThread(sideThreads[(i + step + sideThreads.length) % sideThreads.length].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, fork, focus, focusMessages, rootId, goTo, goUp, showSide, setSideOpen, sideThreads, sideId, openThread, home, noteHistory, goBack]);

  // Keep the center pinned to the bottom while it streams (only if already near the bottom).
  useEffect(() => {
    const el = mainScroll.current;
    if (!el || !focus || streaming[focus] === undefined) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [streaming, focus]);

  // The Home note is reached with the Home button, not listed with the other files;
  // the button is highlighted only while that note is open.
  const onHomeNote = home && openNote === HOME_PATH;
  const sidebarFiles = useMemo(() => files?.filter((e) => e.path !== HOME_PATH) ?? null, [files]);

  // Map props that stay the same object until they really change, so the
  // memoized map skips the many re-renders while a reply streams.
  const mapThreads = conv.mapThreads;
  const streamingKey = Object.keys(streaming).sort().join(","); // which threads stream, not their text
  const streamingIds = useMemo(() => new Set(streamingKey ? streamingKey.split(",") : []), [streamingKey]);
  const onMapNavigate = useCallback((id: string) => goTo(id, null, false), [goTo]);
  const onMapExit = useCallback(() => mainInput.current?.focus(), []);

  const fileActions = useMemo(
    () => ({ onOpen: openFresh, onCreate: vault.createEntry, onRename: vault.renameEntry, onMove: vault.moveEntry, onDelete: vault.deleteEntry }),
    [openFresh, vault.createEntry, vault.renameEntry, vault.moveEntry, vault.deleteEntry],
  );

  // ---------- render ----------

  return (
    <div className="flex h-dvh text-[15px]">
      <Sidebar
        view={onHomeNote ? "home" : filesSide ? "files" : "chats"}
        filesSide={filesSide}
        query={query}
        onQuery={setQuery}
        onHome={goHome}
        onChats={goToChats}
        onFiles={() => void goToFiles()}
        onNewChat={() => newConversation().catch(report)}
        onSettings={() => setSettingsOpen(true)}
        files={sidebarFiles}
        activeNote={openNote}
        fileActions={fileActions}
        conversations={shownConversations}
        searching={!!matches}
        activeChat={rootId}
        onOpenChat={openConversation}
        onChatMenu={(id, x, y) => setChatMenu({ id, x, y })}
        renamingChat={renamingChat}
        onRenameChat={renameChat}
        mapRef={mapRef}
        map={
          rootId && focus && tree.threads.length > 0 ? (
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
          ) : null
        }
      />

      {home ? (
        <>
        <main className="min-w-0 flex-1">
          {openNote && !isNotePath(openNote) ? (
            <ImageView path={openNote} />
          ) : openNote ? (
            <NoteEditor
              // Remounts when a note finishes writing, so it loads the saved file.
              // Remounts after an undo too (noteVersion), to load the file again.
              key={`${liveNote?.path === openNote ? "live" : "file"}-${noteVersion}`}
              live={liveNote?.path === openNote ? liveNote.markdown : undefined}
              liveLabel={liveNote?.label}
              ref={editor}
              path={openNote}
              onError={report}
              links={linkHost}
              linksVersion={linksVersion}
              back={noteHistory.length ? { label: noteHistory.at(-1)!.split("/").pop()!.replace(/\.md$/i, ""), go: () => void goBack() } : undefined}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">Open a note from the sidebar, or create one.</div>
          )}
        </main>
        {assistantOpen && openNote && isNotePath(openNote) && (
          <AssistantPanel
            notePath={openNote}
            onBeforeSend={flushNote}
            onLive={setAssistantLive}
            onReload={reloadNote}
            onFilesChanged={() => void loadFiles()}
            onOpenNote={(path) => void vault.goToNote(path)}
            onClose={() => setAssistantOpen(false)}
            onError={report}
          />
        )}
        {/* The AI assistant button (bottom right), for the open note */}
        {!assistantOpen && openNote && isNotePath(openNote) && (
          <button
            onClick={() => setAssistantOpen(true)}
            title="Ask AI about this note"
            aria-label="Ask AI about this note"
            className="fixed right-6 bottom-6 z-40 flex size-11 items-center justify-center rounded-full border border-line bg-white text-black shadow-md transition-transform hover:scale-105"
          >
            <LambdaMark className="size-4" />
          </button>
        )}
        </>
      ) : (
        <>
          <ThreadPane
            conv={conv}
            streaming={streaming}
            activity={activity}
            send={send}
            retry={retry}
            stop={stop}
            makingNote={makingNote}
            onMakeNote={makeNote}
            flashId={flashId}
            onJumpToSource={jumpToSource}
            onMouseUp={onMouseUp}
            onClick={onClick}
            onClickAnywhere={clickOffSide}
            inputRef={mainInput}
            scrollRef={mainScroll}
          />
          {showSide && (
            <SidePanel conv={conv} streaming={streaming} activity={activity} send={send} retry={retry} stop={stop} onJumpToSource={jumpToSource} onMouseUp={onMouseUp} onClick={onClick} inputRef={sideInput} />
          )}
        </>
      )}

      {chatMenu && (
        <ContextMenu
          x={chatMenu.x}
          y={chatMenu.y}
          onClose={closeChatMenu}
          items={[
            { label: "Rename", run: () => setRenamingChat(chatMenu.id) },
            { label: "Delete chat", run: () => void deleteChat(chatMenu.id), danger: true },
          ]}
        />
      )}
      {settingsOpen && <Settings onClose={closeSettings} />}

      {error && (
        <div role="alert" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-bg px-4 py-2.5 text-sm shadow-lg">
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
