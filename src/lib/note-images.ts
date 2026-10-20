import { embeddedImages, listNotes, listOtherFiles, resolveFile } from "./notes";
import { listVault, readNote, restoreFromTrash, trashEntry, writeNote } from "./vault";

/**
 * Images belong to the notes that show them. When a note stops showing an
 * image (its ![[…]] was deleted) and no other note shows it either, the image
 * file goes to the vault's .trash, so it doesn't linger in the file tree.
 *
 * Undo still works: images moved to the trash this way are remembered, and if
 * a note shows one again (⌘Z, or the line pasted into another note), it's
 * moved back where it was.
 */

// Image path -> its name in .trash, for putting it back. Kept on globalThis so
// it survives dev hot reloads; it's in memory only (a restart forgets it, and
// the files stay in .trash as with any delete).
const g = globalThis as unknown as { flowTrashedImages?: Map<string, string> };
const trashed = (g.flowTrashedImages ??= new Map());

export type ImageChanges = { removed: string[]; restored: string[] };

/** Save a note, then trash images it no longer shows (if no other note does) and restore any it shows again. */
export async function saveNote(path: string, content: string): Promise<ImageChanges> {
  const before = await readNote(path).catch(() => "");
  await writeNote(path, content);
  const was = embeddedImages(before);
  const now = embeddedImages(content);
  const dropped = was.filter((t) => !now.some((n) => n.toLowerCase() === t.toLowerCase()));
  // Embeds that may point at an image this put in the trash (only worth checking if any are remembered).
  const maybeBack = trashed.size ? now : [];
  if (!dropped.length && !maybeBack.length) return { removed: [], restored: [] };

  const entries = await listVault();
  const files = listOtherFiles(entries);
  const restored: string[] = [];
  for (const target of maybeBack) {
    if (resolveFile(target, path, files)) continue; // it's there
    const back = [...trashed.keys()].find((p) => p.toLowerCase() === target.toLowerCase() || p.split("/").pop()!.toLowerCase() === target.toLowerCase());
    if (back && (await restoreFromTrash(trashed.get(back)!, back))) {
      trashed.delete(back);
      restored.push(back);
    }
  }

  const removed: string[] = [];
  if (dropped.length) {
    const candidates = new Set(dropped.map((t) => resolveFile(t, path, files)).filter((p): p is string => !!p));
    if (candidates.size) {
      // Still shown by any note (this one included, under another name)? Then keep it.
      for (const note of listNotes(entries)) {
        if (!candidates.size) break;
        const text = note.path === path ? content : await readNote(note.path).catch(() => "");
        for (const t of embeddedImages(text)) {
          const p = resolveFile(t, note.path, files);
          if (p) candidates.delete(p);
        }
      }
      for (const p of candidates) {
        try {
          trashed.set(p, await trashEntry(p));
          removed.push(p);
        } catch (e) {
          console.error("[note images] couldn't trash", p, e);
        }
      }
    }
  }
  if (removed.length || restored.length) console.log(`[note images] ${path}: trashed ${removed.length}, restored ${restored.length}`);
  return { removed, restored };
}
