import type Anthropic from "@anthropic-ai/sdk";
import type { Message, Thread } from "./db";

/**
 * The core idea of Flow: a conversation is a tree, and every thread decides
 * what the model gets to see.
 *
 *   main thread   -> only its own messages. Side questions never leak in.
 *   side thread   -> parent's messages up to (and including) the fork point,
 *                    then its own messages, with the highlighted excerpt
 *                    folded into its first question.
 *
 * Nothing in here touches the DB or the network, so it can be tested with
 * plain in-memory data (see scripts/context-demo.ts).
 */

export type ContextLoader = {
  getThread: (id: string) => Thread | undefined;
  getMessages: (threadId: string) => Message[];
};

export type BuiltContext = {
  messages: Anthropic.MessageParam[];
  /** Index of the last inherited message, or -1 for a main thread. Everything
   *  up to here is byte-identical to the parent's history, so it's the spot
   *  where a prompt-cache breakpoint lets side threads reuse the main prefix. */
  inheritedUntil: number;
};

export function buildContext(threadId: string, load: ContextLoader): BuiltContext {
  const lineage = collect(threadId, load);
  const inheritedUntil = lineage.findLastIndex((m) => m.inherited);
  return {
    messages: lineage.map((m) => ({ role: m.role, content: m.content })),
    inheritedUntil,
  };
}

type Entry = { role: Message["role"]; content: string; id: string; inherited: boolean };

function collect(threadId: string, load: ContextLoader): Entry[] {
  const thread = load.getThread(threadId);
  if (!thread) throw new Error(`thread ${threadId} not found`);

  const own: Entry[] = load
    .getMessages(threadId)
    .map((m) => ({ role: m.role, content: m.content, id: m.id, inherited: false }));

  if (!thread.parentThreadId) return own;

  // Recurse: a side thread of a side thread inherits its parent's full lineage.
  const parent = collect(thread.parentThreadId, load);
  const cut = parent.findIndex((m) => m.id === thread.forkMessageId);
  if (cut === -1) throw new Error(`fork message ${thread.forkMessageId} not in parent lineage`);
  const inherited = parent.slice(0, cut + 1).map((m) => ({ ...m, inherited: true }));

  // The stored message stays exactly what the user typed; the excerpt framing
  // is added only when building the request.
  if (own[0]?.role === "user") {
    own[0] = { ...own[0], content: frameSideQuestion(thread.anchorText, own[0].content) };
  }
  return [...inherited, ...own];
}

function frameSideQuestion(anchor: string | null, question: string): string {
  const about = anchor
    ? `This is a side question about this excerpt from your previous reply:\n<excerpt>\n${anchor}\n</excerpt>`
    : `This is a side question about your previous reply.`;
  return `${about}\n\n${question}`;
}
