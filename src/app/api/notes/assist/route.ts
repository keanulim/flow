import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { attachmentBlocks, resolveAttachments } from "@/lib/attachments";
import { addNoteChatMessage, clearNoteChat, getNoteChat } from "@/lib/db";
import { streamNoteAssistant } from "@/lib/llm";
import { linkedPages, listNotes, type NoteInfo, resolveNote } from "@/lib/notes";
import { type ChatEvent, EMPTY_REPLY, errorNote, type Source, STOPPED_NOTE, withSources } from "@/lib/shared";
import { saveNote } from "@/lib/note-images";
import { createNoteWithContent, listVault, readNote, VaultError } from "@/lib/vault";

/**
 * The AI assistant beside a note. Each note has its own conversation (kept out
 * of Chats), and the assistant can edit the note itself.
 *
 * GET ?path=    the note's conversation
 * DELETE ?path= start it over
 * POST { path, content, message, attachments? }: answer, streaming newline-delimited JSON
 *   events (text, status, the note's new text after each edit, pages it created). `content`
 *   is the note as the editor has it; the edited note is saved when done.
 */
async function handleGET(req: Request) {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  return NextResponse.json(getNoteChat(path));
}

async function handleDELETE(req: Request) {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  clearNoteChat(path);
  return new NextResponse(null, { status: 204 });
}

async function handlePOST(req: Request) {
  const { path, content, message = "", attachments: attachmentIds, webSearch = true } = (await req.json()) as {
    path?: string;
    content?: string;
    message?: string;
    /** Uploaded files (POST /api/attachments) to send with the message. */
    attachments?: string[];
    webSearch?: boolean;
  };
  const attachments = await resolveAttachments(attachmentIds);
  if (!attachments) return NextResponse.json({ error: "unknown attachment" }, { status: 400 });
  const text = message.trim();
  if (!path || typeof content !== "string" || (!text && !attachments.length)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    await readNote(path); // the note must exist (and be inside the vault)
  } catch (e) {
    return NextResponse.json({ error: e instanceof VaultError ? e.message : "Note not found" }, { status: 404 });
  }
  const mock = process.env.NODE_ENV !== "production" && !!req.headers.get("x-flow-mock");
  // Earlier turns' files are sent again each time (the API keeps nothing between requests).
  const history = await Promise.all(
    getNoteChat(path).map(async ({ role, content, attachments: files }) => ({
      role,
      content: files?.length ? [...(await attachmentBlocks(files)), ...(content ? [{ type: "text" as const, text: content }] : [])] : content,
    })),
  );
  const files = await attachmentBlocks(attachments);
  const notes = listNotes(await listVault());
  const context = await noteContext(path, content, notes);
  /** For the assistant's read_note tool: any note in the vault, by name or path (read-only). */
  const readOther = async (name: string) => {
    const found = resolveNote(name, path, notes) ?? notes.find((n) => n.path.toLowerCase() === name.replace(/^\//, "").toLowerCase())?.path ?? null;
    if (!found) return null;
    try {
      return { path: found, content: await readNote(found) };
    } catch {
      return null;
    }
  };
  /** For create_note: a new page, in the current note's folder unless another is named. Never overwrites. */
  const createOther = async (name: string, body: string, folder?: string) => {
    if (body.length > 200_000) throw new Error("That page is too long");
    try {
      return await createNoteWithContent(folder?.replace(/^\/+|\/+$/g, "") ?? (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""), name, body);
    } catch (e) {
      throw new Error(e instanceof VaultError ? (e.status === 404 ? `There's no folder "${folder}"` : e.message) : "the file couldn't be written");
    }
  };
  addNoteChatMessage(path, "user", text, attachments);

  const stop = new AbortController();
  req.signal.addEventListener("abort", () => stop.abort());
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (e: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {} // the page went away
      };
      const gen = streamNoteAssistant({ history, message: text, files, note: content, path, context, readNote: readOther, createNote: createOther, webSearch }, { mock, signal: stop.signal });
      let reply = "";
      let sources: Source[] = [];
      let note = content;
      let changed = false;
      let stopped = false;
      try {
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            note = step.value.note;
            changed = step.value.changed;
            break;
          }
          const e = step.value;
          if (e.type === "text") reply += e.text;
          if (e.type === "sources") sources = e.sources;
          if (e.type === "note") {
            note = e.content;
            changed = true;
          }
          send(e);
        }
      } catch (err) {
        if (stop.signal.aborted) stopped = true;
        else {
          console.error("[note assistant] failed", err);
          const n = errorNote(err instanceof Error ? err.message : "request failed");
          reply += n;
          send({ type: "text", text: n });
        }
      } finally {
        await gen.return({ note, changed }).catch(() => {});
        // Keep what was edited, even if the reply was stopped or failed partway.
        // (Through saveNote, so images the edit removed are tidied up like a hand edit.)
        if (changed) await saveNote(path, note).catch((e) => console.error("[note assistant] save failed", e));
        addNoteChatMessage(path, "assistant", withSources(reply, sources) + (stopped ? STOPPED_NOTE : "") || EMPTY_REPLY);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      stop.abort();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

const MAX_LINKED = 8; // linked notes sent along
const LINKED_CHARS = 12000; // per linked note
const LINKED_TOTAL = 60000; // all linked notes together
const MAX_LISTED = 300; // other notes listed by name

/**
 * What the assistant sees besides the note: the notes it links to with [[Page]]
 * (their text, within limits), and the names of the other notes, which it can
 * read with read_note.
 */
async function noteContext(path: string, content: string, notes: NoteInfo[]): Promise<string> {
  const linked: string[] = [];
  for (const page of linkedPages(content)) {
    const p = resolveNote(page, path, notes);
    if (p && p !== path && !linked.includes(p)) linked.push(p);
    if (linked.length >= MAX_LINKED) break;
  }
  let budget = LINKED_TOTAL;
  const parts: string[] = [];
  for (const p of linked) {
    if (budget <= 0) break;
    try {
      const text = (await readNote(p)).slice(0, Math.min(LINKED_CHARS, budget));
      budget -= text.length;
      parts.push(`<note path="/${p}">\n${text}\n</note>`);
    } catch {} // gone since the list was read
  }
  const others = notes.filter((n) => n.path !== path && !linked.includes(n.path)).slice(0, MAX_LISTED);
  return (
    (parts.length ? `<linked_notes>\n${parts.join("\n")}\n</linked_notes>\n\n` : "") +
    (others.length ? `<other_notes>\n${others.map((n) => n.path).join("\n")}\n</other_notes>\n\n` : "")
  );
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const GET = sandboxed(handleGET);
export const DELETE = sandboxed(handleDELETE);
export const POST = sandboxed(handlePOST);
