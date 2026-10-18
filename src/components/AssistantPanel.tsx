"use client";

import { useEffect, useRef, useState } from "react";
import { postChat } from "@/lib/chat-stream";
import { api } from "@/lib/client";
import { type Attachment, EMPTY_REPLY, STOPPED_NOTE, withSources } from "@/lib/shared";
import { Bubble, Composer, StreamingBubble } from "./chat/Messages";

type Turn = { id: string; role: "user" | "assistant"; content: string; attachments?: Attachment[] };

type Props = {
  /** The open note. The conversation belongs to it, and the assistant can edit it. */
  notePath: string;
  /** Save pending edits in the note before the assistant reads it. */
  onBeforeSend: () => Promise<void>;
  /** While the assistant works: show the note read-only with this text (null: done, reload the saved note). */
  onLive: (markdown: string | null) => void;
  /** The note changed on disk outside the editor (undo): load it again. */
  onReload: () => void;
  /** The assistant created or removed pages: reload the file list. */
  onFilesChanged: () => void;
  /** Open a page (one the assistant just created). */
  onOpenNote: (path: string) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
};

/**
 * The AI assistant beside a note (the lambda button, bottom right). Each note
 * has its own conversation, kept out of Chats, and the assistant can edit the
 * note: reorganize it, add to it, brainstorm into it.
 */
export default function AssistantPanel({ notePath, onBeforeSend, onLive, onReload, onFilesChanged, onOpenNote, onClose, onError }: Props) {
  const [turns, setTurns] = useState<Turn[] | null>(null); // null while loading
  const [streaming, setStreaming] = useState<string | null>(null); // reply so far, while it works
  const [activity, setActivity] = useState<string | undefined>(); // "Editing the note"
  // The last reply's changes, reversible: the note before it (null: unchanged) and the pages it created.
  const [undo, setUndo] = useState<{ turnId: string; before: string | null; created: string[] } | null>(null);
  const [createdBy, setCreatedBy] = useState<Record<string, string[]>>({}); // pages each reply created (this session), shown under it
  const [creating, setCreating] = useState<string[]>([]); // pages created by the reply in progress
  const input = useRef<HTMLTextAreaElement>(null);
  const aborter = useRef<AbortController | null>(null);

  // Each note has its own conversation.
  useEffect(() => {
    let cancelled = false;
    setTurns(null);
    setUndo(null);
    api(`/api/notes/assist?path=${encodeURIComponent(notePath)}`)
      .then((r) => r.json())
      .then((t: Turn[]) => !cancelled && setTurns(t))
      .catch((e) => !cancelled && (onError(e), setTurns([])));
    return () => {
      cancelled = true;
      aborter.current?.abort(); // switching notes stops a reply in progress
    };
  }, [notePath, onError]);

  const send = async (message: string, files: Attachment[] = []) => {
    let before: string;
    try {
      await onBeforeSend(); // the file on disk is now what the editor shows
      before = ((await (await api(`/api/files/content?path=${encodeURIComponent(notePath)}`)).json()) as { content: string }).content;
    } catch (e) {
      return onError(e);
    }
    setUndo(null);
    setTurns((t) => [...(t ?? []), { id: crypto.randomUUID(), role: "user", content: message.trim(), ...(files.length ? { attachments: files } : {}) }]);
    setStreaming("");
    onLive(before); // read-only while the assistant works, so typing can't collide with its edits
    const abort = (aborter.current = new AbortController());
    let text = "";
    let changed = false;
    const created: string[] = [];
    let reply: string | null = null;
    try {
      const done = await postChat(
        { path: notePath, content: before, message, attachments: files.map((f) => f.id) },
        {
          onText: (t) => {
            text += t;
            setStreaming(text);
            setActivity(undefined);
          },
          onStatus: setActivity,
          onNote: (content) => {
            changed = true;
            onLive(content); // watch the edit land
          },
          onCreated: (path) => {
            created.push(path);
            setCreating([...created]);
            onFilesChanged(); // the new page shows in the file tree right away
          },
        },
        abort.signal,
        "/api/notes/assist",
      );
      reply = withSources(done.text, done.sources) || EMPTY_REPLY; // what the server saved
    } catch (e) {
      if (abort.signal.aborted) reply = text + STOPPED_NOTE;
      else onError(e);
    }
    const id = crypto.randomUUID();
    if (reply !== null) setTurns((t) => [...(t ?? []), { id, role: "assistant", content: reply }]);
    if (changed || created.length) setUndo({ turnId: id, before: changed ? before : null, created });
    if (created.length) setCreatedBy((c) => ({ ...c, [id]: created }));
    setCreating([]);
    setStreaming(null);
    setActivity(undefined);
    onLive(null); // done: the editor loads the saved note
  };

  /** Put the note back, and move the pages the reply created to the vault's trash. */
  const undoEdit = async () => {
    if (!undo) return;
    try {
      if (undo.before !== null) {
        await api("/api/files/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: notePath, content: undo.before }) });
      }
      for (const p of undo.created) await api(`/api/files?path=${encodeURIComponent(p)}`, { method: "DELETE" });
      const { turnId } = undo;
      setUndo(null);
      setCreatedBy((c) => ({ ...c, [turnId]: [] }));
      if (undo.created.length) onFilesChanged();
      if (undo.before !== null) onReload();
    } catch (e) {
      onError(e);
    }
  };

  const startOver = async () => {
    aborter.current?.abort();
    try {
      await api(`/api/notes/assist?path=${encodeURIComponent(notePath)}`, { method: "DELETE" });
    } catch (e) {
      return onError(e);
    }
    setTurns([]);
    setUndo(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  const name = notePath.split("/").pop()!.replace(/\.md$/i, "");
  const empty = turns !== null && turns.length === 0 && streaming === null;

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-panel" aria-label="AI assistant">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {turns && turns.length > 0 && (
          <button onClick={() => void startOver()} className="rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-fg" title="New conversation for this note" aria-label="New conversation">
            <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        )}
        <button onClick={onClose} className="rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-fg" title="Close" aria-label="Close">
          <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 3.5 8.5 8 4 12.5M8.5 3.5 13 8l-4.5 4.5" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {empty ? (
          <div className="flex h-full flex-col justify-end pb-4">
            <p className="text-lg font-semibold">How can I help with this note?</p>
            <p className="mt-1 text-sm text-muted">Ask me to add to it, reorganize it, brainstorm in it, or split it into new pages. I&apos;ll edit the note directly. You can attach images, PDFs and text files too.</p>
          </div>
        ) : (
          <>
            {turns?.map((t) => (
              <div key={t.id} className="mb-4">
                <Bubble message={t} compact />
                {createdBy[t.id]?.length ? <CreatedPages paths={createdBy[t.id]} onOpen={onOpenNote} /> : null}
                {undo?.turnId === t.id && (
                  <button onClick={() => void undoEdit()} className="mt-1.5 ml-1 rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-line-strong hover:text-fg">
                    Undo changes
                  </button>
                )}
              </div>
            ))}
            {streaming !== null && (
              <>
                <StreamingBubble content={streaming} activity={activity} compact />
                {creating.length > 0 && <CreatedPages paths={creating} onOpen={onOpenNote} />}
              </>
            )}
          </>
        )}
      </div>

      <Composer ref={input} busy={streaming !== null} placeholder="Ask about or edit this note…" onSend={(text, files) => void send(text, files)} onStop={() => aborter.current?.abort()} compact autoFocus attachments />
    </aside>
  );
}

/** Pages a reply created, as chips that open them. */
function CreatedPages({ paths, onOpen }: { paths: string[]; onOpen: (path: string) => void }) {
  return (
    <div className="mt-2 ml-1 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted">New pages</span>
      {paths.map((p) => (
        <button key={p} onClick={() => onOpen(p)} title={p} className="max-w-48 truncate rounded-full border border-line px-2 py-0.5 text-fg hover:border-line-strong">
          {p.split("/").pop()!.replace(/\.md$/i, "")}
        </button>
      ))}
    </div>
  );
}
