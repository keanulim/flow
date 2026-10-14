import { NextResponse } from "next/server";
import { createThread, getMessages, getThread, listConversations } from "@/lib/db";

/** List conversations (main threads only). */
export async function GET() {
  return NextResponse.json(listConversations());
}

/** Create a conversation, or fork a side thread when parentThreadId is given. */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    parentThreadId?: string;
    forkMessageId?: string;
    anchorText?: string;
    kind?: "thread" | "oneoff";
  };

  if (!body.parentThreadId) {
    return NextResponse.json(createThread({ title: "New chat" }));
  }

  // The fork point must be a message *in* the parent thread, or the context
  // builder can't find where to cut the parent's history.
  const forkInParent = getMessages(body.parentThreadId).some((m) => m.id === body.forkMessageId);
  if (!getThread(body.parentThreadId) || !forkInParent) {
    return NextResponse.json({ error: "side threads need a valid parent and a fork message in it" }, { status: 400 });
  }
  const anchor = body.anchorText?.trim() || null;
  return NextResponse.json(
    createThread({
      parentThreadId: body.parentThreadId,
      forkMessageId: body.forkMessageId,
      anchorText: anchor,
      title: anchor ? anchor.slice(0, 60) : "Side thread",
      kind: body.kind === "oneoff" ? "oneoff" : "thread",
    }),
  );
}
