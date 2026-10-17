// Constants used by both the server and the browser. Keep this file free of
// server-only imports (SDK, database) so the client bundle stays small.

/** Appended to a reply the user stopped mid-stream, so the model knows it was cut off. */
export const STOPPED_NOTE = "\n\n_(stopped)_";

// Other marks a reply carries when something went wrong (written by the server).
export const EMPTY_REPLY = "_(empty reply)_";
export const REFUSAL_NOTE = "\n\n_The model declined to answer this one._";
export const TRUNCATED_NOTE = "\n\n_[reply truncated: hit max_tokens]_";
const ERROR_NOTE_START = "\n\n_Error: ";
export const errorNote = (message: string) => `${ERROR_NOTE_START}${message}_`;

/** A reply that went wrong (error, stopped, cut off, declined, empty): the only kind offered a Retry. */
export function replyWentWrong(content: string): boolean {
  return (
    content === EMPTY_REPLY ||
    content.endsWith(STOPPED_NOTE) ||
    [ERROR_NOTE_START, REFUSAL_NOTE, TRUNCATED_NOTE].some((mark) => content.includes(mark))
  );
}

/** A web page the model used for a reply. */
export type Source = { url: string; title: string };

/**
 * One line of the chat reply stream (newline-delimited JSON): reply text, what
 * the model is doing (searching the web, reading a page), or the sources it
 * cited, sent once at the end.
 */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "status"; text: string }
  | { type: "sources"; sources: Source[] }
  /** The note assistant changed the note: its whole new text. */
  | { type: "note"; content: string };

/** A reply with its sources appended as one Markdown line. Saved like this, so they show whenever the chat is reopened. */
export function withSources(text: string, sources: Source[]): string {
  if (!sources.length) return text;
  const clean = (s: string) => s.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  const links = sources.map((s) => `[${clean(s.title) || new URL(s.url).hostname}](${s.url})`).join(" · ");
  return `${text}\n\n**Sources:** ${links}`;
}

/** Setting (browser only): let the model search the web. On unless turned off in Settings. */
export const WEB_SEARCH_KEY = "flow.webSearch";

/** A file attached to a chat message (the bytes live on the server, under data/attachments). */
export type Attachment = { id: string; name: string; type: string; size: number };

export type AttachmentKind = "image" | "pdf" | "text";

/** Per kind, after images are shrunk in the browser. A request's total must stay under the API's 32 MB. */
export const MAX_ATTACHMENT_BYTES: Record<AttachmentKind, number> = { image: 8 * 1024 * 1024, pdf: 15 * 1024 * 1024, text: 1024 * 1024 };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Text files by extension, since browsers often report code files with no type at all. */
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|r|lua|tex|bib|log|ini|cfg|conf|env\.example)$/i;

/** How the model can read a file, or null if it can't. */
export function attachmentKind(type: string, name: string): AttachmentKind | null {
  if (IMAGE_TYPES.includes(type)) return "image";
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXT.test(name)) return "text";
  return null;
}
