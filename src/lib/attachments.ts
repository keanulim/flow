import type Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import type { BuiltContext } from "./context";
import { dataDir } from "./sandbox";
import { type Attachment, attachmentKind, MAX_ATTACHMENT_BYTES } from "./shared";

/**
 * Files attached to chat messages. Each upload is stored once on disk,
 * data/attachments/<id> plus <id>.json (its name, type and size), and a
 * message keeps only that metadata. The bytes are read again whenever a
 * request includes the message, since the API keeps nothing between requests.
 */

/** data/attachments, or the sandbox's (demo mode). */
const attachmentsDir = () => path.join(dataDir(), "attachments");
const ID = /^[0-9a-f-]{36}$/;

export class AttachmentError extends Error {}

/** Save an upload. Throws AttachmentError for a file the model can't read or one that's too big. */
export async function saveAttachment(file: File): Promise<Attachment> {
  const kind = attachmentKind(file.type, file.name);
  if (!kind) throw new AttachmentError(`Can't attach ${file.name}: only images, PDFs and text files are supported`);
  if (file.size > MAX_ATTACHMENT_BYTES[kind]) throw new AttachmentError(`${file.name} is too big (limit ${MAX_ATTACHMENT_BYTES[kind] / 1024 / 1024} MB for this kind of file)`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (kind === "text" && bytes.includes(0)) throw new AttachmentError(`${file.name} doesn't look like a text file`);
  const meta: Attachment = {
    id: crypto.randomUUID(),
    name: path.basename(file.name).slice(0, 200) || "file",
    type: kind === "text" ? "text/plain" : kind === "pdf" ? "application/pdf" : file.type,
    size: bytes.length,
  };
  await fs.mkdir(attachmentsDir(), { recursive: true });
  await fs.writeFile(path.join(attachmentsDir(), meta.id), bytes);
  await fs.writeFile(path.join(attachmentsDir(), `${meta.id}.json`), JSON.stringify(meta));
  return meta;
}

/** An upload's metadata, or null if there's no such upload. */
export async function getAttachment(id: string): Promise<Attachment | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(attachmentsDir(), `${id}.json`), "utf8")) as Attachment;
  } catch {
    return null;
  }
}

/** The uploads a request names by id, or null if the list is malformed or names one that doesn't exist. */
export async function resolveAttachments(ids: unknown): Promise<Attachment[] | null> {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 20) return null;
  const found: Attachment[] = [];
  for (const id of ids) {
    const a = typeof id === "string" ? await getAttachment(id) : null;
    if (!a) return null;
    found.push(a);
  }
  return found;
}

export async function readAttachment(id: string): Promise<Buffer> {
  if (!ID.test(id)) throw new AttachmentError("bad attachment id");
  return fs.readFile(path.join(attachmentsDir(), id));
}

/**
 * What the model gets for a message's attachments: images as image blocks,
 * PDFs as documents (it reads both the text and the page images), text files
 * as plain-text documents titled with the file name. A file that has gone
 * missing becomes a short note instead of failing the whole request.
 */
export async function attachmentBlocks(attachments: Attachment[]): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  return Promise.all(
    attachments.map(async (a): Promise<Anthropic.Beta.BetaContentBlockParam> => {
      let bytes: Buffer;
      try {
        bytes = await readAttachment(a.id);
      } catch {
        return { type: "text", text: `[Attached file "${a.name}" is no longer available.]` };
      }
      const kind = attachmentKind(a.type, a.name);
      if (kind === "image") {
        return { type: "image", source: { type: "base64", media_type: a.type as "image/png", data: bytes.toString("base64") } };
      }
      if (kind === "pdf") {
        return { type: "document", title: a.name, source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } };
      }
      return { type: "document", title: a.name, source: { type: "text", media_type: "text/plain", data: bytes.toString("utf8") } };
    }),
  );
}

/**
 * A thread's context with its files read in: each message that has
 * attachments becomes [files…, its text] (images before text reads best).
 * The bytes are identical every time, so the prompt cache still matches.
 */
export async function attachFiles(ctx: BuiltContext): Promise<BuiltContext> {
  if (!ctx.files.some((f) => f?.length)) return ctx;
  const messages = await Promise.all(
    ctx.messages.map(async (m, i) => {
      const files = ctx.files[i];
      if (!files?.length) return m;
      const text = String(m.content);
      const blocks = (await attachmentBlocks(files)) as Anthropic.ContentBlockParam[];
      return { ...m, content: text ? [...blocks, { type: "text" as const, text }] : blocks };
    }),
  );
  return { ...ctx, messages };
}

/**
 * Delete uploads no message refers to: files attached to messages since
 * deleted (with their chat), and uploads never sent. Only ones older than a
 * day, so a file attached to a message still being written isn't removed.
 */
export async function pruneAttachments(referenced: Set<string>): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(attachmentsDir());
  } catch {
    return 0;
  }
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    if (!ID.test(name) || referenced.has(name)) continue;
    const file = path.join(attachmentsDir(), name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.mtimeMs > dayAgo) continue;
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.json`, { force: true });
    removed++;
  }
  return removed;
}
