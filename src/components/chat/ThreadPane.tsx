"use client";

import type { RefObject } from "react";
import type { Conversation } from "@/hooks/useConversation";
import type { Attachment } from "@/lib/shared";
import { Composer, MessageList, StreamingBubble } from "./Messages";

type Props = {
  conv: Conversation;
  streaming: Record<string, string>;
  /** What the model is doing in a thread when it isn't writing ("Searching: …"). */
  activity: Record<string, string>;
  send: (threadId: string | null, text: string, attachments?: Attachment[]) => void;
  stop: (threadId: string) => void;
  retry: (threadId: string, messageId: string) => void;
  /** Thread id whose note is being made, if any. */
  makingNote: string | null;
  onMakeNote: (threadId: string) => void;
  flashId: string | null;
  onJumpToSource: (messageId: string) => void;
  /** Text selection (for "ask on the side") and clicks on highlights. */
  onMouseUp: () => void;
  onClick: (e: React.MouseEvent) => void;
  /** A click anywhere in the pane, for closing the side panel. */
  onClickAnywhere: (e: React.MouseEvent) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
};

/** The center: the focused thread, with breadcrumbs when it's a side thread, and its message box. */
export default function ThreadPane({ conv, streaming, activity, send, stop, retry, makingNote, onMakeNote, flashId, onJumpToSource, onMouseUp, onClick, onClickAnywhere, inputRef, scrollRef }: Props) {
  const { rootId, focus, focusThread, focusMessages, branches, showSide, sideId, lineage, goTo, goUp, fork, openThread } = conv;
  const nested = !!focusThread?.parentThreadId;

  return (
    <main className="relative flex min-w-0 flex-1 flex-col" onClick={onClickAnywhere}>
      {focus && focusMessages.length > 0 && (
        <button
          onClick={() => onMakeNote(focus)}
          disabled={!!makingNote}
          className="absolute top-2.5 right-4 z-10 rounded-md border border-line bg-bg px-2.5 py-1 text-xs text-muted hover:text-fg disabled:cursor-wait disabled:opacity-70"
          title={nested ? "Summarize this branch and its branches into a note" : "Summarize this chat and its branches into a note"}
        >
          {makingNote === focus ? (
            <>
              <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />
              Making note…
            </>
          ) : (
            "Make note"
          )}
        </button>
      )}
      {nested && focusThread && (
        <header className="border-b border-line bg-accent-soft/60 py-3 pr-32 pl-6">
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            {lineage.map((t, i) => (
              <span key={t.id} className="flex min-w-0 items-center gap-1">
                {i > 0 && <span className="text-muted">›</span>}
                <button
                  onClick={() => goTo(t.id)}
                  className={`max-w-48 truncate rounded px-1 ${t.id === focus ? "font-medium text-fg" : "text-muted hover:text-fg"}`}
                >
                  {t.parentThreadId ? t.title : "Main"}
                </button>
              </span>
            ))}
          </nav>
          <button
            onClick={() => {
              goUp();
              if (focusThread.forkMessageId) setTimeout(() => onJumpToSource(focusThread.forkMessageId!), 50);
            }}
            className="mt-1.5 block max-w-full truncate border-l-2 border-accent pl-2 text-left text-sm text-muted hover:text-fg"
            title="Go up to where this branched (Esc)"
          >
            {focusThread.anchorText ? `“${focusThread.anchorText}”` : "About the whole reply"}
          </button>
        </header>
      )}
      <div ref={scrollRef} onMouseUp={onMouseUp} onClick={onClick} className="flex-1 overflow-y-auto">
        {/* Extra room at the bottom, so the last reply can scroll clear of the fade */}
        <div className="mx-auto max-w-3xl px-6 pt-8 pb-12">
          {!rootId && <p className="mt-24 text-center text-muted">Start a conversation. Side questions stay out of its way.</p>}
          {focus && (
            <MessageList
              threadId={focus}
              messages={focusMessages}
              childThreads={branches}
              activeChildId={showSide ? sideId : null}
              flashId={flashId}
              onFork={(messageId) => fork(focus, messageId, null)}
              onOpen={openThread}
              onRetry={streaming[focus] === undefined ? (messageId) => conv.confirmRetry(messageId) && retry(focus, messageId) : undefined}
            />
          )}
          {focus && streaming[focus] !== undefined && <StreamingBubble content={streaming[focus]} activity={activity[focus]} />}
        </div>
      </div>
      <div className="relative">
        {/* Replies fade out just above the message box instead of being cut off at a hard edge */}
        <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-linear-to-b from-transparent to-bg" />
        <Composer
          ref={inputRef}
          onStop={() => focus && stop(focus)}
          busy={!!focus && streaming[focus] !== undefined}
          placeholder={nested ? "Continue this side thread…" : "Message the main thread…"}
          onSend={(text, files) => send(focus, text, files)}
          attachments
          autoFocus
        />
      </div>
    </main>
  );
}
