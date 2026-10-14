import { NextResponse } from "next/server";
import { deleteThread, getConversation, getThread, saveToMap } from "@/lib/db";

/** A conversation's full tree: main thread, side threads, and all messages. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getThread(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(getConversation(id));
}

/** Save a one-off to the map: { kind: "thread" }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { kind } = (await req.json()) as { kind?: string };
  if (!getThread(id) || kind !== "thread") return NextResponse.json({ error: "bad request" }, { status: 400 });
  saveToMap(id);
  return NextResponse.json(getThread(id));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteThread(id);
  return new NextResponse(null, { status: 204 });
}
