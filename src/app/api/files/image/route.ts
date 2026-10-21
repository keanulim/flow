import { sandboxed } from "@/lib/sandbox-route";
import { NextResponse } from "next/server";
import { IMAGE_FILE } from "@/lib/notes";
import { saveImage, VaultError } from "@/lib/vault";

const MAX_BYTES = 25 * 1024 * 1024;

/** Add an image to the vault (pasted or dropped into a note): multipart { folder, file }. Returns { path }. */
async function handlePOST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const folder = form?.get("folder");
  if (!(file instanceof File) || typeof folder !== "string") return NextResponse.json({ error: "Expected a folder and a file" }, { status: 400 });
  if (!IMAGE_FILE.test(file.name) || !file.type.startsWith("image/")) return NextResponse.json({ error: "Only images can be added to notes" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Images can be up to 25 MB" }, { status: 400 });
  try {
    return NextResponse.json({ path: await saveImage(folder, file.name, Buffer.from(await file.arrayBuffer())) });
  } catch (e) {
    if (e instanceof VaultError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[files/image]", e);
    return NextResponse.json({ error: "Couldn't save the image" }, { status: 500 });
  }
}

// In demo mode, each visitor works in their own sandbox (lib/sandbox.ts).
export const POST = sandboxed(handlePOST);
