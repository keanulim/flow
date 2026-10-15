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
 * The file stays plain Markdown; only how it's *shown* changes. Markup hides
 * off the cursor's line and comes back on it, so it can still be edited:
 *  - `#`..`######` headings render as headings.
 *  - Bold, italic, `code` and ~~strikethrough~~ are styled; `-` bullets show as •.
 *  - [Web links](https://…) and bare URLs are clickable; images show.
 *  - Tables render as tables until the cursor moves into one.
 *  - Code fences become a box; `---` becomes a rule; `- [ ]` tasks get a checkbox.
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

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;

    if (inFence || FENCE.test(text)) {
      const opening = !inFence;
      if (FENCE.test(text)) inFence = !inFence;
      const edge = FENCE.test(text) ? (opening ? " cm-md-fence-open" : " cm-md-fence-close") : "";
      // Off the cursor, the ``` lines are just the box's top and bottom padding.
      const hideMarker = edge && !active.has(n);
      decos.push(Decoration.line({ class: `cm-md-fence${edge}${hideMarker ? " cm-md-fence-edge" : ""}` }).range(line.from));
      if (hideMarker && line.length) decos.push(Decoration.replace({}).range(line.from, line.to));
      continue;
    }

    if (!text.trim()) {
      decos.push(Decoration.line({ class: "cm-md-gap" }).range(line.from)); // a blank line between blocks: a short gap
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
        case "StrikethroughMark":
          if (!active.has(lineOf(node.from))) decos.push(Decoration.replace({}).range(node.from, node.to));
          return;
        case "Escape": // \* -> *
          if (!active.has(lineOf(node.from))) decos.push(Decoration.replace({}).range(node.from, node.from + 1));
          return;
        case "InlineCode":
          decos.push(Decoration.mark({ class: "cm-md-code" }).range(node.from, node.to));
          return; // its CodeMarks are hidden by the case above
        case "ListMark": {
          const mark = doc.sliceString(node.from, node.to);
          if (active.has(lineOf(node.from))) return;
          const isTask = !!node.node.parent?.getChild("Task"); // "- [ ] x": the checkbox replaces the bullet
          if (/^[-*+]$/.test(mark)) decos.push(Decoration.replace(isTask ? {} : { widget: bullet }).range(node.from, isTask ? node.to + 1 : node.to));
          else decos.push(Decoration.mark({ class: "cm-md-olmark" }).range(node.from, node.to));
          return;
        }
        case "TaskMarker": {
          if (active.has(lineOf(node.from))) return;
          const done = /x/i.test(doc.sliceString(node.from, node.to));
          decos.push(Decoration.replace({ widget: new Checkbox(done) }).range(node.from, node.to));
          const end = doc.lineAt(node.from).to;
          if (done && node.to + 1 < end) decos.push(Decoration.mark({ class: "cm-md-done" }).range(node.to + 1, end));
          return;
        }
        case "HorizontalRule":
          if (active.has(lineOf(node.from))) return;
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
          if (active.has(lineOf(node.from))) {
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
          if (!url || active.has(lineOf(node.from))) return false;
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
          decos.push(Decoration.mark({ class: `cm-md-link${active.has(lineOf(node.from)) ? " cm-md-link-raw" : ""}`, attributes: { "data-href": href, title: href } }).range(node.from, node.to));
          return false;
        }
      }
    },
  });
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
  ".cm-scroller": { fontFamily: "var(--font-inter), system-ui, sans-serif", lineHeight: "1.65", overflow: "visible" },
  ".cm-content": { padding: "0 0 40vh", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
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
});

export function liveMarkdown(getLinkHost?: () => LinkHost, placeholderText = "Start writing…"): Extension[] {
  return [
    ...(getLinkHost ? wikilinks(getLinkHost) : []), // [[links]] between notes
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
