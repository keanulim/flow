import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { type EditorState, type Extension, Prec, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

/**
 * Links between notes, Obsidian style: `[[Page name]]` or `[[Page name|shown text]]`.
 *
 *  - Links render as clickable text (brackets hidden) unless the cursor is on
 *    that line, where the raw `[[...]]` shows so it can be edited.
 *  - Click a link to open the page (⌘/Ctrl-click always opens, even while editing).
 *    A link to a page that doesn't exist yet is dashed; opening it creates it.
 *  - Select text and press ⌘K: pick what it links to (a note, a chat, a web
 *    address), or make a new page of that name, created and opened (like
 *    branching a chat from a highlight). The text stays as the link's label.
 *  - Typing `[[` suggests existing notes, and chats.
 *
 * Links to chats are ordinary Markdown links with a chat: address,
 * `[Chat title](chat:<thread id>)`, so they survive the chat being renamed and
 * can point at a branch. They look like page links, with an overline instead
 * of an underline. Picking a chat in the `[[` suggestions inserts one.
 *
 * Images, Obsidian style: `![[photo.png]]` (or `![[photo.png|300]]` for a
 * width) shows the image from the vault. Pasting or dropping an image into a
 * note saves it in the vault, next to the note, and inserts that embed.
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
  /** Where to load an embedded image from, or null if no such file. */
  imageUrl: (target: string) => string | null;
  /** Save a pasted or dropped image in the vault; resolves with what to embed (its name), or null if it failed. */
  saveImage: (file: File) => Promise<string | null>;
  /** ⌘K on selected text: let the user pick what to link it to (the editor shows a picker). Without it, ⌘K links a page of that name. */
  pickLink?: (from: number, to: number) => void;
};

export const CHAT_PREFIX = "chat:";
const CHAT_LINK = /\[([^[\]\n]+)\]\(chat:([\w-]+)\)/g;

/** `[title](chat:id)`, with brackets in the title swapped for parentheses so the link stays intact. */
export const chatLink = (title: string, id: string) => `[${title.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim() || "Chat"}](${CHAT_PREFIX}${id})`;

const LINK = /(?<!!)\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g; // not ![[embeds]]
const EMBED = /!\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g;
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
/** `![[target|width]]`; width in pixels when the part after | is a number (Obsidian's syntax). */
type FoundEmbed = { from: number; to: number; target: string; width: number | null };

/** Page links, chat links and embeds, outside code fences. */
function scan(state: EditorState): { pages: Found[]; chats: FoundChat[]; embeds: FoundEmbed[] } {
  const pages: Found[] = [];
  const chats: FoundChat[] = [];
  const embeds: FoundEmbed[] = [];
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
    for (const m of line.text.matchAll(EMBED)) {
      const from = line.from + m.index!;
      const width = /^\s*\d+\s*$/.test(m[2] ?? "") ? Number(m[2]) : null;
      embeds.push({ from, to: from + m[0].length, target: m[1].trim(), width });
    }
  }
  return { pages, chats, embeds };
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
    const { pages, chats, embeds } = scan(view.state);
    for (const e of embeds) {
      const widget = new EmbedWidget(e.target, host.imageUrl(e.target), e.width);
      // On the cursor's line the source shows too (to edit it), with the image below it.
      if (active.has(view.state.doc.lineAt(e.from).number)) {
        decos.push(Decoration.mark({ class: "cm-embed-raw" }).range(e.from, e.to));
        decos.push(Decoration.widget({ widget, side: 1 }).range(e.to));
      } else decos.push(Decoration.replace({ widget }).range(e.from, e.to));
    }
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

  /**
   * Save image files and insert an embed for each near `pos` (where they were
   * pasted or dropped), each on its own line. A position inside an existing
   * link or embed (dropping onto an image) moves to its end, so it isn't split.
   */
  const insertImages = (view: EditorView, files: File[], pos: number) => {
    void Promise.all(files.map((f) => getHost().saveImage(f))).then((names) => {
      const embeds = names.filter((n): n is string => !!n).map((n) => `![[${n}]]`);
      if (!embeds.length) return;
      const { state } = view;
      let at = Math.min(pos, state.doc.length);
      const { pages, chats, embeds: existing } = scan(state);
      const inside = [...pages, ...chats, ...existing].find((r) => at > r.from && at < r.to);
      if (inside) at = inside.to;
      const line = state.doc.lineAt(at);
      const before = at > line.from ? "\n" : "";
      const after = at < line.to ? "\n" : "";
      const insert = before + embeds.join("\n") + after;
      view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length - after.length }, userEvent: "input.paste" });
    });
  };
  const imagesIn = (list: FileList | undefined | null) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

  const files = EditorView.domEventHandlers({
    paste(e, view) {
      const images = imagesIn(e.clipboardData?.files);
      if (!images.length) return false; // ordinary text: CodeMirror pastes it
      e.preventDefault();
      // A screenshot comes as "image.png"; name it like Obsidian does.
      const d = new Date(); // local time, YYYYMMDDHHmmss
      const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
      const named = images.map((f, i) => new File([f], `Pasted image ${stamp}${images.length > 1 ? `-${i + 1}` : ""}.${extensionFor(f.type)}`, { type: f.type }));
      const sel = view.state.selection.main;
      if (!sel.empty) view.dispatch({ changes: { from: sel.from, to: sel.to }, selection: { anchor: sel.from } }); // pasting over a selection replaces it
      insertImages(view, named, view.state.selection.main.head);
      return true;
    },
    drop(e, view) {
      const images = imagesIn(e.dataTransfer?.files);
      if (!images.length) return false;
      e.preventDefault();
      insertImages(view, images, view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head);
      return true;
    },
  });

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
      const pick = getHost().pickLink;
      if (pick) {
        pick(sel.from, sel.to);
        return true;
      }
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
    ".cm-embed": { display: "block", margin: "0.25em 0", lineHeight: "0" },
    ".cm-embed img": { maxWidth: "100%", borderRadius: "6px", cursor: "text" },
    ".cm-embed-missing": { display: "inline-block", lineHeight: "1.5", fontSize: "0.85em", color: "var(--muted)", border: "1px dashed var(--line-strong)", borderRadius: "6px", padding: "0.15em 0.6em" },
    ".cm-embed-raw, .cm-embed-raw *": { color: "var(--muted)" }, // the highlighter would color it as a link
    ".cm-chatlink-missing": { backgroundColor: "transparent", borderTop: `1.5px dashed ${red(70)}`, borderRadius: "0", cursor: "default" },
  });

  return [plugin, clicks, files, Prec.high(keymap.of([{ key: "Mod-k", run: linkCommand }])), autocompletion({ override: [complete], activateOnTyping: true }), theme];
}

const extensionFor = (type: string) => ({ "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp" })[type] ?? "png";

/** An embedded image, or a note saying it can't be found. Clicking it puts the cursor on its line (showing the source). */
class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly src: string | null,
    readonly width: number | null,
  ) {
    super();
  }
  eq(other: EmbedWidget) {
    return other.target === this.target && other.src === this.src && other.width === this.width;
  }
  toDOM() {
    if (!this.src) {
      const missing = document.createElement("span");
      missing.className = "cm-embed-missing";
      missing.textContent = `Image not found: ${this.target}`;
      return missing;
    }
    const wrap = document.createElement("span");
    wrap.className = "cm-embed";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.target;
    if (this.width) img.style.width = `${this.width}px`;
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

/** The Markdown for `label` linked to a picked target, keeping the label as the visible text. */
export function linkMarkdown(label: string, to: { kind: "note"; target: string } | { kind: "chat"; id: string } | { kind: "url"; url: string }): string {
  if (to.kind === "chat") return chatLink(label, to.id);
  if (to.kind === "url") {
    const text = label.replace(/\[/g, "(").replace(/\]/g, ")");
    // A ")" would end the link early, and encodeURIComponent leaves parentheses alone: encode them by hand.
    const url = to.url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `[${text}](${url})`;
  }
  const text = label.replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim();
  return text.toLowerCase() === to.target.toLowerCase() || !text ? `[[${to.target}]]` : `[[${to.target}|${text}]]`;
}
