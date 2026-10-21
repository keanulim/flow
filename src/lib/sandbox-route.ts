import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { addMessage, closeDb, createThread, setAutoTitle } from "./db";
import { DEMO, inSandbox } from "./sandbox";

/**
 * Demo mode, server side: which sandbox a request belongs to (a cookie the
 * middleware sets), creating and seeding it on first use, and cleaning up old
 * ones. See sandbox.ts for the idea.
 *
 * Serverless hosts (Vercel) run several copies of the server at once, each
 * with its own /tmp, and a visitor's requests land on any of them. So with
 * Redis configured, the real copy of each sandbox lives in Redis, and /tmp is
 * each server's cache of it: before a request, a server checks the sandbox's
 * version and downloads it if its copy is behind; after a request that changes
 * something, it uploads the sandbox with the next version. Without Redis (a
 * single server, or running locally), /tmp alone is the sandbox.
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
    if (redis) await once(dir, () => pull(id, dir));
    else await ready(dir);
    const res = await inSandbox(dir, () => handler(req, ...rest));
    if (!redis || req.method === "GET" || req.method === "HEAD" || !res.body) return res;
    // It may have changed the sandbox: save it once the response is done (a streamed reply included).
    const save = new TransformStream<Uint8Array, Uint8Array>({ flush: () => once(dir, () => push(id, dir)).catch((e) => console.error("[demo] save failed", e)) });
    return new Response(res.body.pipeThrough(save), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

// ---------- shared copies in Redis (when configured) ----------

// Vercel's Upstash integration sets the KV_* names; Upstash's own setup the UPSTASH_* ones.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis = DEMO && REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN, automaticDeserialization: false }) : null;
const TTL_S = MAX_AGE_MS / 1000; // a sandbox unused this long is forgotten
const MAX_SNAPSHOT = 4 * 1024 * 1024; // bigger than this isn't uploaded (demo files are kept small)
const keys = (id: string) => ({ version: `flow:sandbox:${id}:v`, data: `flow:sandbox:${id}:data` });
type Snapshot = { v: number; files: Record<string, string> }; // sandbox-relative path -> base64

// One sync at a time per sandbox on this server, so two requests don't both rewrite the folder.
const syncing = ((globalThis as unknown as { flowSync?: Map<string, Promise<unknown>> }).flowSync ??= new Map());
function once<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const run = (syncing.get(dir) ?? Promise.resolve()).catch(() => {}).then(job);
  syncing.set(dir, run);
  return run;
}

const localVersion = (dir: string) => fs.readFile(path.join(dir, ".version"), "utf8").then(Number, () => 0);

/** Make this server's copy of the sandbox the current one: download it, or create it if it's new. */
async function pull(id: string, dir: string) {
  const k = keys(id);
  const remote = Number((await redis!.get<string>(k.version)) ?? 0);
  const local = await localVersion(dir);
  if (remote && remote === local) return touch(dir);
  if (remote && (await download(id, dir))) return;
  if (remote === 0 && local > 0) return push(id, dir); // the shared copy expired, but this server still has it
  // New visitor: seed here, and share it, unless another server shared theirs first (page load sends requests in parallel).
  await fs.rm(dir, { recursive: true, force: true });
  await seed(dir);
  const snap = await snapshot(dir, 1);
  if ((await redis!.set(k.data, JSON.stringify(snap), { nx: true, ex: TTL_S })) === "OK") {
    await redis!.set(k.version, "1", { ex: TTL_S });
    await fs.writeFile(path.join(dir, ".version"), "1");
    return;
  }
  for (let i = 0; i < 20; i++) {
    if (await download(id, dir)) return;
    await new Promise((r) => setTimeout(r, 150)); // the other server is still sharing it
  }
}

/** Replace this server's copy with the shared one. False if there's none (yet). */
async function download(id: string, dir: string): Promise<boolean> {
  const raw = await redis!.get<string>(keys(id).data);
  if (!raw) return false;
  const snap = JSON.parse(raw) as Snapshot;
  closeDb(path.join(dir, "flow.db")); // don't keep reading the file that's being replaced
  await fs.rm(dir, { recursive: true, force: true });
  for (const [rel, b64] of Object.entries(snap.files)) {
    const file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep)) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(b64, "base64"));
  }
  await fs.writeFile(path.join(dir, ".version"), String(snap.v));
  await fs.writeFile(path.join(dir, ".seeded"), "");
  return true;
}

/** Share this server's copy as the next version. */
async function push(id: string, dir: string) {
  const v = Math.max(await localVersion(dir), Number((await redis!.get<string>(keys(id).version)) ?? 0)) + 1;
  const snap = await snapshot(dir, v);
  const json = JSON.stringify(snap);
  if (json.length > MAX_SNAPSHOT) return console.warn(`[demo] sandbox ${id} is too big to share (${json.length} bytes)`);
  // The data first, then the version: a server that sees the new version finds the new data.
  await redis!.set(keys(id).data, json, { ex: TTL_S });
  await redis!.set(keys(id).version, String(v), { ex: TTL_S });
  await fs.writeFile(path.join(dir, ".version"), String(v));
}

/** Every file in the sandbox (not the bookkeeping markers), as base64. */
async function snapshot(dir: string, v: number): Promise<Snapshot> {
  const files: Record<string, string> = {};
  const walk = async (sub: string) => {
    for (const e of await fs.readdir(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else if (e.isFile() && rel !== ".version" && rel !== ".seeded") files[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
    }
  };
  await walk("");
  return { v, files };
}

/** Mark the sandbox as used now (old ones are pruned). */
const touch = (dir: string) => fs.utimes(path.join(dir, ".seeded"), new Date(), new Date()).catch(() => {});

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
