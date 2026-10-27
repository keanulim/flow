"use client";

import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Message, Thread } from "@/lib/db";
import { rehypeAnchors, type Anchor } from "@/lib/rehype-anchors";
import { rehypeFade } from "@/lib/rehype-fade";
import { rehypeAccents } from "@/lib/accents";
import { normalizeMath } from "@/lib/math";
import { type Attachment, replyWentWrong } from "@/lib/shared";
import { formatBytes, uploadAttachment } from "@/lib/upload";
import { COMPOSER_RESIZED } from "@/hooks/useStickToBottom";
import rehypeHighlight from "rehype-highlight";

/** Chat messages: the list, each bubble, the reply being streamed, and the message box. */

type Pluggable = NonNullable<Options["rehypePlugins"]>[number]; // one entry of react-markdown's plugin list

/** A thread's messages, with its side threads drawn as highlights (or chips, for whole-reply branches). */
export function MessageList({
  threadId,
  messages,
  childThreads,
  activeChildId,
  flashId,
  onFork,
  onOpen,
  onRetry,
  compact,
  canBranch = true,
}: {
  threadId: string;
  messages: Message[];
  childThreads: Thread[];
  activeChildId: string | null;
  flashId: string | null;
  onFork: (messageId: string) => void;
  onOpen: (threadId: string) => void;
  /** Regenerate the thread's last reply (offered only when it went wrong; omit while it's generating). */
  onRetry?: (messageId: string) => void;
  compact?: boolean;
  canBranch?: boolean;
}) {
  const last = messages.at(-1);
  return messages.map((m) => {
    const branches = childThreads.filter((t) => t.forkMessageId === m.id);
    const saved = !m.id.startsWith("temp-");
    return (
      <div
        key={m.id}
        id={compact ? undefined : `msg-${m.id}`}
        className={`${compact ? "mb-4" : "mb-6"} rounded-lg transition-colors duration-700 ${flashId === m.id ? "bg-accent-soft" : ""}`}
      >
        <Bubble
          message={m}
          threadId={threadId}
          forkable={m.role === "assistant" && saved && canBranch}
          compact={compact}
          anchors={branches
            .filter((t) => t.anchorText)
            .map((t) => ({ threadId: t.id, text: t.anchorText!, active: t.id === activeChildId, oneOff: t.kind === "oneoff" }))}
        />
        {m.role === "assistant" && saved && (
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
            {canBranch &&
              branches
              .filter((t) => !t.anchorText)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => onOpen(t.id)}
                  className={`max-w-64 truncate rounded-full border px-2.5 py-0.5 text-xs ${t.kind === "oneoff" ? "border-dashed" : ""} ${
                    t.id === activeChildId ? "border-accent text-accent" : "border-line text-muted hover:text-fg"
                  }`}
                >
                  ↳ {t.title}
                </button>
              ))}
            {canBranch && (
              <button onClick={() => onFork(m.id)} className={ACTION}>
                + ask on the side
              </button>
            )}
            <CopyButton text={splitSources(m.content).body} />
            {onRetry && m.id === last?.id && replyWentWrong(m.content) && (
              <button onClick={() => onRetry(m.id)} className={ACTION} title="This reply didn't finish properly: write it again">
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    );
  });
}

const ACTION = "rounded-full px-2 py-0.5 text-xs text-muted opacity-60 hover:opacity-100";

/** Copies `text`; its icon turns into a check for a moment. */
function CopyButton({ text, className = ACTION }: { text: string | (() => string); className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className={`inline-flex items-center justify-center ${className}`}
    >
      <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? (
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        ) : (
          <>
            {/* two overlapping rounded squares */}
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" />
            <path d="M10.5 5.5V4.25A1.75 1.75 0 0 0 8.75 2.5h-4.5A1.75 1.75 0 0 0 2.5 4.25v4.5c0 .97.78 1.75 1.75 1.75H5.5" />
          </>
        )}
      </svg>
    </button>
  );
}

/** A code block in a reply, with a Copy button that shows on hover. */
// `node` (react-markdown's syntax tree node) is taken out so it isn't passed to the DOM.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CodeBlock({ children, node, ...rest }: React.ComponentProps<"pre"> & { node?: unknown }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="group relative">
      <pre ref={pre} {...rest}>
        {children}
      </pre>
      <CopyButton
        text={() => pre.current?.innerText.replace(/\n$/, "") ?? ""}
        className="absolute top-2 right-2 size-7 rounded-md border border-line bg-bg text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100"
      />
    </div>
  );
}

type BubbleProps = {
  message: Pick<Message, "role" | "content" | "attachments"> & { id?: string };
  threadId?: string;
  forkable?: boolean;
  compact?: boolean;
  anchors?: Anchor[];
  /** A reply still streaming in: where each chunk starts, so new text fades in. */
  fade?: { starts: number[]; source: string };
};

/**
 * Memoized: rendering Markdown and running the highlight plugin is the most
 * expensive thing on screen, and most re-renders (every streamed chunk,
 * every keystroke) don't change a finished message. `anchors` is a fresh
 * array on every parent render, so compare it by value, not identity.
 */
export const Bubble = memo(BubbleView, (a, b) =>
  a.message.content === b.message.content &&
  a.message.role === b.message.role &&
  a.message.id === b.message.id &&
  a.message.attachments?.length === b.message.attachments?.length &&
  a.threadId === b.threadId &&
  a.forkable === b.forkable &&
  a.compact === b.compact &&
  a.fade?.starts.length === b.fade?.starts.length &&
  sameAnchors(a.anchors, b.anchors),
);

/**
 * The reply being streamed. Remembers where each arrival of text began, so
 * each one fades in as it appears instead of popping in. Unmounts when the
 * reply finishes, and the saved message renders plainly in its place.
 */
export function StreamingBubble({ content, activity, compact }: { content: string; activity?: string; compact?: boolean }) {
  const [track] = useState(() => ({ length: 0, starts: [] as number[] }));
  if (content.length > track.length) {
    track.starts.push(track.length);
    track.length = content.length;
  }
  // What the model is doing while it isn't writing, e.g. "Searching: …"
  const status = activity && (
    <p className={`flex items-center gap-2 px-1 text-muted ${compact ? "text-xs" : "text-sm"} ${content ? "mt-2" : ""}`}>
      <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-muted" />
      <span className="truncate">{activity}…</span>
    </p>
  );
  if (!content) return status || <Bubble message={{ role: "assistant", content: "…" }} compact={compact} />;
  return (
    <>
      <Bubble message={{ role: "assistant", content }} compact={compact} fade={{ starts: [...track.starts], source: content }} />
      {status}
    </>
  );
}

const SOURCES = /\n\n\*\*Sources:\*\* (.+)$/;

/** A reply's "**Sources:** [a](url) · [b](url)" line (see withSources), split off so it can be shown as links. */
function splitSources(content: string): { body: string; sources: { title: string; url: string }[] } {
  const m = SOURCES.exec(content);
  if (!m) return { body: content, sources: [] };
  const sources = [...m[1].matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map(([, title, url]) => ({ title, url }));
  return sources.length ? { body: content.slice(0, m.index), sources } : { body: content, sources: [] };
}

/** Math with single dollars off: normalizeMath decides which `$…$` are formulas (prices aren't). */
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];

/** Links in replies open in a new tab instead of leaving the app. */
const markdownComponents: Options["components"] = {
  pre: CodeBlock,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

function sameAnchors(a: Anchor[] = [], b: Anchor[] = []) {
  return (
    a.length === b.length &&
    a.every((x, i) => x.threadId === b[i].threadId && x.text === b[i].text && x.active === b[i].active && x.oneOff === b[i].oneOff)
  );
}

function BubbleView({ message, threadId, forkable, compact, anchors, fade }: BubbleProps) {
  const { body, sources } = splitSources(message.content);
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end">
        {message.attachments?.length ? <MessageFiles files={message.attachments} compact={compact} /> : null}
        {message.content && <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl bg-user px-4 py-2.5 ${compact ? "text-sm" : ""}`}>{message.content}</div>}
      </div>
    );
  }
  return (
    <div
      data-fork-id={forkable ? message.id : undefined}
      data-fork-thread={forkable ? threadId : undefined}
      className={`md px-1 ${compact ? "text-sm" : ""}`}
    >
      {/* rehypeKatex draws math; rehypeHighlight colors code blocks labeled with a language; anchors draw branch highlights; fade animates streaming text */}
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false }] satisfies Pluggable,
          rehypeHighlight satisfies Pluggable,
          rehypeAccents satisfies Pluggable,
          ...(anchors?.length ? [[rehypeAnchors, { anchors }] satisfies Pluggable] : []),
          ...(fade ? [[rehypeFade, { ...fade, source: normalizeMath(fade.source) }] satisfies Pluggable] : []),
        ]}
        components={markdownComponents}
      >
        {normalizeMath(body)}
      </ReactMarkdown>
      {sources.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Sources</span>
          {sources.map((s) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              title={s.url}
              className="max-w-56 truncate rounded-full border border-line px-2 py-0.5 !text-muted !no-underline hover:border-line-strong hover:!text-fg" // ! beats the .md link style
            >
              {s.title || new URL(s.url).hostname}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

type Pending = { key: string; file: File; preview?: string; status: "uploading" | "ready" | "failed"; error?: string; attachment?: Attachment };

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.yaml,.yml,.toml,.xml,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cs,.php,.sh,.sql,.tex,.log";

export function Composer({
  ref,
  busy,
  placeholder,
  onSend,
  onStop,
  compact,
  autoFocus,
  attachments: canAttach,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  busy: boolean;
  placeholder: string;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  compact?: boolean;
  autoFocus?: boolean;
  /** Allow attaching files: the paperclip, pasting images, dropping files. */
  attachments?: boolean;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);

  // The box grows with what you type, up to a limit (then it scrolls), and shrinks back after sending.
  // Resized before paint (layout effect), so it never flashes at the wrong height.
  const box = useRef<HTMLTextAreaElement | null>(null);
  const setBox = useCallback(
    (el: HTMLTextAreaElement | null) => {
      box.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = el; // the parent's ref, too
    },
    [ref],
  );
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const before = el.style.height;
    el.style.height = "auto"; // back to its rows, to measure the text
    const max = window.innerHeight * (compact ? 0.35 : 0.45);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    // Its new height is already laid out: the message list above can re-pin to its newest message.
    if (el.style.height !== before) window.dispatchEvent(new Event(COMPOSER_RESIZED));
  }, [value, compact]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // Each file uploads as soon as it's added, so sending is instant.
  const add = (files: Iterable<File>) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setPending((p) => [...p, { key, file, preview, status: "uploading" }]);
      uploadAttachment(file).then(
        (attachment) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "ready", attachment } : x))),
        (e: unknown) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "failed", error: e instanceof Error ? e.message : "Upload failed" } : x))),
      );
    }
  };
  const remove = (key: string) =>
    setPending((p) => {
      const gone = p.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return p.filter((x) => x.key !== key);
    });

  const uploading = pending.some((x) => x.status === "uploading");
  const ready = pending.filter((x) => x.status === "ready").map((x) => x.attachment!);
  const submit = () => {
    if (busy || uploading || (!value.trim() && !ready.length)) return;
    onSend(value, ready);
    setValue("");
    for (const x of pending) if (x.preview) URL.revokeObjectURL(x.preview);
    setPending([]);
  };

  return (
    <div className={`relative ${compact ? "p-3" : "mx-auto w-full max-w-3xl px-6 pb-6"}`}>
      {busy && (
        <button
          onClick={onStop}
          className={`absolute z-10 flex items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 py-1 text-xs text-muted shadow-sm hover:text-fg ${
            compact ? "right-5 bottom-5" : "right-8 bottom-8"
          }`}
          title="Stop generating"
        >
          <span className="size-2 rounded-[2px] bg-current" />
          Stop
        </button>
      )}
      <div
        className={`rounded-xl border bg-bg focus-within:border-line-strong ${dragging ? "border-line-strong bg-hover" : "border-line"}`}
        onDragOver={canAttach ? (e) => (e.dataTransfer.types.includes("Files") && (e.preventDefault(), setDragging(true))) : undefined}
        onDragLeave={canAttach ? (e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false) : undefined}
        onDrop={
          canAttach
            ? (e) => {
                if (!e.dataTransfer.files.length) return;
                e.preventDefault();
                setDragging(false);
                add(e.dataTransfer.files);
              }
            : undefined
        }
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pending.map((x) => (
              <PendingChip key={x.key} item={x} onRemove={() => remove(x.key)} />
            ))}
          </div>
        )}
        <textarea
          ref={setBox}
          value={value}
          autoFocus={autoFocus}
          rows={compact ? 2 : 3}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onPaste={
            canAttach
              ? (e) => {
                  // A pasted screenshot or copied file. (Copied text that also carries an image, e.g. from a doc, stays text.)
                  if (!e.clipboardData.files.length || e.clipboardData.types.includes("text/plain")) return;
                  e.preventDefault();
                  add(e.clipboardData.files);
                }
              : undefined
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className={`block w-full resize-none bg-transparent px-4 py-3 outline-none placeholder:text-muted ${canAttach ? "pr-11" : ""}`}
        />
      </div>
      {canAttach && !busy && (
        <>
          <button
            onClick={() => picker.current?.click()}
            className={`absolute flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg ${compact ? "right-5 bottom-5" : "right-8 bottom-8"}`}
            title="Attach files (or paste / drop them)"
            aria-label="Attach files"
          >
            <svg className="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13.5 7.5 8.2 12.8a3.25 3.25 0 0 1-4.6-4.6l5.6-5.6a2.1 2.1 0 0 1 3 3L6.6 11.2a1 1 0 0 1-1.4-1.4L10.3 4.7" />
            </svg>
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              if (e.target.files) add(e.target.files);
              e.target.value = ""; // so picking the same file again still fires
            }}
          />
        </>
      )}
    </div>
  );
}

/** A file waiting to be sent: a thumbnail or a name card, dimmed while it uploads, red if it failed. */
function PendingChip({ item, onRemove }: { item: Pending; onRemove: () => void }) {
  const failed = item.status === "failed";
  return (
    <div
      className={`group relative flex items-center gap-2 rounded-lg border text-xs ${failed ? "border-danger text-danger" : "border-line"} ${item.status === "uploading" ? "opacity-50" : ""} ${item.preview ? "" : "max-w-56 px-2.5 py-1.5"}`}
      title={failed ? item.error : item.file.name}
    >
      {item.preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob preview, nothing to optimize
        <img src={item.preview} alt={item.file.name} className="size-14 rounded-lg object-cover" />
      ) : (
        <>
          <FileIcon />
          <span className="min-w-0">
            <span className="block truncate">{item.file.name}</span>
            <span className="block text-muted">{failed ? "Couldn't attach" : item.status === "uploading" ? "Uploading…" : formatBytes(item.file.size)}</span>
          </span>
        </>
      )}
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 hidden size-4.5 items-center justify-center rounded-full border border-line bg-bg text-muted group-hover:flex hover:text-fg"
        aria-label={`Remove ${item.file.name}`}
      >
        <svg className="size-2.5" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
        </svg>
      </button>
    </div>
  );
}

function FileIcon() {
  return (
    <svg className="size-4 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5.25h3.5" />
    </svg>
  );
}

/** Files sent with a message: images as thumbnails, other files as cards. Each opens in a new tab. */
function MessageFiles({ files, compact }: { files: Attachment[]; compact?: boolean }) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-2">
      {files.map((f) =>
        f.type.startsWith("image/") ? (
          <a key={f.id} href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer" title={f.name}>
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own API */}
            <img src={`/api/attachments/${f.id}`} alt={f.name} className={`${compact ? "max-h-32" : "max-h-48"} max-w-full rounded-xl border border-line object-contain`} />
          </a>
        ) : (
          <a key={f.id} href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer" title={f.name} className="flex max-w-60 items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs !text-fg !no-underline hover:border-line-strong">
            <FileIcon />
            <span className="min-w-0">
              <span className="block truncate">{f.name}</span>
              <span className="block text-muted">{f.type === "application/pdf" ? "PDF" : "Text"} · {formatBytes(f.size)}</span>
            </span>
          </a>
        ),
      )}
    </div>
  );
}
