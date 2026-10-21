import { sandboxed } from "@/lib/sandbox-route";
import { attachFiles, resolveAttachments } from "@/lib/attachments";
import { buildContext } from "@/lib/context";
import { addMessage, deleteMessage, getMessages, getThread, renameThread } from "@/lib/db";
import { streamReply } from "@/lib/llm";
import { type ChatEvent, EMPTY_REPLY, errorNote, type Source, STOPPED_NOTE, withSources } from "@/lib/shared";
import { autoTitle } from "@/lib/titles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Send a message to one thread and stream the reply back as newline-delimited
 * JSON events (see ChatEvent): reply text, what the model is doing (searching
 * the web), and the sources it cited.
 * The user message is saved first, so the context builder sees it; the
 * assistant reply is saved once the stream ends.
 *
 * Files ({ attachments: [ids] }) are uploaded first (POST /api/attachments)
 * and sent with the message; a message can be just files, with no text.
 *
 * Retry ({ retry: true }): replaces the thread's last reply with a new one
 * for the same message. Side threads branched from the old reply go with it.
 *
 * The client picks both message ids, so it can add the new rows to its local
 * copy without re-downloading the conversation, even if it stops the reply
 * before any text (or response headers) arrive.
 */
async function handlePOST(req: Request) {
  const { threadId, content = "", attachments: attachmentIds, userMessageId, assistantMessageId, webSearch = true, retry = false } = (await req.json()) as {
    threadId: string;
    content?: string;
    /** Uploaded files to send with the message. */
    attachments?: string[];
    /** Write the thread's last reply again instead of answering a new message. */
    retry?: boolean;
    userMessageId?: string;
    assistantMessageId?: string;
    /** Let the model search the web (a setting in the app). */
    webSearch?: boolean;
  };
  const thread = getThread(threadId);
  const attachments = await resolveAttachments(attachmentIds);
  if (!attachments) return new Response("unknown attachment", { status: 400 });
  const text = content.trim();
  if (!thread || (!retry && !text && !attachments.length)) return new Response("bad request", { status: 400 });
  for (const id of [userMessageId, assistantMessageId]) {
    if (id !== undefined && !UUID.test(id)) return new Response("bad message id", { status: 400 });
  }

  if (retry) {
    const last = getMessages(threadId).at(-1);
    if (last?.role !== "assistant") return new Response("nothing to retry", { status: 400 });
    deleteMessage(last.id); // the reply to replace; the user's message before it stays
  } else {
    if (!thread.parentThreadId && getMessages(threadId).length === 0) renameThread(threadId, (text || attachments.map((a) => a.name).join(", ")).slice(0, 60));
    addMessage(threadId, "user", text, userMessageId, attachments);
  }
  const assistantId = assistantMessageId ?? crypto.randomUUID(); // saved under this id when the stream ends

  const ctx = await attachFiles(buildContext(threadId, { getThread, getMessages }));
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
      const gen = streamReply(ctx, { mock, signal: stop.signal, webSearch });
      const send = (e: ChatEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      let reply = "";
      let sources: Source[] = [];
      let stopped = false;
      try {
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            if (step.value) console.log(`[chat] thread=${threadId.slice(0, 8)} usage`, step.value);
            break;
          }
          const e = step.value;
          if (e.type === "text") reply += e.text;
          if (e.type === "sources") sources = e.sources;
          send(e);
        }
      } catch (err) {
        if (stop.signal.aborted) {
          stopped = true;
          console.log(`[chat] thread=${threadId.slice(0, 8)} stopped by client after ${reply.length} chars`);
        } else {
          console.error("[chat] stream failed", err);
          const note = errorNote(err instanceof Error ? err.message : "request failed");
          reply += note;
          try {
            send({ type: "text", text: note });
          } catch {}
        }
      } finally {
        await gen.return(null).catch(() => {}); // close the model stream if we bailed mid-way
        // Persist what we got, so every user turn is followed by an assistant
        // turn, and mark a stopped reply so the model knows it was cut off.
        // Sources go at the end as a Markdown line (the client builds the same text).
        addMessage(threadId, "assistant", withSources(reply, sources) + (stopped ? STOPPED_NOTE : "") || EMPTY_REPLY, assistantId);
        // A thread's first reply: replace its placeholder title with one about
        // what it's about. Done before closing, so the client's refresh right
        // after picks it up. Capped, so a slow call can't hold the reply open;
        // on failure the placeholder stays and the next reply tries again.
        if (!stopped) {
          await Promise.race([autoTitle(threadId, { mock: !!mock }), new Promise((r) => setTimeout(r, 4000))]).catch((e) => console.error("[chat] title failed", e));
        }
        try {
          controller.close();
        } catch {} // already closed if the client went away
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const POST = sandboxed(handlePOST);
