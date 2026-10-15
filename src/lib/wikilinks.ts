import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { type EditorState, type Extension, Prec, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Links between notes, Obsidian style: `[[Page name]]` or `[[Page name|shown text]]`.
 *
 *  - Links render as clickable text (brackets hidden) unless the cursor is on
 *    that line, where the raw `[[...]]` shows so it can be edited.
 *  - Click a link to open the page (⌘/Ctrl-click always opens, even while editing).
 *    A link to a page that doesn't exist yet is dashed; opening it creates it.
 *  - Select text and press ⌘K: the text becomes a link to a page of that name,
 *    which is created and opened (like branching a chat from a highlight).
 *  - Typing `[[` suggests existing notes, and chats.
 *
 * Links to chats are ordinary Markdown links with a chat: address,
 * `[Chat title](chat:<thread id>)`, so they survive the chat being renamed and
 * can point at a branch. They look like page links, with an overline instead
 * of an underline. Picking a chat in the `[[` suggestions inserts one.
 *
 * The editor doesn't know about files: the app supplies a LinkHost.
 */

export type LinkHost = {
  exists: (target: string) => boolean;
  open: (target: string) => void; // open the page, creating it if needed
  notes: () => { name: string; folder: string }[];
  chats: () => { id: string; title: string; detail: string }[]; // for the [[ suggestions
  chatExists: (id: string) => boolean;
  openChat: (id: string) => void;
};

export const CHAT_PREFIX = "chat:";
const CHAT_LINK = /\[([^[\]\n]+)\]\(chat:([\w-]+)\)/g;

/** `[title](chat:id)`, with brackets in the title swapped for parentheses so the link stays intact. */
export const chatLink = (title: string, id: string) => `[${title.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim() || "Chat"}](${CHAT_PREFIX}${id})`;

const LINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
const FENCE = /^\s*(```|~~~)/;

/** Sent when the app's file list changes, so link styling (exists / new) refreshes. */
export const refreshLinks = StateEffect.define<null>();

/** "Page#Heading" -> "Page". */
export const linkTarget = (raw: string) => raw.split("#")[0].trim();

/** A selection turned into a page name: no characters that are awkward in file names or links. */
export function pageName(text: string): string {
  return text
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

type Found = { from: number; to: number; target: string; labelFrom: number; labelTo: number };

/** Every link in the document (outside code fences). */
export function findLinks(state: EditorState): Found[] {
  return scan(state).pages;
}

type FoundChat = { from: number; to: number; id: string; labelFrom: number; labelTo: number };

/** Page links and chat links, outside code fences. */
function scan(state: EditorState): { pages: Found[]; chats: FoundChat[] } {
  const pages: Found[] = [];
  const chats: FoundChat[] = [];
  let inFence = false;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (FENCE.test(line.text)) inFence = !inFence;
    if (inFence || FENCE.test(line.text)) continue;
    for (const m of line.text.matchAll(LINK)) {
      const from = line.from + m.index!;
      const to = from + m[0].length;
      const labelFrom = m[2] !== undefined ? from + 2 + m[1].length + 1 : from + 2;
      pages.push({ from, to, target: linkTarget(m[1]), labelFrom, labelTo: to - 2 });
    }
    for (const m of line.text.matchAll(CHAT_LINK)) {
      const from = line.from + m.index!;
      chats.push({ from, to: from + m[0].length, id: m[2], labelFrom: from + 1, labelTo: from + 1 + m[1].length });
    }
  }
  return { pages, chats };
}

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  }
  return lines;
}

export function wikilinks(getHost: () => LinkHost): Extension[] {
  const decorate = (view: EditorView): DecorationSet => {
    const host = getHost();
    const active = activeLines(view.state);
    const decos: Range<Decoration>[] = [];
    const { pages, chats } = scan(view.state);
    for (const c of chats) {
      const cls = `cm-chatlink${host.chatExists(c.id) ? "" : " cm-chatlink-missing"}`;
      const attributes = { "data-chat": c.id, title: host.chatExists(c.id) ? "Open chat" : "This chat no longer exists" };
      if (active.has(view.state.doc.lineAt(c.from).number)) {
        decos.push(Decoration.mark({ class: `${cls} cm-wikilink-raw`, attributes }).range(c.from, c.to));
      } else {
        decos.push(Decoration.replace({}).range(c.from, c.labelFrom));
        decos.push(Decoration.mark({ class: cls, attributes }).range(c.labelFrom, c.labelTo));
        decos.push(Decoration.replace({}).range(c.labelTo, c.to));
      }
    }
    for (const l of pages) {
      const cls = `cm-wikilink${host.exists(l.target) ? "" : " cm-wikilink-new"}`;
      const attributes = { "data-link": l.target };
      if (active.has(view.state.doc.lineAt(l.from).number)) {
        decos.push(Decoration.mark({ class: `${cls} cm-wikilink-raw`, attributes }).range(l.from, l.to));
      } else {
        decos.push(Decoration.replace({}).range(l.from, l.labelFrom));
        decos.push(Decoration.mark({ class: cls, attributes }).range(l.labelFrom, l.labelTo));
        decos.push(Decoration.replace({}).range(l.labelTo, l.to));
      }
    }
    return Decoration.set(decos, true);
  };

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(refreshLinks)))) {
          this.decorations = decorate(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>(".cm-wikilink, .cm-chatlink");
      if (!el || e.button !== 0) return false;
      const editing = el.classList.contains("cm-wikilink-raw"); // cursor is on this line
      if (editing && !(e.metaKey || e.ctrlKey)) return false; // plain click while editing: place the cursor
      e.preventDefault();
      if (el.dataset.chat) getHost().openChat(el.dataset.chat);
      else getHost().open(el.dataset.link!);
      return true;
    },
  });

  /** ⌘K: link the selection to a page (creating it), open the link under the cursor, or start a new link. */
  const linkCommand = (view: EditorView): boolean => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) {
      const text = state.sliceDoc(sel.from, sel.to);
      if (text.includes("\n")) return true; // one line only
      const name = pageName(text);
      if (!name) return true;
      const insert = name === text.trim() ? `[[${name}]]` : `[[${name}|${text}]]`;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: "input.link" });
      getHost().open(name);
      return true;
    }
    const { pages, chats } = scan(state);
    const here = pages.find((l) => sel.head >= l.from && sel.head <= l.to);
    if (here) {
      getHost().open(here.target);
      return true;
    }
    const chat = chats.find((l) => sel.head >= l.from && sel.head <= l.to);
    if (chat) {
      getHost().openChat(chat.id);
      return true;
    }
    view.dispatch({ changes: { from: sel.head, insert: "[[]]" }, selection: { anchor: sel.head + 2 }, userEvent: "input.link" });
    return true;
  };

  /** After `[[`: suggest existing notes, then chats. Picking one completes the link. */
  const complete = (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\[\[[^[\]\n|]*/);
    if (!before) return null;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const host = getHost();
    return {
      from: before.from + 2,
      validFor: /^[^[\]\n|]*$/,
      options: [
        ...host.notes().map(({ name, folder }) => ({ label: name, detail: folder || undefined, apply: after === "]]" ? name : `${name}]]` })),
        ...host.chats().map(({ id, title, detail }) => ({
          label: title,
          detail,
          type: "chat",
          boost: -1, // notes first when both match
          // Replace the whole [[...]] with a chat link.
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
            const insert = chatLink(title, id);
            view.dispatch({ changes: { from: from - 2, to: end, insert }, selection: { anchor: from - 2 + insert.length }, userEvent: "input.complete" });
          },
        })),
      ],
    };
  };

  // Same look as a branch highlight in chats (globals.css .md mark.anchor):
  // tinted fill + solid underline; a page not created yet is dashed with no fill,
  // like an unsaved side question.
  const tint = (pct: number) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;
  const red = (pct: number) => `color-mix(in srgb, var(--chat-link) ${pct}%, transparent)`; // chat links
  const theme = EditorView.theme({
    ".cm-wikilink": { color: "inherit", backgroundColor: tint(14), borderBottom: `1.5px solid ${tint(55)}`, borderRadius: "2px", cursor: "pointer", transition: "background 120ms" },
    ".cm-wikilink *": { color: "inherit" }, // the Markdown highlighter colors [[...]] as a link
    ".cm-wikilink:hover": { backgroundColor: tint(24) },
    ".cm-wikilink-new": { backgroundColor: "transparent", borderBottom: `1.5px dashed ${tint(70)}`, borderRadius: "0" },
    ".cm-wikilink-new:hover": { backgroundColor: tint(10) },
    ".cm-wikilink-raw": { cursor: "text" },
    // Chat links: the same highlight in light red with an overline (a border on top) instead of an underline.
    ".cm-chatlink": { color: "inherit", backgroundColor: red(14), borderTop: `1.5px solid ${red(55)}`, borderRadius: "2px", cursor: "pointer", transition: "background 120ms" },
    ".cm-chatlink *": { color: "inherit" },
    ".cm-chatlink:hover": { backgroundColor: red(24) },
    ".cm-chatlink-missing": { backgroundColor: "transparent", borderTop: `1.5px dashed ${red(70)}`, borderRadius: "0", cursor: "default" },
  });

  return [plugin, clicks, Prec.high(keymap.of([{ key: "Mod-k", run: linkCommand }])), autocompletion({ override: [complete], activateOnTyping: true }), theme];
}
