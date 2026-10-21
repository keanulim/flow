import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

/**
 * Demo mode (FLOW_DEMO=1, for a public demo deployment): every visitor gets
 * their own sandbox, a folder with their own database, vault and attachments,
 * seeded with sample notes and chats. All AI replies are simulated, so the demo
 * costs nothing and needs no API key.
 *
 * Which sandbox a request uses travels with it through AsyncLocalStorage: the
 * route sets it (see sandboxed() in sandbox-route.ts), and db.ts, vault.ts and
 * attachments.ts ask dataDir() / vaultDir() instead of using fixed paths. The
 * same is true of anything a request starts, like a streamed reply.
 *
 * Outside demo mode nothing changes: there's no sandbox, and data lives in
 * data/ (or FLOW_DB_PATH / FLOW_VAULT_PATH) as before.
 */

export const DEMO = process.env.FLOW_DEMO === "1";

const store = new AsyncLocalStorage<{ dir: string }>();

/** Run `fn` with the given sandbox folder as the place all data lives. */
export function inSandbox<T>(dir: string, fn: () => T): T {
  return store.run({ dir }, fn);
}

/** The sandbox this request is in, if any. */
export const currentSandbox = () => store.getStore()?.dir ?? null;

/** Where the database and attachments live: the request's sandbox, else data/ (or next to FLOW_DB_PATH). */
export function dataDir(): string {
  return currentSandbox() ?? path.dirname(process.env.FLOW_DB_PATH ?? path.join(process.cwd(), "data", "flow.db"));
}

export function dbPath(): string {
  const sandbox = currentSandbox();
  return sandbox ? path.join(sandbox, "flow.db") : (process.env.FLOW_DB_PATH ?? path.join(process.cwd(), "data", "flow.db"));
}

/** The notes folder: the sandbox's vault, else FLOW_VAULT_PATH or data/vault. */
export function vaultDir(): string {
  const sandbox = currentSandbox();
  return path.resolve(sandbox ? path.join(sandbox, "vault") : (process.env.FLOW_VAULT_PATH ?? path.join(process.cwd(), "data", "vault")));
}
