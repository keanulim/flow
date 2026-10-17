import { readImage, VaultError } from "@/lib/vault";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
};

/**
 * An image in the vault: ?path=Folder/photo.png. An SVG can carry scripts,
 * so everything is served with a sandbox policy (no scripts, even if the image
 * is opened directly) and nosniff (the browser won't guess another type).
 */
export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  try {
    const bytes = await readImage(path);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache", // the file can be replaced under the same name
      },
    });
  } catch (e) {
    return new Response(e instanceof VaultError ? e.message : "not found", { status: e instanceof VaultError ? e.status : 404 });
  }
}
