import { NextResponse } from "next/server";
import { deleteNoteChats, moveNoteChats } from "@/lib/db";
import { createEntry, listVault, moveEntry, trashEntry, VaultError } from "@/lib/vault";

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
export const GET = () => handle(listVault);

/** Create a note or folder: { parent, name, type }. Returns { path }. */
export async function POST(req: Request) {
  const { parent = "", name, type } = (await req.json()) as { parent?: string; name: string; type: "file" | "folder" };
  return handle(async () => ({ path: await createEntry(parent, name, type === "folder" ? "folder" : "file") }));
}

/** Rename or move: { from, to }. Returns { path }. */
export async function PATCH(req: Request) {
  const { from, to } = (await req.json()) as { from: string; to: string };
  return handle(async () => {
    const path = await moveEntry(from, to);
    moveNoteChats(from, path); // a note's assistant conversation follows it
    return { path };
  });
}

/** Move a note or folder to the vault's .trash. */
export async function DELETE(req: Request) {
  const p = new URL(req.url).searchParams.get("path") ?? "";
  return handle(async () => {
    await trashEntry(p);
    deleteNoteChats(p);
  });
}
