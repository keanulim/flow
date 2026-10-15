import { buildContext } from "@/lib/context";
import { addMessage, getMessages, getThread, renameThread } from "@/lib/db";
import { streamReply } from "@/lib/llm";
import { STOPPED_NOTE } from "@/lib/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Send a message to one thread and stream the reply back as plain text.
 * The user message is saved first, so the context builder sees it; the
 * assistant reply is saved once the stream ends.
 *
 * The client picks both message ids, so it can add the new rows to its local
 * copy without re-downloading the conversation, even if it stops the reply
 * before any text (or response headers) arrive.
 */
export async function POST(req: Request) {
  const { threadId, content, userMessageId, assistantMessageId } = (await req.json()) as {
    threadId: string;
    content: string;
    userMessageId?: string;
    assistantMessageId?: string;
  };
  const thread = getThread(threadId);
  if (!thread || !content?.trim()) return new Response("bad request", { status: 400 });
  for (const id of [userMessageId, assistantMessageId]) {
    if (id !== undefined && !UUID.test(id)) return new Response("bad message id", { status: 400 });
  }

  if (!thread.parentThreadId && getMessages(threadId).length === 0) {
    renameThread(threadId, content.trim().slice(0, 60));
  }
  addMessage(threadId, "user", content.trim(), userMessageId);
  const assistantId = assistantMessageId ?? crypto.randomUUID(); // saved under this id when the stream ends

  const ctx = buildContext(threadId, { getThread, getMessages });
  // Dev-only: `x-flow-mock: 1` forces the free mock reply even with a real key;
  // `think` also pauses before the first chunk, like the model thinking.
  const mockHeader = process.env.NODE_ENV !== "production" ? req.headers.get("x-flow-mock") : null;
  const mock = mockHeader === "think" ? "think" : mockHeader === "1";

  // One switch for "stop generating": fired when the client disconnects (closed
  // tab, Stop button) via either the request signal or the stream's cancel().
  // Passing it to the model call cancels the API request, which stops billing.
  const stop = new AbortController();
  req.signal.addEventListener("abort", () => stop.abort());

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const gen = streamReply(ctx, { mock, signal: stop.signal });
      let reply = "";
      let stopped = false;
      try {
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            if (step.value) console.log(`[chat] thread=${threadId.slice(0, 8)} usage`, step.value);
            break;
          }
          reply += step.value;
          controller.enqueue(encoder.encode(step.value));
        }
      } catch (err) {
        if (stop.signal.aborted) {
          stopped = true;
          console.log(`[chat] thread=${threadId.slice(0, 8)} stopped by client after ${reply.length} chars`);
        } else {
          console.error("[chat] stream failed", err);
          const note = `\n\n_Error: ${err instanceof Error ? err.message : "request failed"}_`;
          reply += note;
          try {
            controller.enqueue(encoder.encode(note));
          } catch {}
        }
      } finally {
        await gen.return(null).catch(() => {}); // close the model stream if we bailed mid-way
        // Persist what we got, so every user turn is followed by an assistant
        // turn, and mark a stopped reply so the model knows it was cut off.
        addMessage(threadId, "assistant", (reply || "") + (stopped ? STOPPED_NOTE : "") || "_(empty reply)_", assistantId);
        try {
          controller.close();
        } catch {} // already closed if the client went away
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
