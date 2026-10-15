import { NextResponse } from "next/server";
import { readNote, VaultError, writeNote } from "@/lib/vault";

function fail(e: unknown) {
  if (e instanceof VaultError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[files/content]", e);
  return NextResponse.json({ error: "File operation failed" }, { status: 500 });
}

/** Read a note: ?path=Folder/Note.md */
export async function GET(req: Request) {
  try {
    return NextResponse.json({ content: await readNote(new URL(req.url).searchParams.get("path") ?? "") });
  } catch (e) {
    return fail(e);
  }
}

/** Save a note: { path, content } */
export async function PUT(req: Request) {
  try {
    const { path, content } = (await req.json()) as { path: string; content: string };
    if (typeof content !== "string") throw new VaultError("Missing content");
    await writeNote(path, content);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return fail(e);
  }
}
