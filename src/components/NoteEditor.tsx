"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/client";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import MarkdownEditor, { type MarkdownEditorHandle } from "./MarkdownEditor";
import type { LinkHost } from "@/lib/wikilinks";
import { NOTE_HREF, remarkWikilinks } from "@/lib/remark-wikilinks";

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
  ref?: React.Ref<NoteEditorHandle>;
};

const SAVE_DELAY = 600; // ms after the last keystroke

// Preview renders the HTML that Markdown allows (toggles are <details>), but
// sanitized: the default schema drops scripts, event handlers and the like.
// It also drops <details open>, so allow just that attribute.
const sanitize = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    details: ["open"],
    // [[link]] styling. The default list already restricts className on <a> (to the
    // footnote class) and the first rule wins, so replace that rule rather than add one.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter((x) => !(Array.isArray(x) && x[0] === "className")),
      ["className", "data-footnote-backref", "wikilink", "wikilink-new"],
    ],
  },
};

/**
 * Edit one Markdown note. Saves automatically a moment after you stop typing,
 * and immediately when the note is switched away from or about to be moved.
 * ⌘E / Ctrl+E toggles between editing and a rendered preview (as in Obsidian).
 */
export default function NoteEditor({ path, onError, links, linksVersion, back, ref }: Props) {
  const [content, setContent] = useState<string | null>(null); // null = loading
  const [status, setStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [preview, setPreview] = useState(false);
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
      await api("/api/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: latest.current }),
        keepalive: true, // let the save finish even if the page is closing
      });
      setStatus((s) => (s === "saving" ? "saved" : s));
    } catch (e) {
      dirty.current = true; // keep the edits marked unsaved so the next save retries
      setStatus("error");
      onError(e);
    }
  }, [path, onError]);

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
    let cancelled = false;
    setContent(null);
    setPreview(false);
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

  // ⌘E / Ctrl+E: edit ⇄ preview
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void save();
        setPreview((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Back from preview to editing: put the cursor back in the text. (Only on an
  // actual switch; on first render the load effect decides about focus.)
  const wasPreview = useRef(false);
  useEffect(() => {
    if (wasPreview.current && !preview) requestAnimationFrame(() => editor.current?.focus());
    wasPreview.current = preview;
  }, [preview]);

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
      <header className="flex items-center justify-between border-b border-line px-8 py-3 text-sm">
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
          <span className={status === "error" ? "text-red-600" : ""}>
            {{ saved: "Saved", unsaved: "Edited", saving: "Saving…", error: "Not saved" }[status]}
          </span>
          <button
            onClick={() => {
              void save();
              setPreview((p) => !p);
            }}
            className="rounded-md border border-line px-2 py-1 hover:text-fg"
            title="Toggle preview (⌘E)"
          >
            {preview ? "Edit" : "Preview"}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto h-full max-w-3xl px-8 py-8">
          {content === null ? null : preview ? (
            <div className="md note">
              {content.trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, [remarkWikilinks, { exists: links.exists }]]}
                  rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitize]]}
                  components={{
                    // [[links]] open the page instead of navigating the browser
                    a: ({ href, children, ...rest }) =>
                      href?.startsWith(NOTE_HREF) ? (
                        <a
                          {...rest}
                          href={href}
                          onClick={(e) => {
                            e.preventDefault();
                            links.open(decodeURIComponent(href.slice(NOTE_HREF.length)));
                          }}
                        >
                          {children}
                        </a>
                      ) : (
                        <a {...rest} href={href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      ),
                  }}
                >
                  {content}
                </ReactMarkdown>
              ) : (
                <p className="text-muted">Empty note</p>
              )}
            </div>
          ) : (
            // Keyed by path: each note gets a fresh editor seeded with its text.
            // Also remounts after preview, picking up the latest saved text.
            <MarkdownEditor
              key={path}
              ref={editor}
              initial={content}
              onChange={onChange}
              onBlur={() => void save()}
              links={links}
              linksVersion={linksVersion}
            />
          )}
        </div>
      </div>
    </div>
  );
}
