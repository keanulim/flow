"use client";

import type { RefObject } from "react";
import type { Conversation } from "@/hooks/useConversation";
import type { Attachment } from "@/lib/shared";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Composer, MessageList, StreamingBubble } from "./Messages";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

type Props = {
  conv: Conversation;
  streaming: Record<string, string>;
  /** What the model is doing in a thread when it isn't writing ("Searching: …"). */
  activity: Record<string, string>;
  send: (threadId: string | null, text: string, attachments?: Attachment[]) => void;
  stop: (threadId: string) => void;
  retry: (threadId: string, messageId: string) => void;
  onJumpToSource: (messageId: string) => void;
  /** Text selection (for "ask on the side") and clicks on highlights. */
  onMouseUp: () => void;
  onClick: (e: React.MouseEvent) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

/** The side panel: the focused thread's side threads, and the open one with its own message box. */
export default function SidePanel({ conv, streaming, activity, send, stop, retry, onJumpToSource, onMouseUp, onClick, inputRef }: Props) {
  const { sideThreads, sideId, activeSide, activeIsOneOff, childrenOf, messagesOf, counts, setSideOpen, openThread, deleteThread, saveToMap, goTo, fork } = conv;

  const stick = useStickToBottom(); // the message box grows: keep the newest messages in view

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between px-4 py-3 text-sm">
        <span className="font-medium">Side threads · {sideThreads.length}</span>
        <button onClick={() => setSideOpen(false)} className="text-muted hover:text-fg" title="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="max-h-[35%] shrink-0 overflow-y-auto border-b border-line px-2 pb-2">
        {sideThreads.map((t) => {
          const nested = childrenOf(t.id).filter((c) => c.kind !== "oneoff").length;
          return (
            <div
              key={t.id}
              className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                t.id === sideId ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              <button onClick={() => openThread(t.id)} className="min-w-0 flex-1 truncate text-left">
                {streaming[t.id] !== undefined && <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />}
                {t.title}
              </button>
              {nested > 0 && (
                <span className="text-xs text-accent" title="Has side threads">
                  ⑂{nested}
                </span>
              )}
              <span className="text-xs tabular-nums">{counts.get(t.id) ?? 0}</span>
              <button onClick={() => deleteThread(t.id)} className="hidden text-xs group-hover:block hover:text-fg" title="Delete (and its side threads)">
                ✕
              </button>
            </div>
          );
        })}
      </div>

      {activeSide ? (
        <>
          <div ref={stick} onMouseUp={onMouseUp} onClick={onClick} className="flex-1 overflow-y-auto px-4 py-4">
            <div className="mb-4 flex items-start gap-2">
              <button
                onClick={() => activeSide.forkMessageId && onJumpToSource(activeSide.forkMessageId)}
                className="min-w-0 flex-1 border-l-2 border-accent pl-3 text-left text-sm text-muted hover:text-fg"
                title="Jump to where this branched"
              >
                {activeSide.anchorText ? `“${activeSide.anchorText}”` : "About the whole reply"}
                <span className="mt-1 block text-xs text-accent">↖ jump to source</span>
              </button>
              {activeIsOneOff ? (
                <div className="flex shrink-0 items-center gap-1">
                  <span className="rounded-md border border-dashed border-accent/60 px-2 py-1 text-xs text-accent" title="Not in the map. Reopen it from its highlight.">
                    Not in map
                  </span>
                  <button
                    onClick={() => saveToMap(activeSide.id)}
                    className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
                    title="Turn this into a regular side thread"
                  >
                    Save to map
                  </button>
                  <button onClick={() => deleteThread(activeSide.id)} className="rounded-md px-1.5 py-1 text-xs text-muted hover:text-fg" title="Delete">
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => goTo(activeSide.id)}
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-fg"
                  title="Open this thread in the center"
                >
                  ⤢ Expand
                </button>
              )}
            </div>
            <MessageList
              threadId={activeSide.id}
              messages={messagesOf(activeSide.id)}
              childThreads={childrenOf(activeSide.id)}
              activeChildId={null}
              flashId={null}
              onFork={(messageId) => fork(activeSide.id, messageId, null)}
              onOpen={openThread}
              onRetry={streaming[activeSide.id] === undefined ? (messageId) => conv.confirmRetry(messageId) && retry(activeSide.id, messageId) : undefined}
              canBranch={!activeIsOneOff}
              compact
            />
            {streaming[activeSide.id] !== undefined && <StreamingBubble content={streaming[activeSide.id]} activity={activity[activeSide.id]} compact />}
          </div>
          <Composer
            ref={inputRef}
            onStop={() => stop(activeSide.id)}
            busy={streaming[activeSide.id] !== undefined}
            placeholder={activeIsOneOff ? "Follow up…  (Esc to return)" : "Ask on the side…  (Esc to return)"}
            onSend={(text, files) => send(activeSide.id, text, files)}
            attachments
            compact
          />
        </>
      ) : (
        <p className="p-6 text-sm text-muted">Pick a side thread, or highlight text in a reply and press {MOD}K.</p>
      )}
    </aside>
  );
}
