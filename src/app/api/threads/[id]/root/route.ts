import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { getRootId } from "@/lib/db";

/** Which conversation a thread belongs to: { rootId }. Used to open a linked chat or branch. */
async function handleGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rootId = getRootId(id);
  if (!rootId) return NextResponse.json({ error: "That chat no longer exists" }, { status: 404 });
  return NextResponse.json({ rootId });
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const GET = sandboxed(handleGET);
