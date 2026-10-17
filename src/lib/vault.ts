import fs from "node:fs/promises";
import path from "node:path";
import { IMAGE_FILE } from "./notes";

/**
 * The vault: a plain folder of Markdown files, like an Obsidian vault. Notes
 * stay ordinary files, so any editor (Obsidian included) can open them too.
 * Set FLOW_VAULT_PATH to point Flow at an existing vault.
 */
export const VAULT_ROOT = path.resolve(process.env.FLOW_VAULT_PATH ?? path.join(process.cwd(), "data", "vault"));
const TRASH = ".trash"; // deleted items are moved here, not erased (Obsidian does the same)

export type VaultEntry =
  | { type: "folder"; name: string; path: string; children: VaultEntry[] }
  | { type: "file"; name: string; path: string };

export class VaultError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * Turn a vault-relative path from the client into an absolute path that is
 * guaranteed to be inside the vault. This is the security boundary: every
 * file operation goes through it, so "../../.ssh/id_rsa", absolute paths,
 * and symlinks pointing out of the vault are all rejected.
 */
export async function resolveInVault(rel: string, { mustExist = false } = {}): Promise<string> {
  if (typeof rel !== "string" || rel.includes("\0")) throw new VaultError("Invalid path");
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.split("/").some((part) => part === "..")) throw new VaultError("Invalid path");
  const abs = path.resolve(VAULT_ROOT, cleaned);
  if (abs !== VAULT_ROOT && !abs.startsWith(VAULT_ROOT + path.sep)) throw new VaultError("Path is outside the vault");
  if (cleaned.split("/")[0] === TRASH) throw new VaultError("Path is in the trash");

  // A symlink inside the vault could still point elsewhere: check where it really lands.
  const real = await fs.realpath(abs).catch(() => null);
  if (real) {
    const root = await fs.realpath(VAULT_ROOT);
    if (real !== root && !real.startsWith(root + path.sep)) throw new VaultError("Path is outside the vault");
  } else if (mustExist) {
    throw new VaultError("Not found", 404);
  }
  return abs;
}

const toRel = (abs: string) => path.relative(VAULT_ROOT, abs).split(path.sep).join("/");

function checkName(name: string) {
  if (!name || name === "." || name === ".." || /[\/\\\0]/.test(name) || name.startsWith(".")) {
    throw new VaultError("Invalid name");
  }
}

export async function ensureVault() {
  await fs.mkdir(VAULT_ROOT, { recursive: true });
}

/** Folders, .md notes and images, folders first, alphabetical. Hidden entries (.trash, .obsidian) are skipped. */
export async function listVault(): Promise<VaultEntry[]> {
  await ensureVault();
  const walk = async (dir: string): Promise<VaultEntry[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: VaultEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) out.push({ type: "folder", name: e.name, path: toRel(abs), children: await walk(abs) });
      else if (e.isFile() && (e.name.toLowerCase().endsWith(".md") || IMAGE_FILE.test(e.name))) out.push({ type: "file", name: e.name, path: toRel(abs) });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "folder" ? -1 : 1));
  };
  return walk(VAULT_ROOT);
}

export async function readNote(rel: string): Promise<string> {
  if (!rel.toLowerCase().endsWith(".md")) throw new VaultError("Only .md files");
  return fs.readFile(await resolveInVault(rel, { mustExist: true }), "utf8");
}

export async function writeNote(rel: string, content: string) {
  if (!rel.toLowerCase().endsWith(".md")) throw new VaultError("Only .md files");
  const abs = await resolveInVault(rel, { mustExist: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Create a note or folder inside `parent` ("" = vault root). Returns its vault path. */
export async function createEntry(parent: string, name: string, type: "file" | "folder"): Promise<string> {
  await ensureVault();
  const finalName = type === "file" && !name.toLowerCase().endsWith(".md") ? `${name}.md` : name;
  checkName(finalName);
  const parentAbs = parent ? await resolveInVault(parent, { mustExist: true }) : VAULT_ROOT;
  const abs = await resolveInVault(toRel(path.join(parentAbs, finalName)));
  if (await exists(abs)) throw new VaultError("Already exists", 409);
  if (type === "folder") await fs.mkdir(abs);
  else await fs.writeFile(abs, "", { flag: "wx" }); // wx: fail rather than overwrite
  return toRel(abs);
}

/** Rename or move. `to` is the full new vault path. Never overwrites. */
export async function moveEntry(from: string, to: string): Promise<string> {
  const src = await resolveInVault(from, { mustExist: true });
  checkName(path.basename(to));
  const dest = await resolveInVault(to);
  if (src === dest) return toRel(dest);
  if ((await fs.stat(src)).isFile()) {
    const ext = path.extname(src).toLowerCase();
    if (ext === ".md" && !dest.toLowerCase().endsWith(".md")) throw new VaultError("Notes must end in .md");
    if (ext !== ".md" && path.extname(dest).toLowerCase() !== ext) throw new VaultError(`Keep the ${ext} ending`);
  }
  if (dest.startsWith(src + path.sep)) throw new VaultError("Can't move a folder into itself");
  if (await exists(dest)) throw new VaultError("Something with that name is already there", 409);
  await resolveInVault(toRel(path.dirname(dest)), { mustExist: true }); // destination folder must exist
  await fs.rename(src, dest);
  return toRel(dest);
}

/** An image's bytes (images only: notes are read with readNote). */
export async function readImage(rel: string): Promise<Buffer> {
  if (!IMAGE_FILE.test(rel)) throw new VaultError("Not an image");
  return fs.readFile(await resolveInVault(rel, { mustExist: true }));
}

/**
 * Save an image into a folder of the vault. If the name is taken, adds a
 * number ("photo 1.png") rather than overwriting. Returns its vault path.
 */
export async function saveImage(folder: string, name: string, bytes: Buffer): Promise<string> {
  checkName(name);
  if (!IMAGE_FILE.test(name)) throw new VaultError("Only images can be added");
  const dir = folder ? await resolveInVault(folder, { mustExist: true }) : (await ensureVault(), VAULT_ROOT);
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  for (let n = 0; n < 1000; n++) {
    const abs = await resolveInVault(toRel(path.join(dir, n ? `${base} ${n}${ext}` : name)));
    try {
      await fs.writeFile(abs, bytes, { flag: "wx" }); // wx: fail if it exists, never overwrite
      return toRel(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new VaultError("Too many files with that name", 409);
}

/** "Delete" = move into .trash with a timestamp, so nothing is lost by accident. */
export async function trashEntry(rel: string) {
  const src = await resolveInVault(rel, { mustExist: true });
  if (src === VAULT_ROOT) throw new VaultError("Can't delete the vault");
  const trash = path.join(VAULT_ROOT, TRASH);
  await fs.mkdir(trash, { recursive: true });
  const ext = path.extname(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.rename(src, path.join(trash, `${path.basename(src, ext)} (${stamp})${ext}`));
}

const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  );
