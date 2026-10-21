import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { saveNote } from "@/lib/note-images";
import { readNote, VaultError } from "@/lib/vault";

function fail(e: unknown) {
  if (e instanceof VaultError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[files/content]", e);
  return NextResponse.json({ error: "File operation failed" }, { status: 500 });
}

/** Read a note: ?path=Folder/Note.md */
async function handleGET(req: Request) {
  try {
    return NextResponse.json({ content: await readNote(new URL(req.url).searchParams.get("path") ?? "") });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Save a note: { path, content }. Images it no longer shows (and no other note
 * does) go to the trash; returns { removed, restored } image paths, so the
 * file tree can refresh.
 */
async function handlePUT(req: Request) {
  try {
    const { path, content } = (await req.json()) as { path: string; content: string };
    if (typeof content !== "string") throw new VaultError("Missing content");
    return NextResponse.json(await saveNote(path, content));
  } catch (e) {
    return fail(e);
  }
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const GET = sandboxed(handleGET);
export const PUT = sandboxed(handlePUT);
