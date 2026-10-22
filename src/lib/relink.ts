import { type NoteInfo, resolveFile, resolveNote } from "./notes";

/**
 * Keeping links working when notes, images or folders are renamed or moved
 * (Obsidian does the same). Every [[link]] and ![[embed]] is resolved against
 * the files before the change and again after it; any that would now point
 * somewhere else (or nowhere) is rewritten to point where it did before.
 *
 * That covers more than the renamed name: moving a note can change what a
 * plain [[Name]] inside it (or pointing at it) means, since names resolve
 * to the same folder first. Labels ([[Page|text]]) and headings ([[Page#Part]])
 * are kept; links in code are left alone.
 *
 * Pure text in, text out: the file reading and writing is in the route.
 */

export type Files = { notes: NoteInfo[]; others: NoteInfo[] };

// [[target#heading|label]], with an optional ! for an embed.
const LINK = /(!?)\[\[([^[\]\n|#]+)(#[^[\]\n|]*)?(\|[^[\]\n]*)?\]\]/g;
const FENCE = /^\s*(```|~~~)/;

/** Where a link target points, from a note at `from`: a note, or (for an embed) a file. */
function resolve(target: string, embed: boolean, from: string, files: Files): string | null {
  return embed ? resolveFile(target, from, files.others) : resolveNote(target, from, files.notes);
}

/** The shortest link text that points at `path` from `from`: the name if that's unambiguous, else the path. */
export function linkTargetFor(path: string, embed: boolean, from: string, files: Files): string {
  const name = path.split("/").pop()!;
  const short = embed ? name : name.replace(/\.md$/i, "");
  if (resolve(short, embed, from, files) === path) return short;
  return embed ? path : path.replace(/\.md$/i, "");
}

/**
 * Rewrite one note's links after a change. `fromBefore` / `fromAfter` are the
 * note's own path before and after (it may have moved too); `moved` maps old
 * paths to new ones. Returns the new text, or null if nothing changed.
 */
export function relinkNote(text: string, fromBefore: string, fromAfter: string, before: Files, after: Files, moved: Map<string, string>): string | null {
  let changed = false;
  let inFence = false;
  const out = text.split("\n").map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !line.includes("[[")) return line;
    // Inline `code` is blanked out while finding links (same length, so positions line up).
    const masked = line.replace(/(`+)[^`].*?\1/g, (code) => " ".repeat(code.length));
    let result = "";
    let at = 0;
    for (const m of masked.matchAll(LINK)) {
      const [whole, bang, rawTarget, heading = "", label = ""] = m;
      const embed = bang === "!";
      const target = rawTarget.trim();
      const was = resolve(target, embed, fromBefore, before);
      if (!was) continue; // pointed nowhere before: nothing to keep
      const intended = moved.get(was) ?? was;
      if (resolve(target, embed, fromAfter, after) === intended) continue; // still right
      // Written as a path? Keep it a path. Otherwise the shortest text that points there.
      const next = target.includes("/") ? (embed ? intended : intended.replace(/\.md$/i, "")) : linkTargetFor(intended, embed, fromAfter, after);
      result += line.slice(at, m.index) + `${bang}[[${next}${heading}${label}]]`;
      at = m.index! + whole.length;
      changed = true;
    }
    return at ? result + line.slice(at) : line;
  });
  return changed ? out.join("\n") : null;
}
