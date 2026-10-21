import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { deleteNoteChats, moveNoteChats } from "@/lib/db";
import { createEntry, listVault, moveEntry, placeEntry, trashEntry, VaultError } from "@/lib/vault";

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
    const path = typeof folder === "string" ? await placeEntry(from, folder, before) : await moveEntry(from, to ?? "");
    if (path !== from) moveNoteChats(from, path); // a note's assistant conversation follows it
    return { path };
  });
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
