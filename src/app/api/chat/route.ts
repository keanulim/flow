import { buildContext } from "@/lib/context";
import { addMessage, getMessages, getThread, renameThread } from "@/lib/db";
import { streamReply } from "@/lib/llm";

/**
 * Send a message to one thread and stream the reply back as plain text.
 * The user message is saved first, so the context builder sees it; the
 * assistant reply is saved once the stream finishes.
 */
export async function POST(req: Request) {
  const { threadId, content } = (await req.json()) as { threadId: string; content: string };
  const thread = getThread(threadId);
  if (!thread || !content?.trim()) return new Response("bad request", { status: 400 });

  if (!thread.parentThreadId && getMessages(threadId).length === 0) {
    renameThread(threadId, content.trim().slice(0, 60));
  }
  addMessage(threadId, "user", content.trim());

  const ctx = buildContext(threadId, { getThread, getMessages });
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      let reply = "";
      try {
        const gen = streamReply(ctx);
        let step = await gen.next();
        while (!step.done) {
          reply += step.value;
          controller.enqueue(encoder.encode(step.value));
          step = await gen.next();
        }
        if (step.value) console.log(`[chat] thread=${threadId.slice(0, 8)} usage`, step.value);
      } catch (err) {
        console.error("[chat] stream failed", err);
        const note = `\n\n_Error: ${err instanceof Error ? err.message : "request failed"}_`;
        reply += note;
        controller.enqueue(encoder.encode(note));
      } finally {
        // Persist whatever we got, even on error, so the thread stays consistent
        // (every user turn is followed by an assistant turn).
        addMessage(threadId, "assistant", reply || "_(empty reply)_");
        controller.close();
      }
    },
  });

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
