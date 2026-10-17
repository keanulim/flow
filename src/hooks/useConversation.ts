"use client";

import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import type { Message, Thread } from "@/lib/db";

export type Tree = { threads: Thread[]; messages: Message[] };
const NO_MESSAGES: Message[] = [];
const EMPTY: Tree = { threads: [], messages: [] };

type Options = {
  report: (e: unknown) => void;
  /** Message boxes to move the keyboard to when navigating. */
  mainInput: RefObject<HTMLTextAreaElement | null>;
  sideInput: RefObject<HTMLTextAreaElement | null>;
  /** Called on every navigation and branch (e.g. to drop a pending text selection). */
  onNavigate: () => void;
};

/**
 * The conversation list and the open conversation: its thread tree, which
 * thread is in the center ("focus"), which child is open in the side panel,
 * and the actions that change them.
 *
 * Navigation model: the center shows the focused thread (main, or any side
 * thread you've drilled into); the side panel shows the focused thread's
 * children. Branching from inside the side panel promotes that side thread to
 * the center, so you only ever see two levels at once.
 */
export function useConversation({ report, mainInput, sideInput, onNavigate }: Options) {
  const [conversations, setConversations] = useState<Thread[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree>(EMPTY);
  const [sideId, setSideId] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(true);
  // A thread to show once its conversation has loaded (e.g. from a chat link; it may be deep inside).
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);

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

  useEffect(() => void loadConversations(), [loadConversations]);

  // Opening a conversation: start at its main thread with the side panel empty.
  useEffect(() => {
    setFocusId(rootId);
    setSideId(null);
    if (!rootId) return setTree(EMPTY);
    let cancelled = false;
    api(`/api/threads/${rootId}`)
      .then((r) => r.json())
      .then((t: Tree) => !cancelled && setTree(t))
      .catch((e) => !cancelled && report(e));
    return () => {
      cancelled = true;
    };
  }, [rootId, report]);

  // ---------- derived ----------

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
  const focusMessages = useMemo(() => (focus ? messagesOf(focus) : NO_MESSAGES), [focus, messagesOf]);
  // Every branch of the center thread (drawn as highlights) vs. the real side
  // threads (listed in the panel and the map). Unsaved "ask on the side"
  // branches (kind "oneoff") are only the former.
  const branches = useMemo(() => (focus ? childrenOf(focus) : []), [focus, childrenOf]);
  const sideThreads = useMemo(() => branches.filter((t) => t.kind !== "oneoff"), [branches]);
  const activeSide = branches.find((t) => t.id === sideId) ?? null;
  const activeIsOneOff = activeSide?.kind === "oneoff";
  const showSide = sideOpen && (sideThreads.length > 0 || activeIsOneOff);

  /** Main › first side › … › focus, for the breadcrumbs. */
  const lineage = useMemo(() => {
    const out: Thread[] = [];
    for (let t = focus ? byId.get(focus) : undefined; t; t = t.parentThreadId ? byId.get(t.parentThreadId) : undefined) out.unshift(t);
    return out;
  }, [focus, byId]);

  /** The map lists saved threads only; a stable array so the memoized map can skip re-renders. */
  const mapThreads = useMemo(() => tree.threads.filter((t) => t.kind !== "oneoff"), [tree.threads]);

  // ---------- navigation ----------

  /** Put `threadId` in the center, optionally with one of its children open on the side. */
  const goTo = useCallback(
    (threadId: string, side: string | null = null, moveKeyboardFocus = true) => {
      setFocusId(threadId);
      setSideId(side);
      setSideOpen(!!side);
      onNavigate();
      if (moveKeyboardFocus) requestAnimationFrame(() => (side ? sideInput : mainInput).current?.focus());
    },
    [onNavigate, mainInput, sideInput],
  );

  /** Show a child thread on the side, with the keyboard in its message box. */
  const showOnSide = useCallback(
    (id: string) => {
      setSideId(id);
      setSideOpen(true);
      requestAnimationFrame(() => sideInput.current?.focus());
    },
    [sideInput],
  );

  /** Open a child thread: on the side if it hangs off the center thread, else drill in. */
  const openThread = useCallback(
    (id: string) => {
      const t = byId.get(id);
      if (!t?.parentThreadId) return;
      if (t.parentThreadId === focus) showOnSide(id);
      else goTo(t.parentThreadId, id);
    },
    [byId, focus, goTo, showOnSide],
  );

  /** Up one level: the parent in the center, with this thread open beside it. */
  const goUp = useCallback(() => {
    if (focusThread?.parentThreadId) goTo(focusThread.parentThreadId, focusThread.id);
  }, [focusThread, goTo]);

  /** Show a thread once its conversation is loaded: a side question on the side of its parent, any other thread in the center. */
  const reveal = useCallback((id: string) => setPendingReveal(id), []);
  useEffect(() => {
    if (!pendingReveal) return;
    const t = byId.get(pendingReveal);
    if (!t) return; // not loaded yet
    setPendingReveal(null);
    if (!t.parentThreadId) return; // the main thread: already in the center
    if (t.kind === "oneoff") goTo(t.parentThreadId, t.id);
    else goTo(t.id);
  }, [pendingReveal, byId, goTo]);

  /**
   * Whether it's OK to retry a reply: replacing it also deletes the side threads
   * branched from it, so ask first when there are any.
   */
  const confirmRetry = useCallback(
    (messageId: string) => {
      const n = tree.threads.filter((t) => t.forkMessageId === messageId).length;
      return n === 0 || confirm(`Retrying replaces this reply and deletes the ${n === 1 ? "side thread" : `${n} side threads`} branched from it. Retry anyway?`);
    },
    [tree.threads],
  );

  /** Pick up a thread's new title (titles are written by the model after a thread's first reply). */
  const refreshThread = useCallback(
    async (id: string) => {
      try {
        const sub: Tree = await (await api(`/api/threads/${id}`)).json();
        const fresh = sub.threads.find((t) => t.id === id);
        if (fresh) setTree((t) => ({ ...t, threads: t.threads.map((x) => (x.id === id && x.title !== fresh.title ? { ...x, title: fresh.title } : x)) }));
      } catch {
        // Only a title; the next load picks it up.
      }
    },
    [],
  );

  // ---------- thread actions ----------

  /** Branch from a message. Branches start as unsaved side questions; branching from the side panel drills into it. */
  const fork = useCallback(
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
      onNavigate();
      setTree((tr) => ({ ...tr, threads: [...tr.threads, t] }));
      if (fromThreadId === focus) showOnSide(t.id);
      else goTo(fromThreadId, t.id);
    },
    [rootId, focus, goTo, showOnSide, onNavigate, report],
  );

  /** Promote a side question to a saved side thread (it joins the map). */
  const saveToMap = useCallback(
    async (id: string) => {
      let saved: Thread;
      try {
        saved = await (
          await api(`/api/threads/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "thread" }) })
        ).json();
      } catch (e) {
        return report(e);
      }
      // It stays open on the side, now as a regular thread.
      setTree((t) => ({ ...t, threads: t.threads.map((x) => (x.id === id ? saved : x)) }));
    },
    [report],
  );

  /** Delete a side thread and everything under it. */
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
        return { threads: t.threads.filter((x) => !gone.has(x.id)), messages: t.messages.filter((m) => !gone.has(m.threadId)) };
      });
    },
    [sideId, report],
  );

  return {
    conversations,
    loadConversations,
    rootId,
    setRootId,
    tree,
    setTree,
    byId,
    childrenOf,
    messagesOf,
    counts,
    focus,
    focusThread,
    focusMessages,
    branches,
    sideThreads,
    sideId,
    activeSide,
    activeIsOneOff,
    showSide,
    setSideOpen,
    lineage,
    mapThreads,
    goTo,
    openThread,
    goUp,
    reveal,
    refreshThread,
    confirmRetry,
    fork,
    saveToMap,
    deleteThread,
  };
}

export type Conversation = ReturnType<typeof useConversation>;
