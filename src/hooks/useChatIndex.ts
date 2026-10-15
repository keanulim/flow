"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import type { Thread } from "@/lib/db";

type ThreadInfo = Pick<Thread, "id" | "parentThreadId" | "title" | "kind">;

/**
 * Every chat and branch (titles only), for linking to chats from notes: the
 * [[ suggestions, and telling whether a linked chat still exists.
 */
export function useChatIndex(report: (e: unknown) => void) {
  const [index, setIndex] = useState<ThreadInfo[]>([]);

  const loadChatIndex = useCallback(async () => {
    try {
      setIndex(await (await api("/api/threads?all=1")).json());
    } catch (e) {
      report(e);
    }
  }, [report]);

  useEffect(() => void loadChatIndex(), [loadChatIndex]);

  /** For the [[ suggestions: "chat", or "branch · Main chat title". */
  const chatOptions = useMemo(() => {
    const byId = new Map(index.map((t) => [t.id, t]));
    const rootOf = (t: ThreadInfo) => {
      while (t.parentThreadId && byId.has(t.parentThreadId)) t = byId.get(t.parentThreadId)!;
      return t;
    };
    return index.map((t) => ({
      id: t.id,
      title: t.title,
      detail: t.parentThreadId ? `${t.kind === "oneoff" ? "side question" : "branch"} · ${rootOf(t).title.slice(0, 30)}` : "chat",
    }));
  }, [index]);

  const ids = useMemo(() => new Set(index.map((t) => t.id)), [index]);
  const chatExists = useCallback((id: string) => ids.has(id), [ids]);

  return { chatIndex: index, loadChatIndex, chatOptions, chatExists };
}
