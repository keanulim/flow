import { NextResponse } from "next/server";
import { deleteThread, getConversation, getThread, saveToMap, setTitle } from "@/lib/db";

/** A conversation's full tree: main thread, side threads, and all messages. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getThread(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(getConversation(id));
}

/** Save a one-off to the map: { kind: "thread" }. Rename: { title }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { kind, title } = (await req.json()) as { kind?: string; title?: string };
  if (!getThread(id)) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  if (typeof title === "string") {
    const name = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) return NextResponse.json({ error: "A chat needs a name" }, { status: 400 });
    setTitle(id, name);
  } else if (kind === "thread") {
    saveToMap(id);
  } else {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  return NextResponse.json(getThread(id));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteThread(id);
  return new NextResponse(null, { status: 204 });
}
