/**
 * Claude's text editor tool (text_editor_20250728), applied to one note held in
 * memory. The model may only touch this note: whatever `path` it sends, edits go
 * to the in-memory text, never to the filesystem.
 */

export type EditInput = {
  command?: string;
  path?: string;
  view_range?: [number, number];
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  file_text?: string;
};

export type EditResult = { note: string; output: string; changed: boolean; error?: boolean };

export function applyEdit(note: string, input: EditInput): EditResult {
  const fail = (output: string): EditResult => ({ note, output, changed: false, error: true });
  switch (input.command) {
    case "view": {
      const lines = note.split("\n");
      const [from, to] = input.view_range ?? [1, lines.length];
      const end = to === -1 ? lines.length : Math.min(to, lines.length);
      const shown = lines.slice(Math.max(from, 1) - 1, end).map((l, i) => `${Math.max(from, 1) + i}\t${l}`);
      return { note, output: shown.join("\n") || "(the note is empty)", changed: false };
    }
    case "str_replace": {
      const old = input.old_str ?? "";
      if (!old) return fail("old_str is required and can't be empty.");
      const count = note.split(old).length - 1;
      if (count === 0) return fail("No match for old_str in the note. View the note and copy the text exactly, including whitespace.");
      if (count > 1) return fail(`old_str matches ${count} places in the note. Include more surrounding text so it matches exactly one.`);
      const next = note.replace(old, () => input.new_str ?? "");
      return { note: next, output: "Edited the note.", changed: next !== note };
    }
    case "insert": {
      const lines = note.split("\n");
      const at = input.insert_line ?? -1;
      if (!Number.isInteger(at) || at < 0 || at > lines.length) return fail(`insert_line must be between 0 and ${lines.length}.`);
      if (input.insert_text === undefined) return fail("insert_text is required.");
      lines.splice(at, 0, ...input.insert_text.replace(/\n$/, "").split("\n"));
      return { note: lines.join("\n"), output: "Inserted into the note.", changed: true };
    }
    case "create": {
      if (input.file_text === undefined) return fail("file_text is required.");
      return { note: input.file_text, output: "Rewrote the note.", changed: input.file_text !== note };
    }
    default:
      return fail(`Unknown command "${input.command}". Use view, str_replace, insert, or create.`);
  }
}
