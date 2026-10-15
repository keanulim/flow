"use client";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { liveMarkdown } from "@/lib/live-markdown";
import { withTrailingLine } from "@/lib/toggles";
import { type LinkHost, pageName, refreshLinks } from "@/lib/wikilinks";

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
  ref?: React.Ref<MarkdownEditorHandle>;
};

/** CodeMirror with Obsidian-style live Markdown (see lib/live-markdown.ts). */
export default function MarkdownEditor({ initial, onChange, onBlur, links, linksVersion, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onBlur, links });
  callbacks.current = { onChange, onBlur, links };
  // "Link to page" button over a one-line selection (like "Ask on the side" in chats)
  const [linkButton, setLinkButton] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: withTrailingLine(initial),
        extensions: [
          liveMarkdown(() => callbacks.current.links),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
            if (u.selectionSet || u.docChanged || u.focusChanged) {
              const sel = u.state.selection.main;
              const text = u.state.sliceDoc(sel.from, sel.to);
              const coords = !sel.empty && u.view.hasFocus && !text.includes("\n") && pageName(text) ? u.view.coordsAtPos(sel.from) : null;
              setLinkButton(coords ? { x: coords.left, y: coords.top } : null);
            }
          }),
          EditorView.domEventHandlers({ blur: () => callbacks.current.onBlur() }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Created once per mount on purpose; `initial` only seeds the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The note list changed: re-style links (existing vs. not created yet).
  useEffect(() => {
    view.current?.dispatch({ effects: refreshLinks.of(null) });
  }, [linksVersion]);

  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);

  const linkSelection = () => {
    const v = view.current;
    if (!v) return;
    // Same as pressing ⌘K in the editor.
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
  };

  return (
    <>
      <div ref={host} className="h-full" />
      {linkButton && (
        <button
          onMouseDown={(e) => {
            e.preventDefault(); // keep the selection
            linkSelection();
          }}
          style={{ left: linkButton.x, top: linkButton.y - 36 }}
          className="fixed z-50 rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg shadow-lg"
        >
          Link to page <span className="opacity-60">{isMac ? "⌘" : "Ctrl+"}K</span>
        </button>
      )}
    </>
  );
}
