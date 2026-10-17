// Browser side of attaching files: shrink big images, then upload.
import { api } from "./client";
import type { Attachment } from "./shared";

/**
 * Longest side an image is sent at. The model sees up to 2576px, but each
 * 28×28 patch is a token and the image is resent with every later message in
 * the chat, so 2000px keeps detail (small text stays legible) for about 60%
 * of the full-size cost. It's also the limit for requests with many images.
 */
const MAX_EDGE = 2000;
const SHRINK_OVER_BYTES = 4 * 1024 * 1024;

/** Upload a file to attach to a message. Images are shrunk first if they're large. */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<Attachment> {
  const body = new FormData();
  body.append("file", await shrinkImage(file));
  return (await api("/api/attachments", { method: "POST", body, signal })).json();
}

/** A large PNG/JPEG/WebP redrawn at most MAX_EDGE on its long side. Others (and GIFs, which would lose animation anyway) as they are. */
async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // can't decode it here: let the server decide
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= SHRINK_OVER_BYTES) return (bitmap.close(), file);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Screenshots stay PNG (crisp text) unless that's still big; photos become JPEG.
  const toBlob = (type: string, quality?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
  let blob = file.type === "image/png" ? await toBlob("image/png") : null;
  if (!blob || blob.size > SHRINK_OVER_BYTES) blob = await toBlob("image/jpeg", 0.88);
  if (!blob) return file;
  const name = blob.type === "image/jpeg" ? file.name.replace(/\.\w+$/, "") + ".jpg" : file.name;
  return new File([blob], name, { type: blob.type });
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
