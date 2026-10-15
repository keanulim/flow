import { NextResponse } from "next/server";
import { buildTree, MAX_TOKENS, noteFileName, promptFor, renderNote, SYSTEM, summarizeTree } from "@/lib/chat-note";
import { getConversation, getThread } from "@/lib/db";
import { complete } from "@/lib/llm";
import { createEntry, VaultError, writeNote } from "@/lib/vault";

const FOLDER = "Chat notes";

/**
 * Make a note from this thread and everything branched off it (nothing above it).
 * Always creates a new file ("Title", "Title 2", ...), so it never overwrites
 * edits made to an earlier note of the same chat. Returns { path }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const thread = getThread(id);
  if (!thread) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  const mock = process.env.NODE_ENV !== "production" && !!req.headers.get("x-flow-mock");

  const { threads, messages } = getConversation(id);
  const tree = buildTree(id, threads, messages);
  if (!tree.messages.length && !tree.children.length) return NextResponse.json({ error: "This chat is empty" }, { status: 400 });

  try {
    const summaries = await summarizeTree(tree, (n) =>
      complete({ system: SYSTEM, prompt: promptFor(n), maxTokens: MAX_TOKENS[n.kind], mock, signal: req.signal }),
    );
    const markdown = renderNote(tree, summaries);

    try {
      await createEntry("", FOLDER, "folder");
    } catch (e) {
      if (!(e instanceof VaultError && e.status === 409)) throw e; // already there is fine
    }
    const base = noteFileName(thread.title);
    for (let n = 1; ; n++) {
      try {
        const path = await createEntry(FOLDER, n === 1 ? base : `${base} ${n}`, "file");
        await writeNote(path, markdown);
        return NextResponse.json({ path });
      } catch (e) {
        if (!(e instanceof VaultError && e.status === 409) || n >= 100) throw e;
      }
    }
  } catch (e) {
    if (req.signal.aborted) return new NextResponse(null, { status: 499 });
    console.error("note from chat failed", e);
    const message = e instanceof VaultError ? e.message : e instanceof Error ? e.message : "Couldn't make the note";
    return NextResponse.json({ error: message }, { status: e instanceof VaultError ? e.status : 502 });
  }
}
