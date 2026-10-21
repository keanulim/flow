import fs from "node:fs/promises";
import path from "node:path";
import { IMAGE_FILE } from "./notes";
import { vaultDir } from "./sandbox";

/**
 * The vault: a plain folder of Markdown files, like an Obsidian vault. Notes
 * stay ordinary files, so any editor (Obsidian included) can open them too.
 * Set FLOW_VAULT_PATH to point Flow at an existing vault.
 */
// The notes folder: data/vault, FLOW_VAULT_PATH, or (demo mode) the visitor's sandbox. A function, not a constant, for that.
const vaultRoot = () => vaultDir();
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
  const abs = path.resolve(vaultRoot(), cleaned);
  if (abs !== vaultRoot() && !abs.startsWith(vaultRoot() + path.sep)) throw new VaultError("Path is outside the vault");
  if (cleaned.split("/")[0] === TRASH) throw new VaultError("Path is in the trash");

  // A symlink inside the vault could still point elsewhere: check where it really lands.
  const real = await fs.realpath(abs).catch(() => null);
  if (real) {
    const root = await fs.realpath(vaultRoot());
    if (real !== root && !real.startsWith(root + path.sep)) throw new VaultError("Path is outside the vault");
  } else if (mustExist) {
    throw new VaultError("Not found", 404);
  }
  return abs;
}

const toRel = (abs: string) => path.relative(vaultRoot(), abs).split(path.sep).join("/");

// ---------- custom order (drag to arrange) ----------

/**
 * The order you've arranged things in, per folder ("" = the top level): names
 * in order. Kept inside the vault (hidden, like .trash), so it travels with the
 * notes. A folder that's never been arranged sorts folders first, then A to Z;
 * anything not in a folder's list (new items) goes after the listed ones.
 */
type Order = Record<string, string[]>;
const ORDER_FILE = () => path.join(vaultRoot(), ".flow", "order.json");

async function readOrder(): Promise<Order> {
  try {
    const parsed = JSON.parse(await fs.readFile(ORDER_FILE(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Order) : {};
  } catch {
    return {};
  }
}

async function writeOrder(order: Order) {
  await fs.mkdir(path.dirname(ORDER_FILE()), { recursive: true });
  await fs.writeFile(ORDER_FILE(), JSON.stringify(order, null, 2));
}

const parentRel = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseName = (rel: string) => rel.split("/").pop()!;

/** Keep the saved order in step after something moved from `from` to `to` (rename or move); `to` null = deleted. */
async function updateOrder(from: string, to: string | null) {
  const order = await readOrder();
  if (!Object.keys(order).length) return;
  const oldParent = parentRel(from);
  const list = order[oldParent];
  if (list) {
    const i = list.indexOf(baseName(from));
    if (i >= 0) {
      // Renamed in place: same spot. Moved or deleted: out of this folder's list.
      if (to !== null && parentRel(to) === oldParent) list[i] = baseName(to);
      else list.splice(i, 1);
    }
  }
  // A folder's own list (and its subfolders') follow it, or go with it.
  for (const key of Object.keys(order)) {
    if (key === from || key.startsWith(from + "/")) {
      const lists = order[key];
      delete order[key];
      if (to !== null) order[to + key.slice(from.length)] = lists;
    }
  }
  await writeOrder(order);
}

function checkName(name: string) {
  if (!name || name === "." || name === ".." || /[\/\\\0]/.test(name) || name.startsWith(".")) {
    throw new VaultError("Invalid name");
  }
}

export async function ensureVault() {
  await fs.mkdir(vaultRoot(), { recursive: true });
}

/** Folders, .md notes and images, folders first, alphabetical. Hidden entries (.trash, .obsidian) are skipped. */
export async function listVault(): Promise<VaultEntry[]> {
  await ensureVault();
  const order = await readOrder();
  const walk = async (dir: string): Promise<VaultEntry[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: VaultEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) out.push({ type: "folder", name: e.name, path: toRel(abs), children: await walk(abs) });
      else if (e.isFile() && (e.name.toLowerCase().endsWith(".md") || IMAGE_FILE.test(e.name))) out.push({ type: "file", name: e.name, path: toRel(abs) });
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "folder" ? -1 : 1));
    // Arranged by dragging: the saved order first, anything new after it (in the default order).
    const arranged = order[toRel(dir) === "" ? "" : toRel(dir)];
    if (!arranged?.length) return out;
    const rank = (e: VaultEntry) => {
      const i = arranged.indexOf(e.name);
      return i < 0 ? arranged.length : i;
    };
    return out.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map(({ e }) => e);
  };
  return walk(vaultRoot());
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
  const parentAbs = parent ? await resolveInVault(parent, { mustExist: true }) : vaultRoot();
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
  await updateOrder(toRel(src), toRel(dest));
  return toRel(dest);
}

/**
 * Put an entry at a spot: in `folder` ("" = top level), just before the item
 * named `before` (null = at the end). Moves it there first if it's elsewhere.
 * Returns its (possibly new) path.
 */
export async function placeEntry(rel: string, folder: string, before: string | null): Promise<string> {
  let at = rel;
  if (parentRel(rel) !== folder) at = await moveEntry(rel, (folder ? folder + "/" : "") + baseName(rel));
  if (folder) await resolveInVault(folder, { mustExist: true }); // the folder must be real, and inside the vault
  // The folder as it's shown now, then this item taken out and put at its spot.
  const names = (await childrenOf(folder)).filter((n) => n !== baseName(at));
  const i = before === null ? -1 : names.indexOf(before);
  names.splice(i < 0 ? names.length : i, 0, baseName(at));
  const order = await readOrder();
  order[folder] = names;
  await writeOrder(order);
  return at;
}

/** The names in a folder, in the order the tree shows them. */
async function childrenOf(folder: string): Promise<string[]> {
  let list = await listVault();
  for (const part of folder ? folder.split("/") : []) {
    const next = list.find((e) => e.type === "folder" && e.name === part);
    list = next?.type === "folder" ? next.children : [];
  }
  return list.map((e) => e.name);
}

/** A page name from free text: no characters that are awkward in file names or [[links]]. */
export function cleanNoteName(text: string): string {
  return text
    .replace(/\.md$/i, "")
    .replace(/[\\/:*?"<>|#^[\]\0]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "") // no leading dots: that would be a hidden file
    .trim()
    .slice(0, 100);
}

/**
 * Create a new note with content (the note assistant's create_note). Never
 * overwrites: if the name is taken, adds a number ("Ideas 1"). The folder
 * must already exist. Returns its vault path.
 */
export async function createNoteWithContent(folder: string, name: string, content: string): Promise<string> {
  const base = cleanNoteName(name);
  if (!base) throw new VaultError("The page needs a name");
  const dir = folder ? await resolveInVault(folder, { mustExist: true }) : (await ensureVault(), vaultRoot());
  if (!(await fs.stat(dir)).isDirectory()) throw new VaultError("Not a folder");
  for (let n = 0; n < 100; n++) {
    const abs = await resolveInVault(toRel(path.join(dir, `${n ? `${base} ${n}` : base}.md`)));
    try {
      await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" }); // wx: fail if it exists
      return toRel(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new VaultError("Too many pages with that name", 409);
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
  const dir = folder ? await resolveInVault(folder, { mustExist: true }) : (await ensureVault(), vaultRoot());
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

/** "Delete" = move into .trash with a timestamp, so nothing is lost by accident. Returns its name in the trash. */
export async function trashEntry(rel: string): Promise<string> {
  const src = await resolveInVault(rel, { mustExist: true });
  if (src === vaultRoot()) throw new VaultError("Can't delete the vault");
  const trash = path.join(vaultRoot(), TRASH);
  await fs.mkdir(trash, { recursive: true });
  const ext = path.extname(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${path.basename(src, ext)} (${stamp})${ext}`;
  await fs.rename(src, path.join(trash, name));
  await updateOrder(rel.replace(/^\/+/, ""), null);
  return name;
}

/** Move something back out of .trash to `rel` (which must be free, in an existing folder). False if it can't be. */
export async function restoreFromTrash(trashedName: string, rel: string): Promise<boolean> {
  if (!trashedName || /[\/\\\0]/.test(trashedName) || trashedName.startsWith(".")) return false;
  const src = path.join(vaultRoot(), TRASH, trashedName);
  const dest = await resolveInVault(rel).catch(() => null);
  if (!dest || (await exists(dest)) || !(await exists(src))) return false;
  if (!(await exists(path.dirname(dest)))) return false;
  await fs.rename(src, dest);
  return true;
}

const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  );
