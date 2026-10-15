"use client";

import { memo, useState } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Thread } from "@/lib/db";
import { rehypeAnchors, type Anchor } from "@/lib/rehype-anchors";
import { rehypeFade } from "@/lib/rehype-fade";

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
  compact?: boolean;
  canBranch?: boolean;
}) {
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
        {m.role === "assistant" && saved && canBranch && (
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
            {branches
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
            <button onClick={() => onFork(m.id)} className="rounded-full px-2 py-0.5 text-xs text-muted opacity-60 hover:opacity-100">
              + ask on the side
            </button>
          </div>
        )}
      </div>
    );
  });
}

type BubbleProps = {
  message: Pick<Message, "role" | "content"> & { id?: string };
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
const Bubble = memo(BubbleView, (a, b) =>
  a.message.content === b.message.content &&
  a.message.role === b.message.role &&
  a.message.id === b.message.id &&
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
export function StreamingBubble({ content, compact }: { content: string; compact?: boolean }) {
  const [track] = useState(() => ({ length: 0, starts: [] as number[] }));
  if (content.length > track.length) {
    track.starts.push(track.length);
    track.length = content.length;
  }
  if (!content) return <Bubble message={{ role: "assistant", content: "…" }} compact={compact} />;
  return <Bubble message={{ role: "assistant", content }} compact={compact} fade={{ starts: [...track.starts], source: content }} />;
}

function sameAnchors(a: Anchor[] = [], b: Anchor[] = []) {
  return (
    a.length === b.length &&
    a.every((x, i) => x.threadId === b[i].threadId && x.text === b[i].text && x.active === b[i].active && x.oneOff === b[i].oneOff)
  );
}

function BubbleView({ message, threadId, forkable, compact, anchors, fade }: BubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl bg-user px-4 py-2.5 ${compact ? "text-sm" : ""}`}>{message.content}</div>
      </div>
    );
  }
  return (
    <div
      data-fork-id={forkable ? message.id : undefined}
      data-fork-thread={forkable ? threadId : undefined}
      className={`md px-1 ${compact ? "text-sm" : ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[...(anchors?.length ? [[rehypeAnchors, { anchors }] satisfies Pluggable] : []), ...(fade ? [[rehypeFade, fade] satisfies Pluggable] : [])]}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}

export function Composer({
  ref,
  busy,
  placeholder,
  onSend,
  onStop,
  compact,
  autoFocus,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  busy: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div className={`relative ${compact ? "border-t border-line p-3" : "mx-auto w-full max-w-3xl px-6 pb-6"}`}>
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
      <textarea
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        rows={compact ? 2 : 3}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (busy || !value.trim()) return;
            onSend(value);
            setValue("");
          }
        }}
        className="w-full resize-none rounded-xl border border-line bg-bg px-4 py-3 outline-none placeholder:text-muted focus:border-line-strong"
      />
    </div>
  );
}
