import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Attachment } from "./shared";

export type Role = "user" | "assistant";

/** "oneoff" = a quick side question kept out of the map and side-thread list. */
export type ThreadKind = "thread" | "oneoff";

export type Thread = {
  id: string;
  parentThreadId: string | null; // null => this is a conversation's main thread
  forkMessageId: string | null; // message in the parent this thread branched from
  anchorText: string | null; // highlighted span the side question is about
  title: string;
  kind: ThreadKind;
  createdAt: number;
};

export type Message = {
  id: string;
  threadId: string;
  role: Role;
  content: string;
  createdAt: number;
  /** Files sent with a user message. */
  attachments?: Attachment[];
};

const DB_PATH = process.env.FLOW_DB_PATH ?? path.join(process.cwd(), "data", "flow.db");

// Next.js dev mode re-evaluates modules on every hot reload. Stashing the
// connection on globalThis keeps us from opening a new handle each time.
const g = globalThis as unknown as { flowDb?: Database.Database };

function open(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id               TEXT PRIMARY KEY,
      parent_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      fork_message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
      anchor_text      TEXT,
      title            TEXT NOT NULL,
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_threads_parent  ON threads(parent_thread_id);
  `);
  return db;
}

/**
 * Columns added after a database was first created. CREATE TABLE IF NOT EXISTS
 * won't touch an existing table, so new columns are added here. Runs on every
 * module load (not inside open()), because in dev the connection is reused
 * across hot reloads and open() wouldn't run again.
 */
function migrate(db: Database.Database) {
  const cols = new Set((db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("kind")) db.exec(`ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread'`);
  // 1 once a thread's title has been written by the model (from what it's about).
  if (!cols.has("auto_titled")) db.exec(`ALTER TABLE threads ADD COLUMN auto_titled INTEGER NOT NULL DEFAULT 0`);
  // Files sent with a message, as a JSON array of Attachment (null: none).
  const msgCols = new Set((db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name));
  if (!msgCols.has("attachments")) db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
  // The AI assistant beside a note: one conversation per note, kept out of Chats.
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_chat_messages (
      id         TEXT PRIMARY KEY,
      note_path  TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_chat_path ON note_chat_messages(note_path, created_at);
  `);
  const noteCols = new Set((db.prepare(`PRAGMA table_info(note_chat_messages)`).all() as { name: string }[]).map((c) => c.name));
  if (!noteCols.has("attachments")) db.exec(`ALTER TABLE note_chat_messages ADD COLUMN attachments TEXT`);
}

export const db = (g.flowDb ??= open());
migrate(db);

const threadCols = `id, parent_thread_id AS parentThreadId, fork_message_id AS forkMessageId,
  anchor_text AS anchorText, title, kind, created_at AS createdAt`;
const messageCols = `id, thread_id AS threadId, role, content, created_at AS createdAt, attachments`;

/** A messages row as a Message: the attachments column is JSON, and absent when there are none. */
function toMessage(row: Omit<Message, "attachments"> & { attachments: string | null }): Message {
  const { attachments, ...rest } = row;
  return attachments ? { ...rest, attachments: JSON.parse(attachments) as Attachment[] } : rest;
}
type MessageRow = Parameters<typeof toMessage>[0];

export function getThread(id: string): Thread | undefined {
  return db.prepare(`SELECT ${threadCols} FROM threads WHERE id = ?`).get(id) as Thread | undefined;
}

export function getMessages(threadId: string): Message[] {
  return db
    .prepare(`SELECT ${messageCols} FROM messages WHERE thread_id = ? ORDER BY created_at, rowid`)
    .all(threadId)
    .map((r) => toMessage(r as MessageRow));
}

export function listConversations(): Thread[] {
  return db
    .prepare(`SELECT ${threadCols} FROM threads WHERE parent_thread_id IS NULL ORDER BY created_at DESC`)
    .all() as Thread[];
}

/** Every thread (main chats and branches), for linking to chats from notes. Titles only, no messages. */
export function listAllThreads(): Pick<Thread, "id" | "parentThreadId" | "title" | "kind">[] {
  return db
    .prepare(`SELECT id, parent_thread_id AS parentThreadId, title, kind FROM threads ORDER BY created_at DESC`)
    .all() as Pick<Thread, "id" | "parentThreadId" | "title" | "kind">[];
}

/** The main thread a thread belongs to (itself if it is one), or undefined if it doesn't exist. */
export function getRootId(id: string): string | undefined {
  const row = db
    .prepare(
      `WITH RECURSIVE up(id, parent) AS (
         SELECT id, parent_thread_id FROM threads WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_thread_id FROM threads t JOIN up ON t.id = up.parent
       )
       SELECT id FROM up WHERE parent IS NULL`,
    )
    .get(id) as { id: string } | undefined;
  return row?.id;
}

/**
 * Conversations (main-thread ids) where any thread title or message contains
 * `query`, case-insensitively. Hits in side threads count for their
 * conversation: the recursive CTE walks each hit up to its root.
 */
export function searchConversations(query: string): string[] {
  const like = `%${query.replace(/[\\%_]/g, (c) => "\\" + c)}%`; // match literally, % and _ included
  const rows = db
    .prepare(
      `WITH RECURSIVE
         hits(id) AS (
           SELECT id FROM threads WHERE title LIKE @like ESCAPE '\\'
           UNION
           SELECT thread_id FROM messages WHERE content LIKE @like ESCAPE '\\'
         ),
         up(id, parent) AS (
           SELECT t.id, t.parent_thread_id FROM threads t JOIN hits h ON t.id = h.id
           UNION
           SELECT t.id, t.parent_thread_id FROM threads t JOIN up ON t.id = up.parent
         )
       SELECT DISTINCT id FROM up WHERE parent IS NULL`,
    )
    .all({ like }) as { id: string }[];
  return rows.map((r) => r.id);
}

/** A main thread plus every thread descended from it, with all their messages. */
export function getConversation(rootId: string): { threads: Thread[]; messages: Message[] } {
  const threads = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM threads WHERE id = ?
         UNION ALL
         SELECT t.id FROM threads t JOIN tree ON t.parent_thread_id = tree.id
       )
       SELECT ${threadCols} FROM threads WHERE id IN (SELECT id FROM tree) ORDER BY created_at`,
    )
    .all(rootId) as Thread[];
  const ids = threads.map((t) => t.id);
  const messages = ids.length
    ? (db
        .prepare(
          `SELECT ${messageCols} FROM messages WHERE thread_id IN (${ids.map(() => "?").join(",")})
           ORDER BY created_at, rowid`,
        )
        .all(...ids)
        .map((r) => toMessage(r as MessageRow)))
    : [];
  return { threads, messages };
}

export function createThread(input: {
  parentThreadId?: string | null;
  forkMessageId?: string | null;
  anchorText?: string | null;
  title: string;
  kind?: ThreadKind;
}): Thread {
  const thread: Thread = {
    id: crypto.randomUUID(),
    parentThreadId: input.parentThreadId ?? null,
    forkMessageId: input.forkMessageId ?? null,
    anchorText: input.anchorText ?? null,
    title: input.title,
    kind: input.kind ?? "thread",
    createdAt: Date.now(),
  };
  db.prepare(
    `INSERT INTO threads (id, parent_thread_id, fork_message_id, anchor_text, title, kind, created_at)
     VALUES (@id, @parentThreadId, @forkMessageId, @anchorText, @title, @kind, @createdAt)`,
  ).run(thread);
  return thread;
}

export function renameThread(id: string, title: string) {
  db.prepare(`UPDATE threads SET title = ? WHERE id = ?`).run(title, id);
}

/** Whether a thread still has its placeholder title (a main chat's first message, a branch's highlighted text). */
export function needsTitle(id: string): boolean {
  const row = db.prepare(`SELECT auto_titled AS titled FROM threads WHERE id = ?`).get(id) as { titled: number } | undefined;
  return row?.titled === 0;
}

/** A name the user chose. Marked as titled, so automatic titles never replace it. */
export function setTitle(id: string, title: string) {
  db.prepare(`UPDATE threads SET title = ?, auto_titled = 1 WHERE id = ?`).run(title, id);
}

/** Save a model-written title for a thread. */
export function setAutoTitle(id: string, title: string) {
  db.prepare(`UPDATE threads SET title = ?, auto_titled = 1 WHERE id = ?`).run(title, id);
}

/** Threads (chats and branches) that still have a placeholder title and at least one reply to summarize. */
export function untitledThreads(): string[] {
  return (
    db
      .prepare(
        `SELECT t.id FROM threads t
         WHERE t.auto_titled = 0
           AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.role = 'assistant')`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

/** Promote a one-off to a regular side thread. One-way: anything in the map stays in the map. */
export function saveToMap(id: string) {
  db.prepare(`UPDATE threads SET kind = 'thread' WHERE id = ? AND kind = 'oneoff'`).run(id);
}

export function deleteThread(id: string) {
  db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
}

/** Delete one message (and, through the schema's cascade, any side threads branched from it). */
export function deleteMessage(id: string) {
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
}

export function addMessage(threadId: string, role: Role, content: string, id: string = crypto.randomUUID(), attachments: Attachment[] = []): Message {
  const msg: Message = { id, threadId, role, content, createdAt: Date.now(), ...(attachments.length ? { attachments } : {}) };
  db.prepare(
    `INSERT INTO messages (id, thread_id, role, content, created_at, attachments)
     VALUES (@id, @threadId, @role, @content, @createdAt, @attachments)`,
  ).run({ ...msg, attachments: attachments.length ? JSON.stringify(attachments) : null });
  return msg;
}

/** Ids of every file some message still has attached (the rest can be deleted). */
export function referencedAttachmentIds(): Set<string> {
  const rows = db
    .prepare(`SELECT attachments FROM messages WHERE attachments IS NOT NULL UNION ALL SELECT attachments FROM note_chat_messages WHERE attachments IS NOT NULL`)
    .all() as { attachments: string }[];
  return new Set(rows.flatMap((r) => (JSON.parse(r.attachments) as Attachment[]).map((a) => a.id)));
}

// ---------- the assistant beside a note (one conversation per note path) ----------

export type NoteChatMessage = { id: string; role: Role; content: string; createdAt: number; attachments?: Attachment[] };

export function getNoteChat(notePath: string): NoteChatMessage[] {
  return (
    db
      .prepare(`SELECT id, role, content, created_at AS createdAt, attachments FROM note_chat_messages WHERE note_path = ? ORDER BY created_at, rowid`)
      .all(notePath) as (Omit<NoteChatMessage, "attachments"> & { attachments: string | null })[]
  ).map(({ attachments, ...m }) => (attachments ? { ...m, attachments: JSON.parse(attachments) as Attachment[] } : m));
}

export function addNoteChatMessage(notePath: string, role: Role, content: string, attachments: Attachment[] = []): NoteChatMessage {
  const msg = { id: crypto.randomUUID(), role, content, createdAt: Date.now(), ...(attachments.length ? { attachments } : {}) };
  db.prepare(`INSERT INTO note_chat_messages (id, note_path, role, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)`).run(
    msg.id,
    notePath,
    role,
    content,
    msg.createdAt,
    attachments.length ? JSON.stringify(attachments) : null,
  );
  return msg;
}

/** Start the note's conversation over. */
export function clearNoteChat(notePath: string) {
  db.prepare(`DELETE FROM note_chat_messages WHERE note_path = ?`).run(notePath);
}

/** A note or folder was renamed or moved: its notes' conversations follow. */
export function moveNoteChats(from: string, to: string) {
  db.prepare(
    `UPDATE note_chat_messages SET note_path = ? || substr(note_path, length(?) + 1)
     WHERE note_path = ? OR note_path LIKE ? ESCAPE '\\'`,
  ).run(to, from, from, from.replace(/[\\%_]/g, (c) => "\\" + c) + "/%");
}

/** A note or folder was deleted: so are its notes' conversations. */
export function deleteNoteChats(notePath: string) {
  db.prepare(`DELETE FROM note_chat_messages WHERE note_path = ? OR note_path LIKE ? ESCAPE '\\'`).run(notePath, notePath.replace(/[\\%_]/g, (c) => "\\" + c) + "/%");
}
