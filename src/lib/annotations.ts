import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { touches } from "./cursor";
import { type LinkHost, refreshLinks } from "./wikilinks";

/**
 * Notes on text ("annotations"): highlight some words, write a note about them,
 * and click the words later to see it. Stored as plain Markdown that other apps
 * understand, Obsidian's highlight plus a standard footnote:
 *
 *     Typical tasks: ==KV store==[^1] with TTL…
 *
 *     [^1]: Ask about eviction policy
 *         (more lines of the same note are indented by 4 spaces)
 *
 * Obsidian shows that as highlighted text with a footnote; GitHub as a
 * footnote. In Flow the markers hide (off the cursor's line), the words get a
 * highlighter look, and clicking them pops the note up. The note lines at the
 * end of the file are hidden; they show (as plain text) only if the cursor
 * goes into them, e.g. ⌘↓ to the very end.
 *
 * The functions on plain text are separate from the editor, so they can be
 * tested (scripts/annotation-test.ts).
 */

export type AnnotationRef = { id: string; from: number; to: number; textFrom: number; textTo: number };
export type AnnotationDef = { id: string; from: number; to: number; text: string };

const REF = /==([^=\n]+?)==\[\^([\w-]+)\]/g;
const DEF = /^\[\^([\w-]+)\]:[ \t]?(.*)$/;
const CONTINUATION = /^( {4}|\t)/;
const FENCE = /^\s*(```|~~~)/;

/** Every annotated span and every note (definition) in a document, outside code blocks. */
export function parseAnnotations(doc: string): { refs: AnnotationRef[]; defs: Map<string, AnnotationDef> } {
  const refs: AnnotationRef[] = [];
  const defs = new Map<string, AnnotationDef>();
  const lines = doc.split("\n");
  let pos = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = pos;
    pos += line.length + 1;
    if (FENCE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const def = DEF.exec(line);
    if (def) {
      // The note goes on through the indented lines after it.
      const text = [def[2]];
      let end = start + line.length;
      while (i + 1 < lines.length && CONTINUATION.test(lines[i + 1])) {
        i++;
        text.push(lines[i].replace(CONTINUATION, ""));
        end = pos + lines[i].length;
        pos += lines[i].length + 1;
      }
      if (!defs.has(def[1])) defs.set(def[1], { id: def[1], from: start, to: end, text: text.join("\n") });
      continue;
    }
    for (const m of line.matchAll(REF)) {
      const from = start + m.index!;
      refs.push({ id: m[2], from, to: from + m[0].length, textFrom: from + 2, textTo: from + 2 + m[1].length });
    }
  }
  return { refs, defs };
}

/** A note's text as definition lines: later lines indented, so they stay part of the same note. */
const defLines = (id: string, note: string) => `[^${id}]: ${note.trim().split("\n").join("\n    ")}`;

export type TextChange = { from: number; to: number; insert: string };

/**
 * Annotate `from`..`to` with `note`: wraps the words and adds the note at the
 * end of the document (after any other notes). Null if the text can't hold an
 * annotation (several lines, or it already has == in it).
 */
export function addAnnotation(doc: string, from: number, to: number, note: string): { changes: TextChange[]; id: string } | null {
  const text = doc.slice(from, to);
  if (!text.trim() || !note.trim() || text.includes("\n") || text.includes("==")) return null;
  const { refs, defs } = parseAnnotations(doc);
  const used = [...defs.keys(), ...refs.map((r) => r.id)].map(Number).filter(Number.isFinite);
  const id = String(Math.max(0, ...used) + 1);
  // After the last real text, so the note list stays together at the end.
  const end = doc.replace(/\s+$/, "").length;
  const lastLine = doc.slice(0, end).split("\n").at(-1) ?? "";
  const gap = end === 0 ? "" : DEF.test(lastLine) || CONTINUATION.test(lastLine) ? "\n" : "\n\n";
  return {
    id,
    changes: [
      { from, to, insert: `==${text}==[^${id}]` },
      // Always a line after the notes: clicking below the text puts the cursor there, not in the (hidden) notes.
      { from: end, to: end, insert: gap + defLines(id, note) + (doc.slice(end).includes("\n") ? "" : "\n") },
    ],
  };
}

/** Change a note's text. */
export function updateAnnotation(doc: string, id: string, note: string): TextChange[] | null {
  const def = parseAnnotations(doc).defs.get(id);
  if (!def || !note.trim()) return null;
  return [{ from: def.from, to: def.to, insert: defLines(id, note) }];
}

/** Remove a note: the words go back to plain text and the note is deleted. */
export function removeAnnotation(doc: string, id: string): TextChange[] {
  const { refs, defs } = parseAnnotations(doc);
  const changes: TextChange[] = refs.filter((r) => r.id === id).map((r) => ({ from: r.from, to: r.to, insert: doc.slice(r.textFrom, r.textTo) }));
  const def = defs.get(id);
  if (def) {
    // Take the line break before it too, so no empty line is left behind.
    const from = def.from > 0 && doc[def.from - 1] === "\n" ? def.from - 1 : def.from;
    changes.push({ from, to: def.to, insert: "" });
  }
  return changes;
}

// ---------- in the editor ----------


/** Highlights annotated words (markers hidden off the cursor's line), styles the notes at the end, and opens a note on click. */
export function annotations(getHost: () => LinkHost): Extension[] {
  const decorate = (view: EditorView): DecorationSet => {
    const { state } = view;
    const { refs, defs } = parseAnnotations(state.doc.toString());
    const decos: Range<Decoration>[] = [];
    for (const r of refs) {
      const missing = !defs.has(r.id);
      const attributes = { "data-annot": r.id, title: missing ? "This note is missing" : "Show note" };
      const cls = `cm-annot${missing ? " cm-annot-missing" : ""}`;
      if (touches(state, r.from, r.to)) {
        decos.push(Decoration.mark({ class: `${cls} cm-annot-raw`, attributes }).range(r.textFrom, r.textTo));
      } else {
        decos.push(Decoration.replace({}).range(r.from, r.textFrom));
        decos.push(Decoration.mark({ class: cls, attributes }).range(r.textFrom, r.textTo));
        decos.push(Decoration.replace({}).range(r.textTo, r.to));
      }
    }
    // Note lines the cursor is in show as plain text (the rest are hidden by `hideNotes`).
    for (const d of defs.values()) {
      for (let n = state.doc.lineAt(d.from).number; n <= state.doc.lineAt(d.to).number; n++) {
        decos.push(Decoration.line({ class: "cm-annot-def" }).range(state.doc.line(n).from));
      }
    }
    return Decoration.set(decos, true);
  };

  /**
   * Hide the note lines ("[^1]: …") and the blank lines just above them.
   * Hiding whole lines changes the layout, which CodeMirror only allows from
   * a state field (not a view plugin, like the highlights above).
   */
  const hideNotes = StateField.define<DecorationSet>({
    create: (state) => hiddenNotes(state),
    update: (value, tr) => (tr.docChanged || tr.selection ? hiddenNotes(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(refreshLinks)))) this.decorations = decorate(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

  // Click the words to see the note. While editing that line, a plain click
  // places the cursor and ⌘/Ctrl-click opens the note (same as links).
  const clicks = EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>(".cm-annot");
      if (!el || e.button !== 0 || !el.dataset.annot) return false;
      if (el.classList.contains("cm-annot-raw") && !(e.metaKey || e.ctrlKey)) return false;
      e.preventDefault();
      getHost().openAnnotation?.(el.dataset.annot, el.getBoundingClientRect());
      return true;
    },
  });

  // A highlighter look: warm yellow fill that works on light and dark themes.
  const ink = (pct: number) => `color-mix(in srgb, #f5c542 ${pct}%, transparent)`;
  const theme = EditorView.theme({
    ".cm-annot": { backgroundColor: ink(32), borderBottom: `1.5px dotted ${ink(95)}`, borderRadius: "2px", cursor: "pointer", transition: "background 120ms" },
    ".cm-annot:hover": { backgroundColor: ink(48) },
    ".cm-annot-raw": { cursor: "text" },
    ".cm-annot-missing": { backgroundColor: "transparent", borderBottomStyle: "dashed" },
    ".cm-annot-def": { color: "var(--muted)", fontSize: "0.85em" },
    ".cm-annot-def *": { color: "inherit" }, // the highlighter colors "[^1]:" as a link label
  });

  return [plugin, hideNotes, clicks, theme];
}

/** Blocks of note lines to hide: runs of definitions (blank lines between them allowed), plus the blank lines before each run. */
function hiddenNotes(state: EditorState): DecorationSet {
  const { doc } = state;
  const { defs } = parseAnnotations(doc.toString());
  if (!defs.size) return Decoration.none;
  // Line numbers of note lines, in order.
  const noteLines = new Set<number>();
  for (const d of defs.values()) for (let n = doc.lineAt(d.from).number; n <= doc.lineAt(d.to).number; n++) noteLines.add(n);
  const blank = (n: number) => !doc.line(n).text.trim();
  const blocks: [number, number][] = [];
  for (const n of [...noteLines].sort((a, b) => a - b)) {
    const last = blocks.at(-1);
    // Same block if only blank lines lie between this and the previous note line.
    let joined = false;
    if (last) {
      let k = last[1] + 1;
      while (k < n && blank(k)) k++;
      if (k === n) {
        last[1] = n;
        joined = true;
      }
    }
    if (!joined) {
      let first = n;
      while (first > 1 && blank(first - 1)) first--; // take the blank lines above it too
      blocks.push([first, n]);
    }
  }
  const decos: Range<Decoration>[] = [];
  for (const [first, last] of blocks) {
    const from = doc.line(first).from;
    const to = doc.line(last).to;
    // The cursor is in it (e.g. ⌘↓ to the end): show it, so it can still be edited as text.
    if (state.selection.ranges.some((r) => r.to >= from && r.from <= to)) continue;
    decos.push(Decoration.replace({ block: true }).range(from, to));
  }
  return Decoration.set(decos);
}
