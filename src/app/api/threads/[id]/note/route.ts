import { NextResponse } from "next/server";
import { buildTree, MAX_TOKENS, type NoteEvent, noteFileName, promptFor, renderNote, SYSTEM, summarizeTree } from "@/lib/chat-note";
import { getConversation, getThread } from "@/lib/db";
import { streamCompletion } from "@/lib/llm";
import { createEntry, VaultError, writeNote } from "@/lib/vault";

const FOLDER = "Chat notes";
const SNAPSHOT_EVERY = 150; // ms between live updates sent to the page
const SAVE_EVERY = 1500; // ms between saves of the half-written note

/**
 * Make a note from this thread and everything branched off it (nothing above
 * it), streaming it as it's written.
 *
 * The file is created first, so the page can open it straight away; then the
 * whole note is sent again every ~150ms as the summaries stream in. The work
 * isn't tied to the request: if the page goes away (reload, closed tab), it
 * carries on and still saves the finished note.
 *
 * Always creates a new file ("Title", "Title 2", ...), so it never overwrites
 * edits made to an earlier note of the same chat.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const thread = getThread(id);
  if (!thread) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  const mock = process.env.NODE_ENV !== "production" && !!req.headers.get("x-flow-mock");

  const { threads, messages } = getConversation(id);
  const tree = buildTree(id, threads, messages);
  if (!tree.messages.length && !tree.children.length) return NextResponse.json({ error: "This chat is empty" }, { status: 400 });

  let path: string;
  try {
    path = await createNoteFile(thread.title);
    const all = new Set<string>();
    const walk = (n: typeof tree) => (n.messages.length && all.add(n.thread.id), n.children.forEach(walk));
    walk(tree);
    await writeNote(path, renderNote(tree, new Map(), { writing: all })); // the outline, every section "Writing…"
  } catch (e) {
    const message = e instanceof Error ? e.message : "Couldn't create the note";
    return NextResponse.json({ error: message }, { status: e instanceof VaultError ? e.status : 500 });
  }

  const encoder = new TextEncoder();
  let send: (e: NoteEvent) => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      send = (e) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
          if (e.type === "done" || e.type === "error") {
            open = false;
            controller.close();
          }
        } catch {
          open = false; // the page went away; keep working anyway
        }
      };
    },
    cancel() {
      send = () => {}; // the page went away; the work below still finishes and saves
    },
  });

  void (async () => {
    send({ type: "start", path });
    let latest = "";
    let lastSnapshot = 0;
    let lastSave = Date.now();
    let saving: Promise<void> = Promise.resolve();
    try {
      const summaries = await summarizeTree(
        tree,
        (n) => streamCompletion({ system: SYSTEM, prompt: promptFor(n), maxTokens: MAX_TOKENS[n.kind], mock }),
        {
          onProgress: (partial, writing) => {
            const now = Date.now();
            if (now - lastSnapshot < SNAPSHOT_EVERY) return;
            lastSnapshot = now;
            latest = renderNote(tree, partial, { writing });
            send({ type: "snapshot", markdown: latest });
            if (now - lastSave > SAVE_EVERY) {
              lastSave = now;
              const text = latest;
              saving = saving.then(() => writeNote(path, text)).catch(() => {}); // so reopening it shows progress
            }
          },
        },
      );
      await saving;
      await writeNote(path, renderNote(tree, summaries));
      send({ type: "done", path });
    } catch (e) {
      console.error("note from chat failed", e);
      await saving;
      if (latest) await writeNote(path, latest).catch(() => {}); // keep what was written
      send({ type: "error", error: e instanceof Error ? e.message : "Couldn't finish the note" });
    }
  })();

  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

/** A new, empty note in the chat notes folder, named after the chat: "Title", or "Title 2", ... if taken. */
async function createNoteFile(title: string): Promise<string> {
  try {
    await createEntry("", FOLDER, "folder");
  } catch (e) {
    if (!(e instanceof VaultError && e.status === 409)) throw e; // already there is fine
  }
  const base = noteFileName(title);
  for (let n = 1; ; n++) {
    try {
      return await createEntry(FOLDER, n === 1 ? base : `${base} ${n}`, "file");
    } catch (e) {
      if (!(e instanceof VaultError && e.status === 409) || n >= 100) throw e;
    }
  }
}
