import { NextResponse } from "next/server";
import { AttachmentError, pruneAttachments, saveAttachment } from "@/lib/attachments";
import { referencedAttachmentIds } from "@/lib/db";

/** Upload one file (multipart field "file") to attach to a message. Returns its Attachment. */
export async function POST(req: Request) {
  const file = (await req.formData().catch(() => null))?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  try {
    const attachment = await saveAttachment(file);
    // Tidy up while we're here: files of deleted chats, and uploads never sent.
    pruneAttachments(referencedAttachmentIds()).catch((e) => console.error("[attachments] prune failed", e));
    return NextResponse.json(attachment);
  } catch (e) {
    if (e instanceof AttachmentError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[attachments]", e);
    return NextResponse.json({ error: "Couldn't save the file" }, { status: 500 });
  }
}
