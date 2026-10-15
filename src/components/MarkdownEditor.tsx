"use client";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { liveMarkdown } from "@/lib/live-markdown";
import { withTrailingLine } from "@/lib/toggles";
import { type LinkHost, pageName, refreshLinks } from "@/lib/wikilinks";
import ContextMenu from "./ContextMenu";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export type MarkdownEditorHandle = { focus: () => void };

type Props = {
  /** Text when the editor is created. The editor owns the text after that (remount with a `key` to load another note). */
  initial: string;
  onChange: (text: string) => void;
  onBlur: () => void;
  /** How [[links]] resolve and open. */
  links: LinkHost;
  /** Changes when the set of notes changes (re-styles links as existing / new). */
  linksVersion: unknown;
  /** Read-only, showing this text as it changes (a note being written). Fixed per mount. */
  live?: string;
  ref?: React.Ref<MarkdownEditorHandle>;
};

/** CodeMirror with Obsidian-style live Markdown (see lib/live-markdown.ts). */
export default function MarkdownEditor({ initial, onChange, onBlur, links, linksVersion, live, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onBlur, links });
  callbacks.current = { onChange, onBlur, links };
  // Right-click on selected text (one line): a menu with "Link to page".
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: withTrailingLine(initial),
        extensions: [
          liveMarkdown(() => callbacks.current.links),
          ...(live !== undefined ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => callbacks.current.onBlur(),
            contextmenu: (e, view) => {
              if (live !== undefined) return false;
              const sel = view.state.selection.main;
              const text = view.state.sliceDoc(sel.from, sel.to);
              const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
              // Only on the selected text itself; anywhere else, the browser's own menu.
              if (sel.empty || text.includes("\n") || !pageName(text) || at === null || at < sel.from || at > sel.to) return false;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Created once per mount on purpose; `initial` only seeds the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live: replace only the part that changed, so the view doesn't jump.
  useEffect(() => {
    const v = view.current;
    if (!v || live === undefined) return;
    const old = v.state.doc.toString();
    const next = withTrailingLine(live);
    if (old === next) return;
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let end = 0;
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
    // filter: false skips the toggle editing guards (they'd block changes to hidden tags) and housekeeping.
    v.dispatch({ changes: { from: start, to: old.length - end, insert: next.slice(start, next.length - end) }, filter: false });
  }, [live]);

  // The note list changed: re-style links (existing vs. not created yet).
  useEffect(() => {
    view.current?.dispatch({ effects: refreshLinks.of(null) });
  }, [linksVersion]);

  const closeMenu = useCallback(() => setMenu(null), []);

  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);

  const linkSelection = () => {
    const v = view.current;
    if (!v) return;
    v.focus(); // clicking the menu took focus; the selection is still there
    // Same as pressing ⌘K in the editor.
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
  };

  return (
    <>
      <div ref={host} className="h-full" />
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} items={[{ label: "Link to page", run: linkSelection }]} />}
    </>
  );
}
