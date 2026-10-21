import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { untitledThreads } from "@/lib/db";
import { autoTitle } from "@/lib/titles";

/**
 * Write titles for every chat and branch that still has its placeholder
 * (threads from before titles were automatic). A few at a time; returns what each became.
 */
async function handlePOST(req: Request) {
  const mock = process.env.NODE_ENV !== "production" && !!req.headers.get("x-flow-mock");
  const ids = untitledThreads();
  const results: { id: string; title: string | null; error?: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        results.push({ id, title: await autoTitle(id, { mock }) });
      } catch (e) {
        results.push({ id, title: null, error: e instanceof Error ? e.message : "failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
  return NextResponse.json({ titled: results });
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const POST = sandboxed(handlePOST);
