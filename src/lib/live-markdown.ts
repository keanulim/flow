import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import katex from "katex";
import { ACCENTED } from "./accents";
import { touches } from "./cursor";
import { DISPLAY_LINE, DISPLAY_OPEN, displayClose, findInlineMath } from "./math";
import { INDENT, indent, parseToggles, toggles } from "./toggles";
import { annotations } from "./annotations";
import { type LinkHost, wikilinks } from "./wikilinks";

/**
 * Obsidian-style live preview for Markdown, on top of CodeMirror 6.
 *
 * The file stays plain Markdown; only how it's *shown* changes. Markup shows
 * only where you're editing: inline syntax (bold's **, a formula's LaTeX, a
 * link's brackets) only while the cursor is in that piece of text, headings'
 * # on their line, tables and code fences while the cursor is in them:
 *  - `#`..`######` headings render as headings.
 *  - Bold, italic, `code` and ~~strikethrough~~ are styled; `-` bullets show as •.
 *  - [Web links](https://…) and bare URLs are clickable; images show.
 *  - Tables render as tables until the cursor moves into one.
 *  - Code fences become a box; `---` becomes a rule; `- [ ]` tasks get a checkbox.
 *  - Math ($x$, \(x\), $$ … $$ blocks) renders with KaTeX off the cursor.
 *  - `>` is an ordinary character here: the parser's blockquote rule is
 *    removed, so there's no quote styling and Enter doesn't repeat `>`.
 *
 * Spacing reads like a rendered page rather than a text file: a blank line
 * between blocks is a short gap (0.75em), list items get a little air, and
 * headings get room above them.
 */

const HEADING = /^(#{1,6})[ \t]+/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const SAFE_URL = /^(https?:|mailto:)/i;

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
  const toggleLines = parseToggles(doc).lines;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;

    if (inFence || FENCE.test(text)) {
      const opening = !inFence;
      if (FENCE.test(text)) inFence = !inFence;
      const edge = FENCE.test(text) ? (opening ? " cm-md-fence-open" : " cm-md-fence-close") : "";
      // Off the cursor, the ``` lines are just the box's top and bottom padding.
      const hideMarker = edge && !active.has(n);
      // Inside a toggle, the whole box moves to the toggle's indent. (A toggle indents its lines with
      // padding, which the box's own padding would override, so here it's a margin. The box's text is
      // smaller (0.875em), hence dividing to get the toggle's em.)
      const inToggle = toggleLines.get(n);
      const level = inToggle?.role === "body" ? inToggle.toggle.depth + 1 : 0;
      const attributes = level ? { style: `margin-left:calc(${level * INDENT}em / 0.875);background-image:none !important` } : undefined;
      decos.push(Decoration.line({ class: `cm-md-fence${edge}${hideMarker ? " cm-md-fence-edge" : ""}`, attributes }).range(line.from));
      if (hideMarker && line.length) decos.push(Decoration.replace({}).range(line.from, line.to));
      continue;
    }

    if (!text.trim()) {
      decos.push(Decoration.line({ class: "cm-md-gap" }).range(line.from)); // a blank line between blocks: a short gap
      continue;
    }

    // A display formula: $$ … $$ (or \[ … \]) over several lines, or one line of $$x$$.
    const open = DISPLAY_OPEN.exec(text);
    const single = open ? null : DISPLAY_LINE.exec(text);
    if (open || single) {
      let last = n;
      if (open) {
        const close = displayClose(open[1]);
        while (last < doc.lines && !close.test(doc.line(last + 1).text)) last++;
        if (last === doc.lines) last = n; // never closed (still being typed): leave it as text
        else last++;
      }
      if (open && last === n) {
        decos.push(Decoration.line({ class: "cm-md-math-src" }).range(line.from));
        continue;
      }
      let editing = false;
      for (let k = n; k <= last; k++) if (active.has(k)) editing = true;
      const tex = open ? doc.sliceString(doc.line(n + 1).from, doc.line(last - 1).to) : (single![1] ?? single![2]);
      if (editing) {
        for (let k = n; k <= last; k++) decos.push(Decoration.line({ class: "cm-md-math-src" }).range(doc.line(k).from));
      } else {
        decos.push(Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(line.from, doc.line(last).to));
      }
      n = last;
      continue;
    }

    const h = HEADING.exec(text);
    if (h) {
      decos.push(Decoration.line({ class: `cm-md-h cm-md-h${h[1].length}${n === 1 ? " cm-md-first" : ""}` }).range(line.from));
      if (!active.has(n)) decos.push(Decoration.replace({}).range(line.from, line.from + h[0].length));
      continue;
    }

    if (LIST_ITEM.test(text) && n > 1 && LIST_ITEM.test(doc.line(n - 1).text)) {
      decos.push(Decoration.line({ class: "cm-md-li-next" }).range(line.from)); // like li + li
    }
  }

  inline(state, active, decos);
  inlineMath(state, decos);
  // θ̂ typed as text: a font that puts the hat over the letter (see accents.ts).
  const text = doc.toString();
  if (/[\u0300-\u036F\u20D0-\u20FF]/.test(text)) {
    for (const m of text.matchAll(ACCENTED)) decos.push(Decoration.mark({ class: "cm-accent" }).range(m.index!, m.index! + m[0].length));
  }
  return Decoration.set(decos, true);
}

/** Marks to hide, bullets to draw, tables to render: from the Markdown syntax tree. */
function inline(state: EditorState, active: Set<number>, decos: Range<Decoration>[]) {
  const doc = state.doc;
  // A note is small; parse all of it so nothing past the first screen is missed.
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  const lineOf = (pos: number) => doc.lineAt(pos).number;
  const parsedToggles = parseToggles(doc);
  const toggleLines = parsedToggles.lines;
  // The blank line after a toggle is hidden with its tags, so the gap goes on the line after it.
  for (const t of parsedToggles.toggles) {
    const after = (t.trailerLine ?? t.closeLine ?? doc.lines) + 1;
    if (t.closeLine !== null && after <= doc.lines && !toggleLines.has(after)) decos.push(Decoration.line({ class: "cm-md-after-toggle" }).range(doc.line(after).from));
  }
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
        case "StrikethroughMark": {
          // The marks show only while the cursor is in that bold/italic/code/strikethrough text.
          const whole = node.node.parent ?? node.node;
          if (!touches(state, whole.from, whole.to)) decos.push(Decoration.replace({}).range(node.from, node.to));
          return;
        }
        case "Escape": // \* -> *
          if (!touches(state, node.from, node.to)) decos.push(Decoration.replace({}).range(node.from, node.from + 1));
          return;
        case "InlineCode":
          decos.push(Decoration.mark({ class: "cm-md-code" }).range(node.from, node.to));
          return; // its CodeMarks are hidden by the case above
        case "ListMark": {
          const mark = doc.sliceString(node.from, node.to);
          const task = node.node.parent?.getChild("Task"); // "- [ ] x": the checkbox replaces the bullet
          const isTask = !!task;
          // The "-" (and "[ ]") show only with the cursor on them, not anywhere in the item's text.
          if (touches(state, node.from, task?.getChild("TaskMarker")?.to ?? node.to)) return;
          if (/^[-*+]$/.test(mark)) decos.push(Decoration.replace(isTask ? {} : { widget: bullet }).range(node.from, isTask ? node.to + 1 : node.to));
          else decos.push(Decoration.mark({ class: "cm-md-olmark" }).range(node.from, node.to));
          return;
        }
        case "TaskMarker": {
          if (touches(state, doc.lineAt(node.from).from, node.to)) return;
          const done = /x/i.test(doc.sliceString(node.from, node.to));
          decos.push(Decoration.replace({ widget: new Checkbox(done) }).range(node.from, node.to));
          const end = doc.lineAt(node.from).to;
          if (done && node.to + 1 < end) decos.push(Decoration.mark({ class: "cm-md-done" }).range(node.to + 1, end));
          return;
        }
        case "HorizontalRule":
          if (touches(state, node.from, node.to)) return;
          decos.push(Decoration.line({ class: "cm-md-hr" }).range(doc.lineAt(node.from).from));
          decos.push(Decoration.replace({}).range(node.from, node.to));
          return;
        case "Link": {
          // [text](url): show only the text, as a link. Chat links are drawn by the wikilinks extension.
          const url = node.node.getChild("URL");
          if (!url) return; // [x] with no address (e.g. inside [[page]])
          const href = doc.sliceString(url.from, url.to);
          if (href.startsWith("chat:")) return false;
          const marks = node.node.getChildren("LinkMark");
          if (marks.length < 2) return;
          const textFrom = marks[0].to;
          const textTo = marks[1].from;
          if (textTo <= textFrom) return;
          const attributes = { "data-href": href, title: href };
          if (touches(state, node.from, node.to)) {
            decos.push(Decoration.mark({ class: "cm-md-link cm-md-link-raw", attributes }).range(textFrom, textTo));
            return false;
          }
          decos.push(Decoration.replace({}).range(node.from, textFrom));
          decos.push(Decoration.mark({ class: "cm-md-link", attributes }).range(textFrom, textTo));
          decos.push(Decoration.replace({}).range(textTo, node.to));
          return false;
        }
        case "Image": {
          const url = node.node.getChild("URL");
          if (!url || touches(state, node.from, node.to)) return false;
          const src = doc.sliceString(url.from, url.to);
          const marks = node.node.getChildren("LinkMark");
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
          if (/^https?:/i.test(src)) decos.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to));
          return false;
        }
        case "URL": // a bare https://… (GFM autolink) or <https://…>
        case "Autolink": {
          if (node.node.parent?.name === "Link" || node.node.parent?.name === "Image") return;
          const href = doc.sliceString(node.from, node.to).replace(/^<|>$/g, "");
          if (!SAFE_URL.test(href)) return false;
          decos.push(Decoration.mark({ class: `cm-md-link${touches(state, node.from, node.to) ? " cm-md-link-raw" : ""}`, attributes: { "data-href": href, title: href } }).range(node.from, node.to));
          return false;
        }
      }
    },
  });
}

/** $x$ and \(x\) drawn as formulas, except the one the cursor is in. Skips code blocks and display blocks (drawn above). */
function inlineMath(state: EditorState, decos: Range<Decoration>[]) {
  const doc = state.doc;
  let fence = false;
  let display: RegExp | null = null;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (FENCE.test(text)) fence = !fence;
    if (fence || FENCE.test(text)) continue;
    if (display) {
      if (display.test(text)) display = null;
      continue;
    }
    const open = DISPLAY_OPEN.exec(text);
    if (open) {
      display = displayClose(open[1]);
      continue;
    }
    if (DISPLAY_LINE.test(text)) continue;
    const from = doc.line(n).from;
    for (const m of findInlineMath(text)) {
      if (touches(state, from + m.from, from + m.to)) continue; // editing this formula: show its LaTeX
      decos.push(Decoration.replace({ widget: new MathWidget(m.tex, false) }).range(from + m.from, from + m.to));
    }
  }
}

/** A formula, drawn by KaTeX. Bad TeX shows in red instead of failing. Clicking it puts the cursor in its source. */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-md-math cm-md-math-display" : "cm-md-math";
    el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** A task's checkbox. Clicking it flips [ ] <-> [x] in the text. */
class Checkbox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: Checkbox) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-md-checkbox";
    box.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep the cursor where it is
      const at = view.posAtDOM(box); // the start of "[ ]"
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.checked ? " " : "x" }, userEvent: "input.toggle-task" });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-md-image";
    img.loading = "lazy";
    return img;
  }
  ignoreEvent() {
    return false; // a click puts the cursor there, showing the Markdown
  }
}

/** Web links open in a new tab: a plain click off the cursor's line, ⌘/Ctrl-click anywhere. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(e) {
    const el = (e.target as HTMLElement).closest?.<HTMLElement>(".cm-md-link");
    if (!el || e.button !== 0) return false;
    if (el.classList.contains("cm-md-link-raw") && !(e.metaKey || e.ctrlKey)) return false; // editing: place the cursor
    const href = el.dataset.href ?? "";
    if (!SAFE_URL.test(href)) return false;
    e.preventDefault();
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  },
});

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

/** Inline Markdown in a table cell -> safe HTML (text is escaped first; math is drawn by KaTeX). */
export function inlineHtml(md: string): string {
  const maths = findInlineMath(md);
  if (!maths.length) return formatCell(md);
  let html = "";
  let at = 0;
  for (const m of maths) {
    html += formatCell(md.slice(at, m.from)) + katex.renderToString(m.tex, { throwOnError: false });
    at = m.to;
  }
  return html + formatCell(md.slice(at));
}

/** Bold, italics, code, strikethrough and [[links]] in a cell's text, escaped. */
function formatCell(md: string): string {
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
  ".cm-scroller": { fontFamily: "var(--font-inter), system-ui, sans-serif", lineHeight: "1.65", overflow: "visible" },
  ".cm-content": { padding: "0 0 40vh", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
  // The [[ suggestions, in the app's colors (CodeMirror's default is white and blue).
  ".cm-tooltip": { backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "8px", boxShadow: "0 8px 24px rgb(0 0 0 / 0.12)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-inter), system-ui, sans-serif", fontSize: "14px", maxHeight: "16em", padding: "4px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "4px 8px !important", borderRadius: "5px", lineHeight: "1.5" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--hover)", color: "var(--fg)" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "0.75em", fontSize: "12px" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "650" },
  ".cm-completionIcon": { display: "none" },
  // A blank line between blocks is a gap the size of a rendered page's paragraph spacing.
  ".cm-md-gap": { lineHeight: "0.75em" },
  ".cm-md-li-next": { paddingTop: "0.25em !important" },
  ".cm-md-after-toggle": { paddingTop: "0.75em !important" },
  // Room above a heading: 1.25 heading-heights in all, counting the gap line before it.
  ".cm-md-h": { fontWeight: "650", lineHeight: "1.35" },
  ".cm-md-h1": { fontSize: "1.85em", paddingTop: "0.84em !important" },
  ".cm-md-h2": { fontSize: "1.45em", paddingTop: "0.73em !important" },
  ".cm-md-h3": { fontSize: "1.2em", paddingTop: "0.63em !important" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontSize: "1.05em", paddingTop: "0.5em !important" },
  ".cm-md-first": { paddingTop: "0 !important" },
  ".cm-md-bullet": { color: "var(--muted)", display: "inline-block", width: "0.6em" },
  ".cm-md-olmark": { color: "var(--muted)" },
  ".cm-md-code": { backgroundColor: "var(--hover)", borderRadius: "4px", padding: "0.1em 0.35em", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.875em" },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer" },
  ".cm-md-link *": { color: "inherit" }, // the highlighter colors URLs gray
  ".cm-md-link-raw": { cursor: "text" },
  ".cm-md-hr": { position: "relative" },
  ".cm-md-hr::after": { content: '""', position: "absolute", left: "0", right: "0", top: "50%", borderTop: "1px solid var(--line)" },
  ".cm-md-checkbox": { margin: "0 0.45em 0 0.1em", verticalAlign: "-0.1em", cursor: "pointer", accentColor: "var(--accent)" },
  ".cm-md-done": { color: "var(--muted)", textDecoration: "line-through" },
  ".cm-md-image": { display: "block", maxWidth: "100%", borderRadius: "6px", margin: "0.25em 0" },
  ".cm-md-table": { overflowX: "auto", cursor: "text" },
  ".cm-md-table table": { borderCollapse: "collapse", fontSize: "0.92em", lineHeight: "1.5" },
  ".cm-md-table th, .cm-md-table td": { border: "1px solid var(--line)", padding: "0.35em 0.7em", verticalAlign: "top", textAlign: "left" },
  ".cm-md-table th": { fontWeight: "650", backgroundColor: "var(--hover)" },
  ".cm-md-table code": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.9em" },
  // Code block: one box, like a rendered <pre>.
  ".cm-md-fence": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.875em", backgroundColor: "var(--hover)", padding: "0 1em !important" },
  ".cm-md-fence-open": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px" },
  ".cm-md-fence-close": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px" },
  ".cm-md-fence-edge": { lineHeight: "0.9em" }, // the hidden ``` lines become the box's padding
  ".cm-accent": { fontFamily: '"STIX Two Text", "Cambria Math", KaTeX_Main, serif' },
  ".cm-md-math": { cursor: "text" },
  ".cm-md-math-display": { padding: "0.25em 0", overflowX: "auto", overflowY: "hidden" },
  ".cm-md-math-src": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.875em" },
});

export function liveMarkdown(getLinkHost?: () => LinkHost, placeholderText = "Start writing…"): Extension[] {
  return [
    ...(getLinkHost ? wikilinks(getLinkHost) : []), // [[links]] between notes
    ...(getLinkHost ? annotations(getLinkHost) : []), // ==notes on text==[^1]
    // GFM, minus blockquotes. Enter still continues lists.
    markdown({ base: markdownLanguage, extensions: { remove: ["Blockquote"] } }),
    syntaxHighlighting(highlight),
    livePreview,
    linkClicks,
    toggles(), // collapsible <details> blocks; also owns Tab / Shift+Tab
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    placeholder(placeholderText),
    theme,
  ];
}
