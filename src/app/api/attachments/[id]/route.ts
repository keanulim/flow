import { getAttachment, readAttachment } from "@/lib/attachments";

/**
 * An attached file, for thumbnails and opening it in a tab. Text files are
 * served as plain text (never as HTML), and nosniff stops the browser from
 * guessing otherwise, so an uploaded .html can't run as a page here.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = await getAttachment(id);
  if (!meta) return new Response("not found", { status: 404 });
  const bytes = await readAttachment(id).catch(() => null);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": meta.type === "text/plain" ? "text/plain; charset=utf-8" : meta.type,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable", // an id's file never changes
    },
  });
}
