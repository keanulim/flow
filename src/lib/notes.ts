import type { VaultEntry } from "./vault";

/**
 * Notes by name, shared by the browser (the editor's [[links]]) and the server
 * (the note assistant), so both resolve a link to the same note.
 */

export type NoteInfo = { path: string; name: string; folder: string };

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Images kept in the vault (embedded in notes with ![[name.png]]). */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
export const isNotePath = (path: string) => /\.md$/i.test(path);

/** Every note in the vault's tree, flattened. */
export function listNotes(entries: VaultEntry[]): NoteInfo[] {
  return flatten(entries).filter((e) => isNotePath(e.path)).map((e) => ({ path: e.path, name: e.name.replace(/\.md$/i, ""), folder: folderOf(e.path) }));
}

/** Every file in the vault that isn't a note (images), flattened. `name` keeps its extension. */
export function listOtherFiles(entries: VaultEntry[]): NoteInfo[] {
  return flatten(entries).filter((e) => !isNotePath(e.path)).map((e) => ({ path: e.path, name: e.name, folder: folderOf(e.path) }));
}

function flatten(entries: VaultEntry[]): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  const walk = (list: VaultEntry[]) => list.forEach((e) => (e.type === "folder" ? walk(e.children) : out.push(e)));
  walk(entries);
  return out;
}

/**
 * Which file an embed like ![[photo.png]] points to, Obsidian style: an exact
 * vault path, else a file of that name, preferring the folder of `from`, then the shortest path.
 */
export function resolveFile(target: string, from: string | null, files: NoteInfo[]): string | null {
  const t = target.trim().replace(/^\//, "").toLowerCase();
  if (t.includes("/")) return files.find((f) => f.path.toLowerCase() === t)?.path ?? null; // a path; a bare name is matched by name below
  const matches = files.filter((f) => f.name.toLowerCase() === t);
  if (!matches.length) return null;
  const here = from ? folderOf(from) : "";
  return (matches.find((f) => f.folder === here) ?? [...matches].sort((a, b) => a.path.length - b.path.length)[0]).path;
}

/** Which note a link points to: an exact "folder/name", else a same-named note, preferring the folder of `from`. */
export function resolveNote(target: string, from: string | null, notes: NoteInfo[]): string | null {
  const t = target.replace(/\.md$/i, "").trim().toLowerCase();
  if (t.includes("/")) return notes.find((n) => n.path.toLowerCase() === `${t}.md`)?.path ?? null;
  const matches = notes.filter((n) => n.name.toLowerCase() === t);
  if (!matches.length) return null;
  const here = from ? folderOf(from) : "";
  return (matches.find((n) => n.folder === here) ?? [...matches].sort((a, b) => a.path.length - b.path.length)[0]).path;
}

/** The pages a note links to with [[Page]] / [[Page|text]] / [[Page#Heading]], in order, once each (outside code blocks). */
export function linkedPages(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const m of maskInlineCode(line).matchAll(/(?<!!)\[\[([^[\]\n|]+)(?:\|[^[\]\n]+)?\]\]/g)) { // not ![[embeds]] or `code`
      const page = m[1].split("#")[0].trim();
      if (page && !out.includes(page)) out.push(page);
    }
  }
  return out;
}

/** The images a note embeds with ![[name]] / ![[name|width]], once each, in order (outside code blocks). */
export function embeddedImages(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const m of maskInlineCode(line).matchAll(/!\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g)) {
      const target = m[1].trim();
      if (target && !out.some((t) => t.toLowerCase() === target.toLowerCase())) out.push(target);
    }
  }
  return out;
}

/** A line with its `inline code` blanked out (same length, so positions still line up): links and embeds in code are examples, not real. */
export function maskInlineCode(line: string): string {
  return line.replace(/(`+)[^`].*?\1/g, (code) => " ".repeat(code.length));
}
