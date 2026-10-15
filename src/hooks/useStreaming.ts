"use client";

import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";
import { api, devMockHeader } from "@/lib/client";
import type { Message } from "@/lib/db";
import { STOPPED_NOTE } from "@/lib/shared";
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
 * text so far for each thread that's generating.
 */
export function useStreaming({ report, setTree, newConversation, onReplyDone }: Options) {
  const [streaming, setStreaming] = useState<Record<string, string>>({});
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

  /** Send to a thread (null: start a new conversation) and stream the reply. */
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
      onReplyDone(target);
    },
    [newConversation, onReplyDone, setTree, queueStreamText, report],
  );

  return { streaming, send, stop };
}
