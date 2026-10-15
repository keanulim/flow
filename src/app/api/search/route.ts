import { NextResponse } from "next/server";
import { searchConversations } from "@/lib/db";

/** GET /api/search?q=... -> ids of conversations matching the query. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  return NextResponse.json(q ? searchConversations(q) : []);
}
