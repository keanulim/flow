"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Thread } from "@/lib/db";
import { rehypeAnchors, type Anchor } from "@/lib/rehype-anchors";
import ThreadMap from "./ThreadMap";

type Tree = { threads: Thread[]; messages: Message[] };
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

  // ---------- data ----------

  const loadConversations = useCallback(async () => {
    const list: Thread[] = await fetch("/api/threads").then((r) => r.json());
    setConversations(list);
    return list;
  }, []);

  const loadTree = useCallback(async (id: string) => {
    const t: Tree = await fetch(`/api/threads/${id}`).then((r) => r.json());
    setTree(t);
    return t;
  }, []);

  useEffect(() => {
    loadConversations().then((list) => list[0] && setRootId(list[0].id));
  }, [loadConversations]);

  useEffect(() => {
    setFocusId(rootId);
    setSideId(null);
    if (!rootId) return setTree({ threads: [], messages: [] });
    loadTree(rootId);
  }, [rootId, loadTree]);

  const byId = useMemo(() => new Map(tree.threads.map((t) => [t.id, t])), [tree.threads]);
  const childrenOf = useCallback(
    (id: string) => tree.threads.filter((t) => t.parentThreadId === id).sort((a, b) => a.createdAt - b.createdAt),
    [tree.threads],
  );
  const messagesOf = useCallback(
    (threadId: string) => tree.messages.filter((m) => m.threadId === threadId),
    [tree.messages],
  );
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of tree.messages) c.set(m.threadId, (c.get(m.threadId) ?? 0) + 1);
    return c;
  }, [tree.messages]);

  const focus = focusId ?? rootId;
  const focusThread = focus ? byId.get(focus) : undefined;
  const focusMessages = useMemo(() => (focus ? messagesOf(focus) : []), [focus, messagesOf]);
  // Every branch of the center thread (drawn as highlights) vs. the real side
  // threads (listed in the panel and the map). One-offs are only the former.
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

  /** Put `threadId` in the center, optionally with one of its children open on the side. */
  const goTo = useCallback((threadId: string, side: string | null = null, moveKeyboardFocus = true) => {
    setFocusId(threadId);
    setSideId(side);
    setSideOpen(!!side);
    setSelection(null);
    if (moveKeyboardFocus) requestAnimationFrame(() => (side ? sideInput : mainInput).current?.focus());
  }, []);

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

  const goUp = useCallback(() => {
    if (focusThread?.parentThreadId) goTo(focusThread.parentThreadId, focusThread.id);
  }, [focusThread, goTo]);

  const jumpToSource = useCallback((messageId: string) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(messageId);
    setTimeout(() => setFlashId(null), 1200);
  }, []);

  // ---------- actions ----------

  const newConversation = useCallback(async () => {
    const t: Thread = await fetch("/api/threads", { method: "POST", body: "{}" }).then((r) => r.json());
    await loadConversations();
    setRootId(t.id);
    mainInput.current?.focus();
    return t.id;
  }, [loadConversations]);

  const send = useCallback(
    async (threadId: string | null, content: string) => {
      const text = content.trim();
      if (!text) return;
      const target = threadId ?? (await newConversation());

      // Optimistic: show the user's message and an empty streaming reply immediately.
      const temp: Message = { id: `temp-${Date.now()}`, threadId: target, role: "user", content: text, createdAt: Date.now() };
      setTree((t) => ({ ...t, messages: [...t.messages, temp] }));
      setStreaming((s) => ({ ...s, [target]: "" }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: target, content: text }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setStreaming((s) => ({ ...s, [target]: (s[target] ?? "") + chunk }));
      }

      // Swap the optimistic state for the saved rows (real ids, needed for forking).
      // An existing thread lives in the current tree; otherwise `target` is the
      // conversation we just created.
      await loadTree(threadId && rootId ? rootId : target);
      setStreaming((s) => {
        const rest = { ...s };
        delete rest[target];
        return rest;
      });
      loadConversations();
    },
    [newConversation, loadTree, loadConversations, rootId],
  );

  /** Branch from a message in `fromThreadId`. Branching from the side panel drills into it. */
  const fork = useCallback(
    async (fromThreadId: string, messageId: string, anchorText: string | null, kind: Thread["kind"] = "thread") => {
      if (!rootId) return;
      const t: Thread = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentThreadId: fromThreadId, forkMessageId: messageId, anchorText, kind }),
      }).then((r) => r.json());
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      await loadTree(rootId);
      if (fromThreadId === focus) {
        setSideId(t.id);
        setSideOpen(true);
        requestAnimationFrame(() => sideInput.current?.focus());
      } else {
        goTo(fromThreadId, t.id);
      }
    },
    [rootId, focus, loadTree, goTo],
  );

  const saveToMap = useCallback(
    async (id: string) => {
      await fetch(`/api/threads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "thread" }),
      });
      if (rootId) await loadTree(rootId); // it stays open on the side, now as a regular thread
    },
    [rootId, loadTree],
  );

  const deleteThread = useCallback(
    async (id: string) => {
      await fetch(`/api/threads/${id}`, { method: "DELETE" });
      if (sideId === id) setSideId(null);
      if (rootId) loadTree(rootId);
    },
    [sideId, rootId, loadTree],
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
        // ⇧⌘K: a one-off about the highlight (needs a highlight, there's no whole-reply version)
        if (e.shiftKey) {
          if (selection) fork(selection.threadId, selection.messageId, selection.text, "oneoff");
          return;
        }
        if (selection) return void fork(selection.threadId, selection.messageId, selection.text);
        const lastReply = [...focusMessages].reverse().find((m) => m.role === "assistant" && !m.id.startsWith("temp-"));
        if (focus && lastReply) fork(focus, lastReply.id, null);
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
  }, [selection, fork, focus, focusMessages, rootId, goTo, goUp, showSide, sideThreads, sideId, openThread]);

  // Keep the center pinned to the bottom while it streams (only if already near the bottom).
  useEffect(() => {
    const el = mainScroll.current;
    if (!el || !focus || streaming[focus] === undefined) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [streaming, focus]);

  const nested = !!focusThread?.parentThreadId;

  // ---------- render ----------

  return (
    <div className="flex h-dvh text-[15px]">
      {/* Conversations + map */}
      <aside
        // Clicking anywhere on the sidebar except its own buttons (conversation
        // list, + New) enters map mode, so WASD works without aiming at a dot.
        onMouseDown={(e) => {
          const target = e.target as Element;
          const control = target.closest("button, a, input, textarea");
          if (control && !mapRef.current?.contains(control)) return;
          e.preventDefault(); // no text selection, no focus flicker
          mapRef.current?.focus();
        }}
        className="flex w-64 shrink-0 flex-col border-r border-line bg-panel"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-semibold tracking-tight">Flow</span>
          <button onClick={newConversation} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-hover hover:text-fg">
            + New
          </button>
        </div>
        <nav className="max-h-[35%] shrink-0 overflow-y-auto px-2 pb-3">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => (c.id === rootId ? goTo(c.id) : setRootId(c.id))}
              className={`block w-full truncate rounded-md px-3 py-2 text-left text-sm ${
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
                threads={tree.threads.filter((t) => t.kind !== "oneoff")}
                rootId={rootId}
                focusId={focus}
                sideId={showSide ? sideId : null}
                counts={counts}
                streaming={new Set(Object.keys(streaming))}
                onNavigate={(id) => goTo(id, null, false)}
                onExit={() => mainInput.current?.focus()}
              />
            </div>
          </div>
        )}
        <div className="mt-auto space-y-1 border-t border-line px-4 py-3 text-xs text-muted">
          <Shortcut k={`${MOD}K`} label="ask on the side" />
          <Shortcut k={`⇧${MOD}K`} label="one-off question" />
          <Shortcut k="Esc" label="close panel / up a level" />
          <Shortcut k="⇧Esc" label="back to main" />
          <Shortcut k="⌥↑ ⌥↓" label="switch side threads" />
          <Shortcut k={`${MOD}\\`} label="toggle side panel" />
        </div>
      </aside>

      {/* Center: the focused thread */}
      <main className="flex min-w-0 flex-1 flex-col">
        {nested && focusThread && (
          <header className="border-b border-line bg-accent-soft/60 px-6 py-3">
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
            {focus && streaming[focus] !== undefined && <Bubble message={{ role: "assistant", content: streaming[focus] || "…" }} />}
          </div>
        </div>
        <Composer
          ref={mainInput}
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
                        One-off
                      </span>
                      <button
                        onClick={() => saveToMap(activeSide.id)}
                        className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
                        title="Turn this into a regular side thread"
                      >
                        Save to map
                      </button>
                      <button onClick={() => deleteThread(activeSide.id)} className="rounded-md px-1.5 py-1 text-xs text-muted hover:text-fg" title="Delete one-off">
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
                {streaming[activeSide.id] !== undefined && <Bubble message={{ role: "assistant", content: streaming[activeSide.id] || "…" }} compact />}
              </div>
              <Composer
                ref={sideInput}
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

      {/* Floating "ask on the side" button for highlighted text */}
      {selection && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{ left: selection.x, top: selection.y - 40 }}
          className="fixed z-50 flex -translate-x-1/2 overflow-hidden rounded-md bg-fg text-xs font-medium text-bg shadow-lg"
        >
          <button onClick={() => fork(selection.threadId, selection.messageId, selection.text)} className="px-3 py-1.5 hover:bg-white/10">
            Ask on the side <span className="opacity-60">{MOD}K</span>
          </button>
          {/* One-offs can only hang off center/side threads that may branch */}
          {byId.get(selection.threadId)?.kind !== "oneoff" && (
            <button
              onClick={() => fork(selection.threadId, selection.messageId, selection.text, "oneoff")}
              className="border-l border-white/20 px-3 py-1.5 hover:bg-white/10"
            >
              One-off <span className="opacity-60">⇧{MOD}K</span>
            </button>
          )}
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
                  className={`max-w-64 truncate rounded-full border px-2.5 py-0.5 text-xs ${
                    t.id === activeChildId ? "border-accent text-accent" : "border-line text-muted hover:text-fg"
                  }`}
                >
                  ↳ {t.title}
                </button>
              ))}
            <button onClick={() => onFork(m.id)} className="rounded-full px-2 py-0.5 text-xs text-muted opacity-60 hover:opacity-100">
              + side thread
            </button>
          </div>
        )}
      </div>
    );
  });
}

function Shortcut({ k, label }: { k: string; label: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <kbd className="font-sans text-fg/70">{k}</kbd>
    </div>
  );
}

function Bubble({
  message,
  threadId,
  forkable,
  compact,
  anchors,
}: {
  message: Pick<Message, "role" | "content"> & { id?: string };
  threadId?: string;
  forkable?: boolean;
  compact?: boolean;
  anchors?: Anchor[];
}) {
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={anchors?.length ? [[rehypeAnchors, { anchors }]] : []}>
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
  compact,
  autoFocus,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  busy: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div className={compact ? "border-t border-line p-3" : "mx-auto w-full max-w-3xl px-6 pb-6"}>
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
        className="w-full resize-none rounded-xl border border-line bg-bg px-4 py-3 outline-none placeholder:text-muted focus:border-accent"
      />
    </div>
  );
}
