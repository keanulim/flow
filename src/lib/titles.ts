import { getMessages, getThread, needsTitle, setAutoTitle } from "./db";
import { quickText } from "./llm";

/**
 * Titles written by the model from what a thread is about, replacing the
 * placeholder once it has a reply: a main chat's placeholder is the start of
 * its first message, a branch's is the text it was opened from.
 */

const SYSTEM = `You name chats. Reply with only a short title (2 to 6 words) saying what the chat is about.
Sentence case, no quotes, no final punctuation, no "Chat about" or similar filler.`;

const MAX_CHARS = 1500; // per message: the start of a chat says what it's about

export function titlePrompt(messages: { role: string; content: string; attachments?: { name: string }[] }[], anchor?: string | null): string {
  const transcript = messages
    .slice(0, 6)
    .map((m) => {
      const files = m.attachments?.length ? `[attached: ${m.attachments.map((a) => a.name).join(", ")}] ` : ""; // the model reads the files; the title writer sees their names
      return `${m.role === "user" ? "User" : "Assistant"}: ${files}${m.content.slice(0, MAX_CHARS)}`;
    })
    .join("\n\n");
  // A branch: name what it explored about the excerpt, not the excerpt itself.
  const context =
    anchor === undefined
      ? ""
      : `This is a side branch of a larger chat, opened ${anchor ? `from the excerpt "${anchor.slice(0, 200)}"` : "about a whole reply"}. The title should say what the branch asks or explains, not repeat the excerpt.\n\n`;
  return `${context}<chat>\n${transcript}\n</chat>\n\nTitle:`;
}

/** The model's reply, made into a clean one-line title (or null if there's nothing usable). */
export function cleanTitle(raw: string): string | null {
  const t = raw
    .split("\n")[0]
    .replace(/^\s*(title\s*:\s*)/i, "")
    .replace(/^["'“”‘’*_`#\s]+|["'“”‘’*_`.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim();
  return t || null;
}

/** Write a title for a thread if it still has its placeholder. Returns the new title, or null. */
export async function autoTitle(threadId: string, { mock = false } = {}): Promise<string | null> {
  if (!needsTitle(threadId)) return null;
  const thread = getThread(threadId);
  const messages = getMessages(threadId); // a branch's own messages, not the ones it inherits
  if (!thread || !messages.some((m) => m.role === "assistant")) return null;
  const anchor = thread.parentThreadId ? thread.anchorText : undefined;
  const title = cleanTitle(await quickText({ system: SYSTEM, prompt: titlePrompt(messages, anchor), maxTokens: 30, mock }));
  if (title) setAutoTitle(threadId, title);
  return title;
}
