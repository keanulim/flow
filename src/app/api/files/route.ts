import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { deleteNoteChats, moveNoteChats } from "@/lib/db";
import { listNotes, listOtherFiles } from "@/lib/notes";
import { type Files, relinkNote } from "@/lib/relink";
import { createEntry, listVault, moveEntry, placeEntry, readNote, trashEntry, VaultError, type VaultEntry, writeNote } from "@/lib/vault";

/** Turn vault errors into HTTP errors; anything else is a 500. */
async function handle(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return result === undefined ? new NextResponse(null, { status: 204 }) : NextResponse.json(result);
  } catch (e) {
    if (e instanceof VaultError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[files]", e);
    return NextResponse.json({ error: "File operation failed" }, { status: 500 });
  }
}

/** The vault's folder tree. */
export const GET = sandboxed(() => handle(listVault));

/** Create a note or folder: { parent, name, type }. Returns { path }. */
async function handlePOST(req: Request) {
  const { parent = "", name, type } = (await req.json()) as { parent?: string; name: string; type: "file" | "folder" };
  return handle(async () => ({ path: await createEntry(parent, name, type === "folder" ? "folder" : "file") }));
}

/**
 * Rename or move: { from, to }. Or put it at a spot (drag to arrange):
 * { from, folder, before } = in `folder`, just before the item named `before`
 * (null: at the end). Returns { path }.
 */
async function handlePATCH(req: Request) {
  const { from, to, folder, before = null } = (await req.json()) as { from: string; to?: string; folder?: string; before?: string | null };
  return handle(async () => {
    const beforeList = await listVault();
    const path = typeof folder === "string" ? await placeEntry(from, folder, before) : await moveEntry(from, to ?? "");
    if (path === from) return { path, relinked: [] };
    moveNoteChats(from, path); // a note's assistant conversation follows it
    return { path, relinked: await relinkVault(beforeList, from, path) };
  });
}

/**
 * After a rename or move, rewrite links that would otherwise break or point
 * elsewhere (see lib/relink.ts). Returns the notes that were rewritten.
 */
async function relinkVault(beforeList: VaultEntry[], from: string, to: string): Promise<string[]> {
  const afterList = await listVault();
  const files = (list: VaultEntry[]): Files => ({ notes: listNotes(list), others: listOtherFiles(list) });
  const before = files(beforeList);
  const after = files(afterList);
  // Old path -> new path for everything that moved (a folder moves everything inside it).
  const moved = new Map<string, string>();
  for (const f of [...before.notes, ...before.others]) {
    if (f.path === from) moved.set(f.path, to);
    else if (f.path.startsWith(from + "/")) moved.set(f.path, to + f.path.slice(from.length));
  }
  const rewritten: string[] = [];
  for (const note of before.notes) {
    const now = moved.get(note.path) ?? note.path;
    try {
      const text = await readNote(now);
      const next = relinkNote(text, note.path, now, before, after, moved);
      if (next === null) continue;
      await writeNote(now, next);
      rewritten.push(now);
    } catch (e) {
      console.error("[files] relink failed for", now, e);
    }
  }
  if (rewritten.length) console.log(`[files] ${from} -> ${to}: updated links in ${rewritten.length} note(s)`);
  return rewritten;
}

/** Move a note or folder to the vault's .trash. */
async function handleDELETE(req: Request) {
  const p = new URL(req.url).searchParams.get("path") ?? "";
  return handle(async () => {
    await trashEntry(p);
    deleteNoteChats(p);
    return undefined;
  });
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const POST = sandboxed(handlePOST);
export const PATCH = sandboxed(handlePATCH);
export const DELETE = sandboxed(handleDELETE);
