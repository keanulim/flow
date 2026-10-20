"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { LinkHost } from "@/lib/wikilinks";
import MarkdownEditor, { type MarkdownEditorHandle } from "./MarkdownEditor";

export type NoteEditorHandle = {
  /** Save now if there are unsaved edits. Call before renaming or moving the note. */
  flush: () => Promise<void>;
  /** Drop unsaved edits without saving. Call before deleting the note. */
  discard: () => void;
};

type Props = {
  path: string;
  onError: (e: unknown) => void;
  links: LinkHost;
  linksVersion: unknown;
  /** Set when this note was reached through a link: shows "← back". */
  back?: { label: string; go: () => void };
  /** The note is being written (from a chat): show this text, read-only, as it arrives. Remount when it's done. */
  live?: string;
  /** What to call the live writing in the header ("Writing from chat…", "AI is editing…"). */
  liveLabel?: string;
  /** Saving moved images to the trash or back (the file tree should refresh). */
  onFilesChanged?: () => void;
  ref?: React.Ref<NoteEditorHandle>;
};

const SAVE_DELAY = 600; // ms after the last keystroke

/**
 * Edit one Markdown note. Saves automatically a moment after you stop typing,
 * and immediately when the note is switched away from or about to be moved.
 * There's one view, as in Notion: the editor itself renders the Markdown.
 */
export default function NoteEditor({ path, onError, links, linksVersion, back, live, liveLabel = "Writing…", onFilesChanged, ref }: Props) {
  const [content, setContent] = useState<string | null>(null); // null = loading
  const [status, setStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const latest = useRef(""); // newest text, for saves that run after a render
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useRef<MarkdownEditorHandle>(null);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    setStatus("saving");
    try {
      const res = await api("/api/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: latest.current }),
        keepalive: true, // let the save finish even if the page is closing
      });
      setStatus((s) => (s === "saving" ? "saved" : s));
      // An image removed from the page went to the trash (or came back on undo): refresh the file tree.
      const images = (await res.json().catch(() => null)) as { removed?: string[]; restored?: string[] } | null;
      if (images?.removed?.length || images?.restored?.length) onFilesChanged?.();
    } catch (e) {
      dirty.current = true; // keep the edits marked unsaved so the next save retries
      setStatus("error");
      onError(e);
    }
  }, [path, onError, onFilesChanged]);

  useImperativeHandle(
    ref,
    () => ({
      flush: save,
      discard: () => {
        if (timer.current) clearTimeout(timer.current);
        dirty.current = false;
      },
    }),
    [save],
  );

  // Load the note; save any pending edits when switching away from it.
  useEffect(() => {
    if (live !== undefined) return setContent(""); // the live text is shown instead; nothing to load or save
    let cancelled = false;
    setContent(null);
    api(`/api/files/content?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then(({ content }: { content: string }) => {
        if (cancelled) return;
        latest.current = content;
        dirty.current = false;
        setStatus("saved");
        setContent(content);
        // Start typing right away, unless something else has focus (like the
        // name box of a note that was just created).
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (!active || active === document.body) editor.current?.focus();
        });
      })
      .catch((e) => !cancelled && onError(e));
    return () => {
      cancelled = true;
      void save(); // flush edits to *this* note before the next one loads
    };
    // `save` changes with `path`; this effect must only re-run per note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const onChange = (value: string) => {
    setContent(value);
    latest.current = value;
    dirty.current = true;
    setStatus("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, SAVE_DELAY);
  };

  const parts = path.split("/");
  const title = parts.at(-1)!.replace(/\.md$/i, "");

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-8 text-sm"> {/* same height as the AI panel's header, so the lines meet */}
        <div className="min-w-0 truncate text-muted">
          {back && (
            <button onClick={back.go} className="mr-3 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg" title={`Back to ${back.label} (⌘⌥←)`}>
              ← {back.label}
            </button>
          )}
          {parts.slice(0, -1).map((p) => (
            <span key={p}>
              {p} <span className="mx-1">/</span>
            </span>
          ))}
          <span className="font-medium text-fg">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
          {live !== undefined ? (
            <span className="text-accent">
              <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />
              {liveLabel}
            </span>
          ) : (
            <span className={status === "error" ? "text-danger" : ""}>
              {{ saved: "Saved", unsaved: "Edited", saving: "Saving…", error: "Not saved" }[status]}
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto h-full max-w-3xl px-8 py-8">
          {content === null ? null : (
            // Keyed by path: each note gets a fresh editor seeded with its text.
            <MarkdownEditor
              key={path}
              ref={editor}
              initial={live ?? content}
              onChange={onChange}
              onBlur={() => void save()}
              links={links}
              linksVersion={linksVersion}
              live={live}
            />
          )}
        </div>
      </div>
    </div>
  );
}
