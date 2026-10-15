import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { indent, parseToggles, toggles } from "./toggles";
import { type LinkHost, wikilinks } from "./wikilinks";

/**
 * Obsidian-style live preview for Markdown, on top of CodeMirror 6.
 *
 * The file stays plain Markdown; only how it's *shown* changes:
 *  - `#`..`######` headings render as headings, and their `#` marks hide
 *    unless the cursor is on that line (so you can still edit them).
 *  - Bold, italic, inline code and strikethrough are styled; their marks
 *    (**, *, `, ~~) hide off the cursor's line, and `-` bullets show as •.
 *  - Tables render as tables until the cursor moves into one.
 *  - Code fences get their own line styling.
 *  - `>` is an ordinary character here: the parser's blockquote rule is
 *    removed, so there's no quote styling and Enter doesn't repeat `>`.
 */

const HEADING = /^(#{1,6})[ \t]+/;
const FENCE = /^\s*(```|~~~)/;

/** Line numbers the selection touches; heading marks stay visible there so they can be edited. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

/** Line styles and hidden heading marks for the whole document. Exported for tests. */
export function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  let inFence = false;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;

    if (inFence || FENCE.test(text)) {
      if (FENCE.test(text)) inFence = !inFence;
      decos.push(Decoration.line({ class: "cm-md-fence" }).range(line.from));
      continue;
    }

    const h = HEADING.exec(text);
    if (h) {
      decos.push(Decoration.line({ class: `cm-md-h cm-md-h${h[1].length}` }).range(line.from));
      if (!active.has(n)) decos.push(Decoration.replace({}).range(line.from, line.from + h[0].length));
      continue;
    }
  }

  inline(state, active, decos);
  return Decoration.set(decos, true);
}

/** Marks to hide, bullets to draw, tables to render: from the Markdown syntax tree. */
function inline(state: EditorState, active: Set<number>, decos: Range<Decoration>[]) {
  const doc = state.doc;
  // A note is small; parse all of it so nothing past the first screen is missed.
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  const lineOf = (pos: number) => doc.lineAt(pos).number;
  const toggleLines = parseToggles(doc).lines;
  tree.iterate({
    enter: (node) => {
      switch (node.name) {
        case "FencedCode":
        case "CodeBlock":
        case "HTMLBlock":
          return false; // nothing to render inside
        case "Table": {
          const first = lineOf(node.from);
          const last = lineOf(node.to);
          for (let n = first; n <= last; n++) if (active.has(n)) return false; // editing it: show the raw table
          const inToggle = toggleLines.get(first);
          const style = inToggle?.role === "body" ? (indent(inToggle.toggle.depth + 1).style ?? "") : ""; // line up with the toggle's other lines
          decos.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(doc.line(first).from, doc.line(last).to), style), block: true }).range(doc.line(first).from, doc.line(last).to));
          return false;
        }
        case "EmphasisMark":
        case "CodeMark":
        case "StrikethroughMark":
          if (!active.has(lineOf(node.from))) decos.push(Decoration.replace({}).range(node.from, node.to));
          return;
        case "Escape": // \* -> *
          if (!active.has(lineOf(node.from))) decos.push(Decoration.replace({}).range(node.from, node.from + 1));
          return;
        case "ListMark": {
          const mark = doc.sliceString(node.from, node.to);
          if (/^[-*+]$/.test(mark) && !active.has(lineOf(node.from))) decos.push(Decoration.replace({ widget: bullet }).range(node.from, node.to));
          return;
        }
      }
    },
  });
}

class Bullet extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = "•";
    return el;
  }
  eq() {
    return true;
  }
}
const bullet = new Bullet();

/** A Markdown table, drawn as an HTML table. Clicking it puts the cursor inside, which shows the raw text. */
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly style: string,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.style === this.style;
  }
  toDOM() {
    const rows = this.source.split("\n").map(cells);
    const align = (rows[1] ?? []).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table";
    if (this.style) wrap.setAttribute("style", this.style);
    const table = document.createElement("table");
    rows.forEach((row, i) => {
      if (i === 1) return; // the |---| delimiter row
      const tr = table.insertRow();
      row.forEach((text, j) => {
        const cell = document.createElement(i === 0 ? "th" : "td");
        if (align[j]) cell.style.textAlign = align[j];
        cell.innerHTML = inlineHtml(text);
        tr.appendChild(cell);
      });
    });
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() {
    return false; // let a click through, so it places the cursor in the table
  }
}

/** "| a | b \\| c |" -> ["a", "b | c"]. */
function cells(line: string): string[] {
  const parts = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
  return parts.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Inline Markdown in a table cell -> safe HTML (text is escaped first). */
export function inlineHtml(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(?<![*\w])\*(?!\s)(.+?)\*|(?<!\w)_(?!\s)(.+?)_(?!\w)/g, (_, a, b) => `<em>${a ?? b}</em>`)
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_, target, text) => text ?? target)
    .replace(/\\([*_`~|\\])/g, "$1");
}

const livePreview = StateField.define<DecorationSet>({
  create: build,
  update: (value, tr) => (tr.docChanged || tr.selection ? build(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "650" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--muted)" },
  { tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.9em" },
  { tag: tags.processingInstruction, color: "var(--muted)", opacity: "0.6" }, // the *, ` marks
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-inter), system-ui, sans-serif", lineHeight: "1.7", overflow: "visible" },
  ".cm-content": { padding: "0 0 40vh", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-md-h": { fontWeight: "650", lineHeight: "1.35" },
  ".cm-md-h1": { fontSize: "1.85em", paddingTop: "0.6em" },
  ".cm-md-h2": { fontSize: "1.45em", paddingTop: "0.5em" },
  ".cm-md-h3": { fontSize: "1.2em", paddingTop: "0.4em" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontSize: "1.05em" },
  ".cm-md-bullet": { color: "var(--muted)", display: "inline-block", width: "0.6em" },
  ".cm-md-table": { padding: "0.4em 0", overflowX: "auto", cursor: "text" },
  ".cm-md-table table": { borderCollapse: "collapse", fontSize: "0.92em", lineHeight: "1.5" },
  ".cm-md-table th, .cm-md-table td": { border: "1px solid var(--line)", padding: "0.35em 0.7em", verticalAlign: "top", textAlign: "left" },
  ".cm-md-table th": { fontWeight: "650", backgroundColor: "var(--hover)" },
  ".cm-md-table code": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.9em" },
  ".cm-md-fence": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.88em", backgroundColor: "var(--hover)", paddingLeft: "0.8em !important" },
});

export function liveMarkdown(getLinkHost?: () => LinkHost, placeholderText = "Start writing…"): Extension[] {
  return [
    ...(getLinkHost ? wikilinks(getLinkHost) : []), // [[links]] between notes
    // GFM, minus blockquotes. Enter still continues lists.
    markdown({ base: markdownLanguage, extensions: { remove: ["Blockquote"] } }),
    syntaxHighlighting(highlight),
    livePreview,
    toggles(), // collapsible <details> blocks; also owns Tab / Shift+Tab
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    placeholder(placeholderText),
    theme,
  ];
}
