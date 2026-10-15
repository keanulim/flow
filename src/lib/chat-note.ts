import type { Message, Thread } from "./db";

/**
 * Turn a chat (one thread and everything branched off it, nothing above it)
 * into a Markdown note:
 *
 *     # Title
 *     summary of the thread
 *
 *     <details>                     one toggle per branch, placed right after the
 *     <summary>Branch</summary>     line of the summary where its topic comes up
 *
 *     *On “highlighted text”*
 *     summary of the branch (same kind of notes, a bit shorter)
 *     ...its own branches, nested...
 *     </details>
 *
 * Side questions ("one-offs") become toggles too, with a one- or two-line note.
 *
 * Each thread is summarized by its own model call (in parallel); the structure
 * around them is built here in code, so the model can't break the toggles.
 * To place a branch, the model only appends a marker like {{branch-2}} to the
 * line that mentions its topic; branches it doesn't place go at the end.
 */

export type NoteKind = "page" | "branch" | "oneoff";

export type ChatNode = {
  thread: Thread;
  messages: Message[];
  kind: NoteKind;
  children: ChatNode[];
};

/** The tree under `rootId`. Children are ordered by where they branched off (then by age); empty leaves are dropped. */
export function buildTree(rootId: string, threads: Thread[], messages: Message[]): ChatNode {
  const byThread = new Map<string, Message[]>();
  for (const m of messages) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  const kids = new Map<string, Thread[]>();
  for (const t of threads) if (t.parentThreadId) kids.set(t.parentThreadId, [...(kids.get(t.parentThreadId) ?? []), t]);

  const node = (t: Thread, kind: NoteKind): ChatNode | null => {
    const own = byThread.get(t.id) ?? [];
    const order = new Map(own.map((m, i) => [m.id, i]));
    const children = (kids.get(t.id) ?? [])
      .slice()
      .sort((a, b) => (order.get(a.forkMessageId ?? "") ?? Infinity) - (order.get(b.forkMessageId ?? "") ?? Infinity) || a.createdAt - b.createdAt)
      .map((c) => node(c, c.kind === "oneoff" ? "oneoff" : "branch"))
      .filter((c): c is ChatNode => c !== null);
    if (kind !== "page" && !own.length && !children.length) return null;
    return { thread: t, messages: own, kind, children };
  };

  const root = threads.find((t) => t.id === rootId);
  if (!root) throw new Error("Chat not found");
  return node(root, "page")!;
}

export const SYSTEM = `You turn a chat between a person and an AI assistant into notes for the person's Markdown notebook.
Write the notes themselves: no preamble ("Here is a summary"), no sign-off.
Write the knowledge directly, not a play-by-play ("the user asked..., the assistant said..."); when it helps, a question can be a bold label with its answer under it.
Keep what's worth coming back to: answers, conclusions, decisions, definitions, steps, and short code or commands.
Be concise. Use bullet points, **bold** for key terms, tables only when comparing several things, and fenced code blocks for code. Don't use HTML.
Don't start with a title or heading that restates the chat's topic: the note already has a title.`;

const INSTRUCTIONS: Record<NoteKind, string> = {
  page: "Summarize this chat as notes. You can group them under ## or ### headings when there are distinct topics.",
  branch:
    "This is a side branch of a larger chat, about the excerpt shown. Summarize it as notes in the same style, but shorter, and with no headings (use **bold** labels instead); it will sit inside a collapsible section.",
  oneoff: "This is a quick side question about the excerpt shown. Write a super brief note: one or two short bullet points of what it covered and the answer. No headings.",
};

export const MAX_TOKENS: Record<NoteKind, number> = { page: 4000, branch: 2500, oneoff: 400 };

/** The prompt for one thread: its own messages only (branches are summarized separately). */
export function promptFor(node: ChatNode): string {
  const excerpt = node.thread.anchorText ? `Excerpt it branched from: "${node.thread.anchorText}"\n\n` : "";
  const transcript = node.messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  return `${INSTRUCTIONS[node.kind]}\n\n${excerpt}<chat title="${node.thread.title.replace(/"/g, "'")}">\n${transcript}\n</chat>${branchList(node)}`;
}

/** Tells the model which side branches exist, so it can mark where each one belongs. */
function branchList(node: ChatNode): string {
  if (!node.children.length) return "";
  const items = node.children.map((c, i) => `${marker(i)}: highlighted "${(c.thread.anchorText ?? c.thread.title).replace(/\s+/g, " ")}"`);
  return `

Side branches were opened from parts of this chat; their notes will be inserted into yours. For each one, append its marker to the end of the line in your notes where that highlighted topic comes up (put it on the best-matching line if the exact words don't appear). Use each marker exactly once:
${items.join("\n")}`;
}

const marker = (i: number) => `{{branch-${i + 1}}}`;
const MARKER = /\s*\{\{branch-(\d+)\}\}/g;

/**
 * Put each child's toggle right after the line whose marker names it. If that
 * line can't be split from what follows (a table row, inside a code block, a
 * paragraph that continues, a bullet with indented sub-bullets) the toggle
 * waits until that block ends. Unplaced toggles go at the end.
 */
export function placeToggles(summary: string, toggles: string[]): string {
  const lines = summary.split("\n");
  const out: string[] = [];
  const placed = new Set<number>();
  let pending: number[] = [];
  let inFence = false;
  const flush = () => {
    for (const i of pending) out.push("", toggles[i], "");
    pending = [];
  };
  lines.forEach((line, k) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const text = inFence ? line : line.replace(MARKER, (_, n: string) => {
      const i = Number(n) - 1;
      if (i >= 0 && i < toggles.length && !placed.has(i)) {
        placed.add(i);
        pending.push(i);
      }
      return "";
    });
    out.push(text === line ? line : text.trimEnd());
    const next = lines[k + 1];
    const canSplit = !inFence && (next === undefined || !next.trim() || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(next));
    if (pending.length && canSplit) flush();
  });
  flush();
  toggles.forEach((t, i) => placed.has(i) || out.push("", t, ""));
  // Collapse the extra blank lines added around toggles.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Summarize every thread in the tree, a few at a time. Returns summaries by thread id. */
export async function summarizeTree(
  root: ChatNode,
  summarize: (node: ChatNode) => Promise<string>,
  concurrency = 4,
): Promise<Map<string, string>> {
  const all: ChatNode[] = [];
  const walk = (n: ChatNode) => (all.push(n), n.children.forEach(walk));
  walk(root);
  const out = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < all.length) {
      const n = all[next++];
      out.set(n.thread.id, n.messages.length ? await summarize(n) : "");
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, worker));
  return out;
}

/** Model output, made safe to put inside a toggle: no stray <details> tags, no unclosed code fence. */
export function clean(md: string): string {
  let inFence = false;
  const lines = md.trim().split("\n").map((l) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    return inFence ? l : l.replace(/<(\/?)(details|summary)\b/gi, "&lt;$1$2"); // inside code it's just text
  });
  if (inFence) lines.push("```");
  return lines.join("\n");
}

/** A toggle title: one line, no tags. */
const titleText = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim() || "Untitled";
const quoted = (s: string) => `*On “${s.replace(/\s+/g, " ").trim().replace(/\*/g, "\\*")}”*`;

/** The note's Markdown, from the tree and its summaries. */
export function renderNote(root: ChatNode, summaries: Map<string, string>, date = new Date()): string {
  const toggle = (n: ChatNode): string => {
    const body = [n.thread.anchorText ? quoted(n.thread.anchorText) : "", placeToggles(clean(summaries.get(n.thread.id) ?? ""), n.children.map(toggle))].filter(Boolean);
    // Blank line after <summary> so the body parses as Markdown; </details> may follow the body directly.
    return `<details>\n<summary>${titleText(n.thread.title)}</summary>\n\n${body.join("\n\n") || "*(empty)*"}\n</details>`;
  };
  const when = date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const blocks = [
    `# ${titleText(root.thread.title)}`,
    `*Notes from a chat · ${when}*`,
    root.thread.anchorText ? quoted(root.thread.anchorText) : "",
    placeToggles(clean(summaries.get(root.thread.id) ?? ""), root.children.map(toggle)),
  ].filter(Boolean);
  // Ends with a blank line after the last </details>, plus the empty line the editor keeps there.
  return blocks.join("\n\n") + "\n\n";
}

/** A file name for the note: the chat title without characters that are awkward in file names or links. */
export function noteFileName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 80) || "Chat notes"
  );
}
