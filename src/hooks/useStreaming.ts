"use client";

import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";
import type { Message } from "@/lib/db";
import { postChat } from "@/lib/chat-stream";
import { type Attachment, EMPTY_REPLY, type Source, STOPPED_NOTE, withSources } from "@/lib/shared";
import type { Tree } from "./useConversation";

type Options = {
  report: (e: unknown) => void;
  setTree: Dispatch<SetStateAction<Tree>>;
  /** Start a conversation for a message sent before one exists. Throws on failure. */
  newConversation: () => Promise<string>;
  /** A reply finished in this thread (its title may have just been written: refresh what shows it). */
  onReplyDone: (threadId: string) => unknown;
};

/**
 * Sending messages and streaming the replies. `streaming` holds the reply
 * text so far for each thread that's generating; `activity` what the model is
 * doing there when it isn't writing ("Searching: …").
 */
export function useStreaming({ report, setTree, newConversation, onReplyDone }: Options) {
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<Record<string, string>>({});
  const setThreadActivity = useCallback((threadId: string, text: string | null) => {
    setActivity((a) => {
      if ((a[threadId] ?? null) === text) return a;
      const next = { ...a };
      if (text === null) delete next[threadId];
      else next[threadId] = text;
      return next;
    });
  }, []);
  const aborters = useRef(new Map<string, AbortController>()); // per thread, for Stop
  const pending = useRef(new Map<string, string>()); // streamed text not yet on screen
  const flushScheduled = useRef(false);

  /**
   * Streamed chunks arrive far faster than the screen refreshes. Buffer them
   * and apply them in one state update per animation frame, so a long reply
   * causes at most ~60 renders a second instead of one per token.
   *
   * The 50ms timer is a fallback: some windows report themselves visible but
   * don't paint, and requestAnimationFrame never fires there, which would
   * freeze the streaming text until the reply finished.
   */
  const queueStreamText = useCallback((threadId: string, chunk: string) => {
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
  }, []);

  /** Stop generating in a thread. The server sees the disconnect and cancels the model call. */
  const stop = useCallback((threadId: string) => aborters.current.get(threadId)?.abort(), []);

  /**
   * POST to /api/chat and stream the reply into `streaming[threadId]`.
   * Resolves with what the server saved for the reply (`failed`: it most likely
   * saved nothing, e.g. the server couldn't be reached).
   */
  const streamReply = useCallback(
    async (threadId: string, body: Record<string, unknown>) => {
      setStreaming((s) => ({ ...s, [threadId]: "" }));
      const aborter = new AbortController();
      aborters.current.set(threadId, aborter);
      let received = "";
      let sources: Source[] = [];
      let stopped = false;
      let failed = false;
      try {
        const reply = await postChat(
          { threadId, ...body },
          {
            onText: (text) => {
              received += text;
              queueStreamText(threadId, text);
              setThreadActivity(threadId, null); // writing again
            },
            onStatus: (text) => setThreadActivity(threadId, text),
          },
          aborter.signal,
        );
        sources = reply.sources;
      } catch (e) {
        if (aborter.signal.aborted) stopped = true; // the user pressed Stop: not an error
        else {
          failed = true;
          report(e);
        }
      } finally {
        aborters.current.delete(threadId);
      }
      pending.current.delete(threadId);
      setThreadActivity(threadId, null);
      setStreaming((s) => {
        const rest = { ...s };
        delete rest[threadId];
        return rest;
      });
      // Exactly what the server saved: the reply, its sources line, and a stop marker.
      const reply = withSources(received, sources) + (stopped ? STOPPED_NOTE : "") || EMPTY_REPLY;
      return { reply, failed };
    },
    [queueStreamText, setThreadActivity, report],
  );

  /** Send to a thread (null: start a new conversation) and stream the reply. */
  const send = useCallback(
    async (threadId: string | null, content: string, attachments: Attachment[] = []) => {
      const text = content.trim();
      if (!text && !attachments.length) return;
      const files = attachments.length ? { attachments } : {};
      let target: string;
      try {
        target = threadId ?? (await newConversation());
      } catch (e) {
        return report(e);
      }

      // Optimistic: show the user's message right away (the reply streams in below it).
      const tempId = `temp-${Date.now()}`;
      const temp: Message = { id: tempId, threadId: target, role: "user", content: text, createdAt: Date.now(), ...files };
      setTree((t) => ({ ...t, messages: [...t.messages, temp] }));

      // We choose the ids, so we know them even if the reply is stopped before
      // the server sends anything back (headers wait for the first chunk).
      const ids = { user: crypto.randomUUID(), assistant: crypto.randomUUID() };
      const { reply, failed } = await streamReply(target, { content: text, attachments: attachments.map((a) => a.id), userMessageId: ids.user, assistantMessageId: ids.assistant });

      // Update the local copy with exactly what the server saved, instead of
      // re-downloading the whole conversation. Upsert by id, so it's harmless
      // if a conversation load already brought these rows in.
      setTree((t) => {
        const messages = t.messages.filter((m) => m.id !== tempId);
        if (!failed) {
          const now = Date.now();
          const add = [
            { id: ids.user, threadId: target, role: "user" as const, content: text, createdAt: now, ...files },
            { id: ids.assistant, threadId: target, role: "assistant" as const, content: reply, createdAt: now + 1 },
          ].filter((m) => !messages.some((x) => x.id === m.id));
          messages.push(...add);
        }
        return { ...t, messages };
      });
      onReplyDone(target);
    },
    [newConversation, streamReply, onReplyDone, setTree, report],
  );

  /**
   * Write a thread's last reply again. The old reply disappears (with any side
   * threads branched from it, as on the server) and the new one streams in its place.
   */
  const retry = useCallback(
    async (threadId: string, messageId: string) => {
      let removed: Tree | null = null;
      setTree((t) => {
        removed = t;
        const gone = new Set<string>();
        for (const x of t.threads) if (x.forkMessageId === messageId) gone.add(x.id);
        for (let grew = true; grew; ) {
          grew = false;
          for (const x of t.threads) {
            if (x.parentThreadId && gone.has(x.parentThreadId) && !gone.has(x.id)) {
              gone.add(x.id);
              grew = true;
            }
          }
        }
        return { threads: t.threads.filter((x) => !gone.has(x.id)), messages: t.messages.filter((m) => m.id !== messageId && !gone.has(m.threadId)) };
      });
      const id = crypto.randomUUID();
      const { reply, failed } = await streamReply(threadId, { retry: true, assistantMessageId: id });
      if (failed && removed) {
        const before: Tree = removed;
        return setTree(before); // couldn't reach the server: nothing changed there, so put the old reply back
      }
      setTree((t) => ({ ...t, messages: t.messages.some((m) => m.id === id) ? t.messages : [...t.messages, { id, threadId, role: "assistant", content: reply, createdAt: Date.now() }] }));
      onReplyDone(threadId);
    },
    [streamReply, onReplyDone, setTree],
  );

  return { streaming, activity, send, retry, stop };
}
