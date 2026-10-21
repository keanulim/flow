import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { searchConversations } from "@/lib/db";

/** GET /api/search?q=... -> ids of conversations matching the query. */
async function handleGET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  return NextResponse.json(q ? searchConversations(q) : []);
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const GET = sandboxed(handleGET);
