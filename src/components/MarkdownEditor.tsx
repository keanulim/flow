"use client";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { liveMarkdown } from "@/lib/live-markdown";
import { withTrailingLine } from "@/lib/toggles";
import { type LinkHost, linkMarkdown, pageName, refreshLinks } from "@/lib/wikilinks";
import ContextMenu from "./ContextMenu";
import LinkPicker, { type LinkChoice } from "./LinkPicker";
import AnnotationPopup from "./AnnotationPopup";
import { addAnnotation, parseAnnotations, removeAnnotation, type TextChange, updateAnnotation } from "@/lib/annotations";

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
  // Right-click on selected text (one line): a menu with "Link to…" and "Add note…".
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Linking the selection (⌘K or that menu): the picker, under the selected text.
  const [picker, setPicker] = useState<{ x: number; y: number; from: number; to: number; text: string } | null>(null);
  // A note on text: writing a new one for the selection, or one that was clicked.
  const [annot, setAnnot] = useState<
    { mode: "new"; x: number; y: number; from: number; to: number } | { mode: "view"; x: number; y: number; id: string } | null
  >(null);
  const openAnnotation = useCallback((id: string, rect: DOMRect) => setAnnot({ mode: "view", x: rect.left, y: rect.bottom + 6, id }), []);
  const openPicker = useCallback((from: number, to: number) => {
    const v = view.current;
    const at = v?.coordsAtPos(from);
    if (!v || !at) return;
    setPicker({ x: at.left, y: at.bottom + 6, from, to, text: v.state.sliceDoc(from, to) });
  }, []);

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: withTrailingLine(initial),
        extensions: [
          liveMarkdown(() => ({ ...callbacks.current.links, pickLink: (from: number, to: number) => openPicker(from, to), openAnnotation })),
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
    const sel = view.current?.state.selection.main;
    if (sel && !sel.empty) openPicker(sel.from, sel.to);
  };

  /** Right-click → Add note…: a note about the selected words. */
  const noteSelection = () => {
    const v = view.current;
    const sel = v?.state.selection.main;
    const at = sel && v?.coordsAtPos(sel.from);
    if (!v || !sel || sel.empty || !at) return;
    setAnnot({ mode: "new", x: at.left, y: at.bottom + 6, from: sel.from, to: sel.to });
  };

  const applyChanges = (changes: TextChange[] | null) => {
    const v = view.current;
    if (v && changes?.length) v.dispatch({ changes, userEvent: "input.annotate" });
  };

  const closeAnnotation = useCallback(() => {
    setAnnot(null);
    view.current?.focus();
  }, []);

  const closePicker = useCallback(() => {
    setPicker(null);
    view.current?.focus();
  }, []);

  /** Replace the selected text with a link to what was picked; a new page is also created and opened. */
  const applyLink = (choice: LinkChoice) => {
    const v = view.current;
    if (!v || !picker) return;
    const { from, to, text } = picker;
    setPicker(null);
    let insert: string;
    if (choice.kind === "new") {
      const name = pageName(choice.name);
      if (!name) return void v.focus();
      insert = linkMarkdown(text, { kind: "note", target: name });
      v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.link" });
      callbacks.current.links.open(name);
      return;
    }
    insert = linkMarkdown(text, choice);
    v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.link" });
    v.focus();
  };

  return (
    <>
      <div ref={host} className="h-full" />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: "Link to…", run: linkSelection },
            { label: "Add note…", run: noteSelection },
          ]}
        />
      )}
      {annot && view.current && (
        <AnnotationPopup
          // A fresh popup per note, so its text box starts from the right note.
          key={annot.mode === "view" ? annot.id : "new"}
          x={annot.x}
          y={annot.y}
          editing={annot.mode === "new"}
          readOnly={live !== undefined}
          note={annot.mode === "view" ? (parseAnnotations(view.current.state.doc.toString()).defs.get(annot.id)?.text ?? "") : ""}
          onSave={(note) => {
            const doc = view.current!.state.doc.toString();
            applyChanges(annot.mode === "new" ? (addAnnotation(doc, annot.from, annot.to, note)?.changes ?? null) : updateAnnotation(doc, annot.id, note));
            closeAnnotation();
          }}
          onRemove={
            annot.mode === "view"
              ? () => {
                  applyChanges(removeAnnotation(view.current!.state.doc.toString(), annot.id));
                  closeAnnotation();
                }
              : undefined
          }
          onClose={closeAnnotation}
        />
      )}
      {picker && (
        <LinkPicker
          x={picker.x}
          y={picker.y}
          text={picker.text}
          notes={links.notes()}
          chats={links.chats()}
          onPick={applyLink}
          onClose={closePicker}
        />
      )}
    </>
  );
}
