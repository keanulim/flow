import { indentLess, indentMore } from "@codemirror/commands";
import { EditorState, type Extension, Prec, type Range, StateField, Text, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";

/**
 * Toggles (collapsible blocks) stored as HTML <details> blocks, which plain
 * Markdown allows and GitHub, Obsidian's reading view and most renderers fold:
 *
 *     <details open>              (no "open" = closed)
 *     <summary>Title</summary>
 *                                 (blank line, so the body parses as Markdown)
 *     body: ordinary Markdown, no per-line prefixes
 *     </details>
 *                                 (blank line, so what follows parses as Markdown)
 *
 * In the editor the tag lines are hidden and protected from accidental edits;
 * the title shows with an arrow. Behaviour (see the spec in the chat history):
 *   "/>" at the start of a line   turn the line into a toggle (cursor in the title)
 *   Enter on an open title        new first line inside
 *   Enter on a closed title       new line after the toggle
 *   Enter inside                  normal Enter (it's ordinary text)
 *   Backspace at title start      turn the toggle back into plain text
 *   Backspace on an empty last line   move it out: cursor on a new empty line after the toggle
 *   Backspace at first line start join it onto the title
 *   Backspace on the line after   move that line into the end of the toggle (back in)
 *   Tab on the line after         move it into the toggle;  Shift+Tab inside: move it out
 *   Click the arrow               open / close (saved in the file)
 * A toggle at the very end of a note always gets an empty line after it, so
 * there's always somewhere to click or arrow out to.
 */

const OPEN = /^\s*<details(\s+open)?\s*>\s*$/i;
const SUMMARY = /^(\s*<summary>)(.*?)(<\/summary>\s*)$/i;
const CLOSE = /^\s*<\/details>\s*$/i;
const FENCE = /^\s*(```|~~~)/;
const INDENT = 1.55; // em per nesting level
const EVENT = "toggle"; // userEvent prefix for our own edits (allowed past the protection)

export type Toggle = {
  open: boolean;
  depth: number;
  parent: Toggle | null;
  openLine: number;
  summaryLine: number | null;
  spacerLine: number | null;
  closeLine: number | null; // null = never closed (runs to the end of the note)
  trailerLine: number | null; // the blank line after </details>
  titleFrom: number; // doc positions of the title text (the editable part of the summary)
  titleTo: number;
  bodyFirst: number; // line numbers; bodyFirst > bodyLast when empty
  bodyLast: number;
};

type Role = "open" | "summary" | "spacer" | "body" | "close" | "trailer";
export type Parsed = { toggles: Toggle[]; lines: Map<number, { toggle: Toggle; role: Role }> };

/** Find every toggle. Nesting uses a stack; tags inside code fences are ignored. */
export function parseToggles(doc: Text): Parsed {
  const toggles: Toggle[] = [];
  const lines = new Map<number, { toggle: Toggle; role: Role }>();
  const stack: Toggle[] = [];
  let inFence = false;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;
    const top = stack.at(-1);

    if (FENCE.test(text)) inFence = !inFence;
    if (inFence || FENCE.test(text)) {
      if (top) lines.set(n, { toggle: top, role: "body" });
      continue;
    }

    const open = OPEN.exec(text);
    if (open) {
      const t: Toggle = {
        open: !!open[1],
        depth: stack.length,
        parent: top ?? null,
        openLine: n,
        summaryLine: null,
        spacerLine: null,
        closeLine: null,
        trailerLine: null,
        titleFrom: line.to,
        titleTo: line.to,
        bodyFirst: n + 1,
        bodyLast: doc.lines,
      };
      toggles.push(t);
      stack.push(t);
      lines.set(n, { toggle: t, role: "open" });
      continue;
    }

    if (top && top.summaryLine === null && n === top.openLine + 1) {
      const s = SUMMARY.exec(text);
      if (s) {
        top.summaryLine = n;
        top.titleFrom = line.from + s[1].length;
        top.titleTo = top.titleFrom + s[2].length;
        top.bodyFirst = n + 1;
        lines.set(n, { toggle: top, role: "summary" });
        continue;
      }
    }

    if (top && top.summaryLine !== null && top.spacerLine === null && n === top.summaryLine + 1 && !text.trim()) {
      top.spacerLine = n;
      top.bodyFirst = n + 1;
      lines.set(n, { toggle: top, role: "spacer" });
      continue;
    }

    if (top && CLOSE.test(text)) {
      top.closeLine = n;
      top.bodyLast = n - 1;
      stack.pop();
      lines.set(n, { toggle: top, role: "close" });
      if (n < doc.lines && !doc.line(n + 1).text.trim()) {
        top.trailerLine = n + 1;
        lines.set(n + 1, { toggle: top, role: "trailer" });
        n++;
      }
      continue;
    }

    if (top) lines.set(n, { toggle: top, role: "body" });
  }
  return { toggles, lines };
}

/** The arrow shown before a toggle's title. Clicking it opens / closes the toggle. */
class Arrow extends WidgetType {
  constructor(readonly open: boolean) {
    super();
  }
  eq(other: Arrow) {
    return other.open === this.open;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-toggle-arrow";
    el.setAttribute("aria-label", this.open ? "Collapse" : "Expand");
    el.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" style="transform: rotate(${this.open ? 90 : 0}deg)"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep the cursor where it is
      const n = view.state.doc.lineAt(view.posAtDOM(el)).number;
      const hit = view.state.field(field).parsed.lines.get(n);
      if (hit) flip(view, hit.toggle);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** Indent + guide lines for content `level` toggles deep. Also used by blocks drawn in place of toggle lines (tables). */
export function indent(level: number): Record<string, string> {
  if (!level) return {};
  const guides = Array.from({ length: level }, () => "linear-gradient(var(--line), var(--line))").join(",");
  const at = Array.from({ length: level }, (_, i) => `${0.55 + i * INDENT}em 0`).join(",");
  return {
    style: `padding-left:${level * INDENT}em;background-image:${guides};background-size:1px 100%;background-repeat:no-repeat;background-position:${at}`,
  };
}

type Built = { parsed: Parsed; decorations: DecorationSet; atomic: DecorationSet; protect: number[] };

function build(state: EditorState): Built {
  const doc = state.doc;
  const parsed = parseToggles(doc);
  const decos: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const protect: number[] = []; // [from, to, from, to, ...] of hidden markup

  const hidden = new Set<number>(); // line numbers removed from the layout
  const isInsideClosed = (t: Toggle) => {
    for (let p = t.parent; p; p = p.parent) if (!p.open) return true;
    return false;
  };

  for (const t of parsed.toggles) {
    const open = doc.line(t.openLine);
    protect.push(open.from, Math.min(open.to + 1, doc.length));
    hidden.add(t.openLine);
    if (t.spacerLine !== null) {
      const sp = doc.line(t.spacerLine);
      protect.push(sp.from, Math.min(sp.to + 1, doc.length));
      hidden.add(t.spacerLine);
    }
    if (t.closeLine !== null) {
      const close = doc.line(t.closeLine);
      protect.push(Math.max(close.from - 1, 0), close.to);
      hidden.add(t.closeLine);
    }
    if (t.trailerLine !== null) {
      const trailer = doc.line(t.trailerLine);
      protect.push(trailer.from - 1, trailer.to);
      hidden.add(t.trailerLine);
    }
    if (!t.open) for (let n = t.bodyFirst; n <= t.bodyLast; n++) hidden.add(n);
    if (isInsideClosed(t)) continue; // its parent already hides it

    if (t.summaryLine !== null) {
      const s = doc.line(t.summaryLine);
      protect.push(s.from, t.titleFrom, t.titleTo, Math.min(s.to + 1, doc.length));
      decos.push(Decoration.line({ class: "cm-toggle-title", attributes: indent(t.depth) }).range(s.from));
      const prefix = Decoration.replace({ widget: new Arrow(t.open) }).range(s.from, t.titleFrom);
      decos.push(prefix);
      atomic.push(prefix);
      if (t.titleTo < s.to) {
        const suffix = Decoration.replace({}).range(t.titleTo, s.to);
        decos.push(suffix);
        atomic.push(suffix);
      }
    }
  }

  for (const [n, { toggle, role }] of parsed.lines) {
    if (role !== "body" || hidden.has(n) || isInsideClosed(toggle)) continue;
    decos.push(Decoration.line({ class: "cm-toggle-body", attributes: indent(toggle.depth + 1) }).range(doc.line(n).from));
  }

  // Hidden lines, merged into runs (block decorations must not overlap).
  const sorted = [...hidden].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const range = Decoration.replace({ block: true }).range(doc.line(sorted[i]).from, doc.line(sorted[j]).to);
    decos.push(range);
    atomic.push(range);
    i = j + 1;
  }

  // The change filter expects ranges in document order.
  const pairs: [number, number][] = [];
  for (let i = 0; i < protect.length; i += 2) pairs.push([protect[i], protect[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  return { parsed, decorations: Decoration.set(decos, true), atomic: Decoration.set(atomic, true), protect: pairs.flat() };
}

const field = StateField.define<Built>({
  create: build,
  update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
  provide: (f) => [EditorView.decorations.from(f, (v) => v.decorations), EditorView.atomicRanges.of((view) => view.state.field(f).atomic)],
});

const parsedOf = (state: EditorState) => state.field(field).parsed;

// ---------- protection & housekeeping ----------

/** Block edits that would damage hidden tags, unless they're our own or delete whole toggles. */
const protection = EditorState.changeFilter.of((tr: Transaction) => {
  if (tr.isUserEvent(EVENT) || tr.isUserEvent("undo") || tr.isUserEvent("redo")) return true;
  const { protect, parsed } = tr.startState.field(field);
  if (!protect.length) return true;
  // Deleting a selection that covers a whole toggle (e.g. select all) is fine.
  const whole = new Set<Toggle>();
  tr.changes.iterChangedRanges((from, to) => {
    for (const t of parsed.toggles) {
      const start = tr.startState.doc.line(t.openLine).from;
      const end = tr.startState.doc.line(t.trailerLine ?? t.closeLine ?? tr.startState.doc.lines).to;
      if (from <= start && to >= end) whole.add(t);
    }
  });
  if (!whole.size) return protect;
  const keep: number[] = [];
  const startDoc = tr.startState.doc;
  for (let i = 0; i < protect.length; i += 2) {
    const inWhole = [...whole].some((t) => protect[i] >= startDoc.line(t.openLine).from && protect[i + 1] <= startDoc.line(t.trailerLine ?? t.closeLine ?? startDoc.lines).to + 1);
    if (!inWhole) keep.push(protect[i], protect[i + 1]);
  }
  return keep;
});

/**
 * Where blank lines are missing around toggles: after every </details> that's
 * directly followed by content (else Markdown reads that content as raw HTML),
 * and at the end of the note, so there's always a visible line after a toggle.
 */
export function missingBlankLines(doc: Text): number[] {
  const at: number[] = [];
  const { toggles: list, lines } = parseToggles(doc);
  for (const t of list) {
    if (t.closeLine === null || t.trailerLine !== null || t.closeLine === doc.lines) continue;
    if (!CLOSE.test(doc.line(t.closeLine + 1).text)) at.push(doc.line(t.closeLine).to);
  }
  const last = lines.get(doc.lines);
  if (last && (last.role === "close" || last.role === "trailer")) at.push(doc.length);
  if (last?.role === "close") at.push(doc.length); // close needs a trailer *and* a visible line
  return at;
}

/** Keep the cursor inside a title's text (not in the hidden tags around it), and keep blank lines around toggles. */
const housekeeping = EditorState.transactionFilter.of((tr) => {
  const extra: { selection?: { anchor: number }; changes?: { from: number; insert: string }[] } = {};
  const doc = tr.newDoc;

  if (tr.docChanged) {
    const at = missingBlankLines(doc);
    if (at.length) extra.changes = at.map((from) => ({ from, insert: "\n" }));
  }

  const sel = tr.newSelection.main;
  if (sel.empty && (tr.selection || tr.docChanged)) {
    const parsed = parseToggles(doc);
    const hit = parsed.lines.get(doc.lineAt(sel.head).number);
    if (hit?.role === "summary" && (sel.head < hit.toggle.titleFrom || sel.head > hit.toggle.titleTo)) {
      extra.selection = { anchor: Math.min(Math.max(sel.head, hit.toggle.titleFrom), hit.toggle.titleTo) };
    }
  }
  return extra.changes || extra.selection ? [tr, { ...extra, sequential: true }] : tr;
});

// ---------- actions ----------

function lineOf(state: EditorState, pos: number) {
  return state.doc.lineAt(pos).number;
}

/** Open / close a toggle (edits the "open" attribute). Closing moves a cursor that was inside to the title. */
function flip(view: EditorView, t: Toggle) {
  const { state } = view;
  const open = state.doc.line(t.openLine);
  const lead = open.text.match(/^\s*/)![0];
  const insert = `${lead}<details${t.open ? "" : " open"}>`;
  const delta = insert.length - open.length;
  const head = state.selection.main.head;
  const inside = t.open && lineOf(state, head) >= t.bodyFirst && lineOf(state, head) <= (t.closeLine ?? state.doc.lines);
  view.dispatch({
    changes: { from: open.from, to: open.to, insert },
    selection: inside ? { anchor: t.titleTo + delta } : undefined,
    userEvent: `${EVENT}.flip`,
  });
}

/** "/>" at the start of a line turns the line into a toggle, with any existing text as its title. */
const create = EditorView.inputHandler.of((view, from, to, text) => {
  const line = view.state.doc.lineAt(from);
  if (to > line.to) return false;
  const before = line.text.slice(0, from - line.from);
  if (before.length > 1) return false;
  const combined = before + text;
  if (!combined.startsWith("/>")) return false;
  const hit = parsedOf(view.state).lines.get(line.number);
  if (hit && hit.role !== "body") return false;
  const title = combined.slice(2).trimStart() + line.text.slice(to - line.from);
  const head = "<details open>\n<summary>";
  const insert = `${head}${title}</summary>\n\n\n</details>\n`; // last \n = blank line after the toggle
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + head.length + title.length },
    userEvent: `${EVENT}.create`,
  });
  return true;
});

function enter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const n = lineOf(state, sel.head);
  const hit = parsedOf(state).lines.get(n);
  if (hit?.role !== "summary") return false; // inside the body Enter is just Enter
  const t = hit.toggle;
  const cursor = Math.min(Math.max(sel.head, t.titleFrom), t.titleTo);
  const rest = state.doc.sliceString(cursor, t.titleTo);
  const cut = { from: cursor, to: t.titleTo, insert: "" };

  if (t.open && !rest && t.bodyFirst <= t.bodyLast && t.spacerLine !== null) {
    // The first line inside is already empty (e.g. a toggle just made with "/>"): go there.
    const first = state.doc.line(t.bodyFirst);
    const hit = parsedOf(state).lines.get(t.bodyFirst);
    if (hit?.role === "body" && !first.text.trim()) {
      view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true, userEvent: `${EVENT}.enter` });
      return true;
    }
  }

  if (t.open) {
    // New first line inside (adding the blank spacer line if it's missing).
    const summary = state.doc.line(t.summaryLine!);
    const at = t.spacerLine !== null ? state.doc.line(t.spacerLine).to + 1 : summary.to + 1;
    const insert = (t.spacerLine === null ? "\n" : "") + rest + "\n";
    const anchor = at - rest.length + (t.spacerLine === null ? 1 : 0);
    view.dispatch({ changes: [cut, { from: at, insert }], selection: { anchor }, scrollIntoView: true, userEvent: `${EVENT}.enter` });
    return true;
  }

  // Closed: new line right after the toggle (after its blank trailer line).
  const end = state.doc.line(t.trailerLine ?? t.closeLine ?? state.doc.lines).to;
  const lead = t.trailerLine === null && t.closeLine !== null ? "\n\n" : "\n";
  view.dispatch({
    changes: [cut, { from: end, insert: lead + rest }],
    selection: { anchor: end - rest.length + lead.length },
    scrollIntoView: true,
    userEvent: `${EVENT}.enter`,
  });
  return true;
}

/** The last line inside a toggle that's actually visible, or null (empty / closed). */
function lastVisibleBodyLine(state: EditorState, t: Toggle): number | null {
  if (!t.open) return null;
  const { lines } = parsedOf(state);
  for (let n = t.bodyLast; n >= t.bodyFirst; n--) {
    const hit = lines.get(n);
    if (hit?.role === "body" || hit?.role === "summary") return n;
  }
  return null;
}

function backspace(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const { lines } = parsedOf(state);
  const hit = lines.get(line.number);

  // At the start of a title: turn the toggle back into plain text.
  if (hit?.role === "summary" && sel.head <= hit.toggle.titleFrom) {
    const t = hit.toggle;
    const open = state.doc.line(t.openLine);
    const headerEnd = state.doc.line(t.spacerLine ?? t.summaryLine!);
    const changes = [
      { from: open.from, to: t.titleFrom, insert: "" },
      { from: t.titleTo, to: headerEnd.to, insert: "" },
    ];
    if (t.closeLine !== null) {
      const close = state.doc.line(t.closeLine);
      changes.push({ from: close.from - 1, to: close.to, insert: "" }); // the blank line after stays as a normal separator
    }
    view.dispatch({ changes, selection: { anchor: open.from }, userEvent: `${EVENT}.unwrap` });
    return true;
  }

  if (sel.head !== line.from) return false;

  // On an empty last line inside: step out, onto an empty line after the toggle.
  // (A second Backspace there brings you back in: see "the line right after".)
  if (hit?.role === "body" && !line.text.trim() && line.number === hit.toggle.bodyLast && hit.toggle.closeLine !== null) {
    const t = hit.toggle;
    const end = state.doc.line(t.trailerLine ?? t.closeLine!);
    const lead = t.trailerLine === null ? "\n\n" : "\n";
    view.dispatch({
      changes: [
        { from: line.from - 1, to: line.to, insert: "" },
        { from: end.to, insert: lead },
      ],
      selection: { anchor: end.to - (line.length + 1) + lead.length },
      userEvent: `${EVENT}.out`,
    });
    return true;
  }

  // At the start of the first line inside: join it onto the title.
  if (hit?.role === "body" && line.number === hit.toggle.bodyFirst && hit.toggle.summaryLine !== null) {
    const t = hit.toggle;
    view.dispatch({
      changes: [
        { from: t.titleTo, insert: line.text },
        { from: line.from, to: Math.min(line.to + 1, state.doc.length), insert: "" },
      ],
      selection: { anchor: t.titleTo },
      userEvent: `${EVENT}.join`,
    });
    return true;
  }

  // At the start of the line right after a toggle: move it into the toggle's end.
  const prev = line.number > 1 ? lines.get(line.number - 1) : undefined;
  if (prev?.role === "close" || prev?.role === "trailer") {
    const t = prev.toggle;
    const target = lastVisibleBodyLine(state, t);
    const into = target !== null ? state.doc.line(target).to : t.titleTo;
    view.dispatch({
      changes: [
        { from: into, insert: line.text },
        { from: line.from - 1, to: line.to, insert: "" },
      ],
      selection: { anchor: into },
      userEvent: `${EVENT}.join`,
    });
    return true;
  }
  return false;
}

/** Tab on the line right after a toggle: move it into the end of that toggle (opening it). */
function tab(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const prev = line.number > 1 ? parsedOf(state).lines.get(line.number - 1) : undefined;
  if (prev?.role !== "close" && prev?.role !== "trailer") return indentMore(view);
  const t = prev.toggle;
  const close = state.doc.line(t.closeLine!);
  const col = state.selection.main.head - line.from;
  const changes = [
    { from: close.from, insert: line.text + "\n" },
    { from: line.from - 1, to: line.to, insert: "" },
  ];
  if (!t.open) {
    const open = state.doc.line(t.openLine);
    changes.push({ from: open.from, to: open.to, insert: `${open.text.match(/^\s*/)![0]}<details open>` });
  }
  const shift = t.open ? 0 : " open".length;
  view.dispatch({ changes, selection: { anchor: close.from + col + shift }, userEvent: `${EVENT}.indent` });
  return true;
}

/** Shift+Tab on a line inside a toggle: move it out, to just after the toggle. */
function shiftTab(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const hit = parsedOf(state).lines.get(line.number);
  if (hit?.role !== "body") return indentLess(view);
  const t = hit.toggle;
  if (t.closeLine === null) return true;
  const end = state.doc.line(t.trailerLine ?? t.closeLine);
  const lead = t.trailerLine === null ? "\n\n" : "\n";
  const col = state.selection.main.head - line.from;
  view.dispatch({
    changes: [
      { from: line.from, to: Math.min(line.to + 1, state.doc.length), insert: "" },
      { from: end.to, insert: lead + line.text },
    ],
    selection: { anchor: end.to - (line.length + 1) + lead.length + col },
    userEvent: `${EVENT}.outdent`,
  });
  return true;
}

const theme = EditorView.theme({
  ".cm-toggle-title": { fontWeight: "550" },
  ".cm-toggle-arrow": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.2em",
    marginRight: "0.35em",
    color: "var(--muted)",
    cursor: "pointer",
    verticalAlign: "-0.15em",
  },
  ".cm-toggle-arrow:hover": { color: "var(--fg)" },
});

/** For a freshly loaded note: add the blank lines toggles need (see missingBlankLines). */
export function withTrailingLine(text: string): string {
  const at = missingBlankLines(Text.of(text.split("\n")));
  let out = text;
  for (const pos of [...at].sort((a, b) => b - a)) out = out.slice(0, pos) + "\n" + out.slice(pos);
  return out;
}

export function toggles(): Extension[] {
  return [
    field,
    protection,
    housekeeping,
    create,
    Prec.highest(
      keymap.of([
        { key: "Enter", run: enter },
        { key: "Backspace", run: backspace },
        { key: "Tab", run: tab },
        { key: "Shift-Tab", run: shiftTab },
      ]),
    ),
    theme,
  ];
}
