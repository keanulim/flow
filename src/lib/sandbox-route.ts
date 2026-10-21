import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addMessage, closeDb, createThread, setAutoTitle } from "./db";
import { DEMO, inSandbox } from "./sandbox";

/**
 * Demo mode, server side: which sandbox a request belongs to (a cookie the
 * middleware sets), creating and seeding it on first use, and cleaning up old
 * ones. See sandbox.ts for the idea.
 */

export const SANDBOX_COOKIE = "flow_sandbox";
const ROOT = path.join(os.tmpdir(), "flow-demo"); // the only writable place on serverless hosts like Vercel
const DEMO_CONTENT = path.join(process.cwd(), "demo");
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // sandboxes untouched this long are deleted
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Wrap a route handler so that, in demo mode, it runs in the visitor's
 * sandbox. Outside demo mode it's the handler itself, unchanged.
 */
export function sandboxed<A extends unknown[]>(handler: (req: Request, ...rest: A) => Promise<Response> | Response) {
  if (!DEMO) return handler;
  return async (req: Request, ...rest: A): Promise<Response> => {
    const id = cookie(req, SANDBOX_COOKIE);
    if (!id || !ID.test(id)) return Response.json({ error: "Reload the page to start the demo." }, { status: 400 });
    const dir = path.join(ROOT, id);
    await ready(dir);
    return inSandbox(dir, () => handler(req, ...rest));
  };
}

function cookie(req: Request, name: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.get("cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

// A sandbox being set up, so two requests at once don't both seed it.
const g = globalThis as unknown as { flowSeeding?: Map<string, Promise<void>> };
const seeding = (g.flowSeeding ??= new Map());

/** Make sure the sandbox exists (seeded with the demo content), and mark it as used now. */
async function ready(dir: string) {
  const marker = path.join(dir, ".seeded");
  const now = new Date();
  if (await fs.utimes(marker, now, now).then(() => true, () => false)) return;
  let job = seeding.get(dir);
  if (!job) {
    job = seed(dir).finally(() => seeding.delete(dir));
    seeding.set(dir, job);
  }
  await job;
}

async function seed(dir: string) {
  await prune();
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(path.join(DEMO_CONTENT, "vault"), path.join(dir, "vault"), { recursive: true });
  const chats = JSON.parse(await fs.readFile(path.join(DEMO_CONTENT, "chats.json"), "utf8")) as DemoChat[];
  // Newest chats are listed first, so add them last-to-first to list them in the file's order.
  inSandbox(dir, () => [...chats].reverse().forEach((c) => addChat(c, null, null)));
  await fs.writeFile(path.join(dir, ".seeded"), "");
}

/** A sample conversation: a thread with messages, and branches off its messages. */
type DemoChat = {
  id: string;
  title: string;
  kind?: "thread" | "oneoff";
  /** For a branch: the highlighted excerpt it's about (in the message it branches from). */
  anchor?: string;
  /** For a branch: which of the parent's messages it branches from (index). */
  from?: number;
  messages: { role: "user" | "assistant"; content: string }[];
  branches?: DemoChat[];
};

function addChat(chat: DemoChat, parentId: string | null, forkMessageId: string | null) {
  createThread({ id: chat.id, parentThreadId: parentId, forkMessageId, anchorText: chat.anchor ?? null, title: chat.title, kind: chat.kind ?? "thread" });
  setAutoTitle(chat.id, chat.title); // already has a good title: don't write one
  const ids = chat.messages.map((m) => addMessage(chat.id, m.role, m.content).id);
  for (const b of chat.branches ?? []) addChat(b, chat.id, ids[b.from ?? ids.length - 1]);
}

/** Delete sandboxes nobody has used for a while. */
async function prune() {
  const names = await fs.readdir(ROOT).catch(() => [] as string[]);
  for (const name of names) {
    if (!ID.test(name)) continue;
    const dir = path.join(ROOT, name);
    // Last used (the marker is touched on every request); one still being set up has no marker yet: its folder's age.
    const used = await fs.stat(path.join(dir, ".seeded")).then((s) => s.mtimeMs, () => fs.stat(dir).then((s) => s.mtimeMs, () => Date.now()));
    if (Date.now() - used < MAX_AGE_MS) continue;
    closeDb(path.join(dir, "flow.db"));
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
