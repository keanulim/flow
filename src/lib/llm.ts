import Anthropic from "@anthropic-ai/sdk";
import type { BuiltContext } from "./context";
import { type EditInput, applyEdit } from "./note-edit";
import { type ChatEvent, REFUSAL_NOTE, type Source, TRUNCATED_NOTE } from "./shared";

export const MODEL = "claude-sonnet-5-5";
/** For small, quick jobs like naming a chat. */
export const FAST_MODEL = "claude-haiku-5-5";

// Frozen on purpose: the system prompt is the first thing in the cached
// prefix, so any change to it (timestamps, per-request ids) would invalidate
// the cache for every thread.
const SYSTEM = `You are Flow, an assistant built to keep the user in a state of focus.
Some user messages are side questions about an excerpt of an earlier reply. Answer those directly and compactly. The user will return to the main thread afterward, so don't recap the main topic.
Use Markdown formatting. When you use information from the web, cite it with an inline Markdown link to the page.`;

export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number; webSearches: number };

export type StreamOptions = {
  /** Use the free mock reply even if an API key is set (dev testing).
   *  "think" adds a 2s pause before the first chunk, like the model's thinking phase. */
  mock?: boolean | "think";
  /** Aborting it stops generation (and billing) mid-reply. */
  signal?: AbortSignal;
  /** Let the model search the web and read pages (server-side tools). */
  webSearch?: boolean;
};

/** Streams the reply as events (text, status, sources); returns token usage when done. */
export function streamReply(ctx: BuiltContext, opts: StreamOptions = {}): AsyncGenerator<ChatEvent, Usage | null> {
  return process.env.ANTHROPIC_API_KEY && !opts.mock ? streamClaude(ctx, opts) : streamMock(ctx, opts);
}

// Created on first use, not at import: if the key is added to .env.local while
// the dev server is running, a client built at import time would have no key.
let client: Anthropic | undefined;

/**
 * Web tools run on Anthropic's servers: the model decides when to search or
 * read a page, and gets the results itself. Capped per reply, since each
 * search is billed. These versions filter results with code before they
 * reach the context ("dynamic filtering"), which keeps replies cheaper.
 */
const WEB_TOOLS = [
  { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 5 },
  { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: 3 },
];

const MAX_RESUMES = 4; // a long run of searches can pause the turn; resume at most this many times

async function* streamClaude(ctx: BuiltContext, { signal, webSearch }: StreamOptions): AsyncGenerator<ChatEvent, Usage | null> {
  client ??= new Anthropic();
  let messages = withForkBreakpoint(ctx);
  let tools = webSearch ? WEB_TOOLS : undefined;
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, webSearches: 0 };
  const cited = new Map<string, string>(); // url -> title, from citation markers (plain web search)
  const seen = new Map<string, string>(); // url -> title of every page searched or read (to name the ones the reply links to)
  let text = "";
  let wroteText = false;
  let toolSinceText = false; // a search happened since the last text: start the next text on a new paragraph
  let searchDisabled = false;

  for (let round = 0; round <= MAX_RESUMES; round++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        system: SYSTEM,
        messages,
        ...(tools ? { tools } : {}),
        // Second breakpoint: auto-caches the tail, so the next turn in this
        // same thread reuses everything up to here.
        cache_control: { type: "ephemeral" },
        // Adaptive thinking is on by default; effort is the speed/depth dial.
        output_config: { effort: "medium" },
        // If a safety classifier declines, retry server-side on a suitable model
        // instead of leaving the user with a dead end.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal }, // aborting cancels the HTTP request to the API
    );

    const toolInput = new Map<number, { name: string; json: string }>(); // server tool calls being streamed, by block index
    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "server_tool_use") {
            // Searches made from code (dynamic filtering) arrive with their input already filled in.
            const known = Object.keys(block.input ?? {}).length ? JSON.stringify(block.input) : "";
            if (known) yield { type: "status", text: describeTool(block.name, known) };
            else toolInput.set(event.index, { name: block.name, json: "" });
            toolSinceText = true;
          } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
            for (const r of block.content) seen.set(r.url, r.title);
          } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
            seen.set(block.content.url, block.content.content.title ?? new URL(block.content.url).hostname); // a page it read
          } else if (block.type === "text" && toolSinceText && wroteText) {
            // Writing again after a search: a new paragraph if the text before ended a
            // sentence, else carry on the sentence it paused in the middle of.
            const gap = /[.!?:)\]]\s*$|\n\s*$/.test(text) ? "\n\n" : /\s$/.test(text) ? "" : " ";
            if (gap) {
              text += gap;
              yield { type: "text", text: gap };
            }
            toolSinceText = false;
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta;
          if (d.type === "text_delta") {
            wroteText = true;
            text += d.text;
            yield { type: "text", text: d.text };
          } else if (d.type === "citations_delta" && d.citation.type === "web_search_result_location") {
            if (!cited.has(d.citation.url)) cited.set(d.citation.url, d.citation.title ?? "");
          } else if (d.type === "input_json_delta") {
            const t = toolInput.get(event.index);
            if (t) t.json += d.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const t = toolInput.get(event.index);
          if (t) yield { type: "status", text: describeTool(t.name, t.json) };
        }
      }
    } catch (e) {
      // Web search turned off for this organization (or unavailable): answer without it, once.
      if (tools && !wroteText && round === 0 && isWebToolError(e)) {
        tools = undefined;
        searchDisabled = true;
        round--;
        continue;
      }
      throw e;
    }

    const final = await stream.finalMessage();
    usage.input += final.usage.input_tokens;
    usage.cacheRead += final.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += final.usage.cache_creation_input_tokens ?? 0;
    usage.output += final.usage.output_tokens;
    usage.webSearches += final.usage.server_tool_use?.web_search_requests ?? 0;

    // A long server-side tool run paused the turn: send it back as-is and the API resumes it.
    if (final.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: final.content }];
      continue;
    }
    if (final.stop_reason === "refusal") yield { type: "text", text: REFUSAL_NOTE };
    if (final.stop_reason === "max_tokens") yield { type: "text", text: TRUNCATED_NOTE };
    break;
  }

  if (searchDisabled) yield { type: "text", text: "\n\n_(Answered without web search: it isn't enabled for this API key. Turn it on in the Anthropic Console, or switch it off in Settings.)_" };
  const sources = replySources(text, cited, seen);
  if (sources.length) yield { type: "sources", sources };
  return usage;
}

/**
 * The pages a reply used: ones it cited with markers, plus pages it searched or
 * read that it links to in its text (when results are read through code, as
 * with dynamic filtering, there are no markers, only the links it was asked to
 * write). Searched pages it didn't link to are left out.
 */
function replySources(text: string, cited: Map<string, string>, seen: Map<string, string>): Source[] {
  const out = new Map(cited);
  const norm = (u: string) => u.replace(/[#?].*$/, "").replace(/\/$/, "");
  const seenByUrl = new Map([...seen].map(([u, t]) => [norm(u), { url: u, title: t }]));
  for (const [, url] of text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) {
    const hit = seenByUrl.get(norm(url));
    if (hit && !out.has(hit.url)) out.set(hit.url, hit.title);
  }
  return [...out].map(([url, title]) => ({ url, title }));
}

/** "Searching: …" / "Reading …" for a server tool call, from its input. */
function describeTool(name: string, json: string): string {
  let input: { query?: string; url?: string } = {};
  try {
    input = JSON.parse(json || "{}");
  } catch {}
  if (name === "web_search") return input.query ? `Searching: ${input.query}` : "Searching the web";
  if (name === "web_fetch") {
    try {
      return `Reading ${new URL(input.url ?? "").hostname}`;
    } catch {
      return "Reading a page";
    }
  }
  return "Going through the results"; // code that filters search results (dynamic filtering)
}

/** The API rejected the web tools themselves (e.g. not enabled for the organization). */
function isWebToolError(e: unknown): boolean {
  return e instanceof Anthropic.APIError && e.status === 400 && /web[_ ]?(search|fetch)|server tool/i.test(e.message);
}

/** Marks the last inherited message so side threads share the main thread's cached prefix. */
function withForkBreakpoint({ messages, inheritedUntil }: BuiltContext): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m, i) => {
    if (i !== inheritedUntil) return m as Anthropic.Beta.BetaMessageParam;
    const blocks = (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) as Anthropic.Beta.BetaContentBlockParam[];
    return { role: m.role, content: blocks.map((b, j) => (j === blocks.length - 1 ? { ...b, cache_control: { type: "ephemeral" } } : b)) as Anthropic.Beta.BetaContentBlockParam[] };
  });
}

/** No API key? Reply with exactly what the model *would* have received. */
async function* streamMock({ messages, inheritedUntil }: BuiltContext, { signal, mock, webSearch }: StreamOptions): AsyncGenerator<ChatEvent, Usage | null> {
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
    });
  if (mock === "think") await wait(2000);
  // Pretend to search when asked to look something up, so the UI for it can be tried for free.
  const last = textOf(messages.at(-1)?.content ?? "");
  const searches = webSearch && /\b(search|look up|latest|news|current)\b/i.test(last);
  if (searches) {
    yield { type: "status", text: `Searching: ${last.replace(/\s+/g, " ").slice(0, 60)}` };
    await wait(800);
  }
  const lines = [
    `**Mock mode** (set \`ANTHROPIC_API_KEY\` in \`.env.local\` for real replies). This thread sent **${messages.length}** messages:`,
    "",
    ...messages.map((m, i) => {
      const preview = textOf(m.content).replace(/\s+/g, " ").slice(0, 80);
      const tag = i <= inheritedUntil ? " _(inherited)_" : "";
      return `${i + 1}. **${m.role}**${tag}: ${preview}`;
    }),
  ];
  for (const word of lines.join("\n").split(/(?<=\s)/)) {
    signal?.throwIfAborted();
    yield { type: "text", text: word };
    await new Promise((r) => setTimeout(r, 8));
  }
  if (searches) yield { type: "sources", sources: [{ url: "https://example.com/", title: "Example source" }] };
  return null;
}

/** A message's text, with its attached files named, e.g. "[image] [document: notes.pdf] What is this?" (mock replies). */
function textOf(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "document" ? `[document: ${b.title ?? "file"}]` : `[${b.type}]`))
    .join(" ");
}

export type CompleteOptions = {
  system: string;
  prompt: string;
  maxTokens: number;
  /** Placeholder text instead of an API call (dev testing, or no key). Streams slowly so it can be watched. */
  mock?: boolean;
  signal?: AbortSignal;
};

/**
 * One reply as a stream of text chunks, without the chat's caching setup: for
 * background jobs like summarizing a chat into a note.
 */
export async function* streamCompletion({ system, prompt, maxTokens, mock, signal }: CompleteOptions): AsyncGenerator<string> {
  if (!process.env.ANTHROPIC_API_KEY || mock) {
    for (const word of mockSummary(prompt).split(/(?<=\s)/)) {
      signal?.throwIfAborted();
      yield word;
      await new Promise((r) => setTimeout(r, 25));
    }
    return;
  }
  client ??= new Anthropic();
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort: "low" }, // summarizing doesn't need deep thinking; low is faster and cheaper
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal },
  );
  let any = false;
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      any = true;
      yield event.delta.text;
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal" || !any) throw new Error("The model declined to summarize this chat");
}

/** First line of each message in the transcript, as bullets; branch markers go on the first line mentioning their excerpt. */
function mockSummary(prompt: string): string {
  const lines = [...prompt.matchAll(/^(User|Assistant): (.+)$/gm)].map((m) => `- **${m[1]}:** ${m[2].slice(0, 100)}`);
  for (const [, marker, excerpt] of prompt.matchAll(/^(\{\{branch-\d+\}\}): highlighted "(.*)"$/gm)) {
    const i = lines.findIndex((l) => l.toLowerCase().includes(excerpt.toLowerCase()));
    if (i >= 0) lines[i] += ` ${marker}`;
  }
  const notes = `_(Mock summary: set \`ANTHROPIC_API_KEY\` for a real one.)_\n\n${lines.join("\n") || "- (empty chat)"}`;
  return /Start your reply with one line "Title: \.\.\."/.test(prompt) ? `Title: Mock title\n\n${notes}` : notes;
}

/** A short, whole reply from the fast model, for small jobs like naming a chat. */
export async function quickText({ system, prompt, maxTokens, mock }: Omit<CompleteOptions, "signal">): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY || mock) {
    const first = /^User: (.+)$/m.exec(prompt)?.[1] ?? "chat";
    return `Mock: ${first.split(/\s+/).slice(0, 4).join(" ")}`;
  }
  client ??= new Anthropic();
  const msg = await client.messages.create({ model: FAST_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] });
  return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

// ---------- the assistant beside a note ----------

const NOTE_SYSTEM = `You are the writing assistant inside Flow, a notes app. You help the user write, organize, and think through one Markdown note, which is given with each message.
When the user asks you to add to, change, reorganize, or brainstorm in the note, edit the note with the str_replace_based_edit_tool instead of writing the content in chat. Prefer focused edits (str_replace, insert); use create only to rewrite the whole note. Of existing notes, you can only edit this one.
When the user asks for new pages (or to split this note into pages), make each with create_note, then link to them from this note with [[Page name]] where they fit, using the exact name create_note reports. Only create pages when asked.
Notes this one links to with [[Page]] are included for context. To read any other note, use read_note with its name. Use web search when the user asks for facts you'd need to look up, and cite web pages with inline Markdown links.
After editing, reply with one short sentence saying what you changed (write page names plainly in the reply, without [[ ]]: [[links]] only work inside notes). Don't repeat the note's content back. If the user just asks a question, answer briefly without editing.
The note's Markdown supports headings, bullets, "- [ ]" tasks, tables, code blocks, [[Page]] links to other notes, and collapsible toggles written exactly like this (keep the blank lines):

<details>
<summary>Toggle title</summary>

Content inside the toggle
</details>
`;

const EDITOR_TOOL = { type: "text_editor_20250728" as const, name: "str_replace_based_edit_tool" as const };
/** Read another note in the vault (read-only). Streamed, so its input is checked before use. */
const READ_NOTE_TOOL = {
  name: "read_note",
  description: "Read another note in the user's notes, by name (as in a [[link]]) or by path. Read-only.",
  input_schema: { type: "object" as const, properties: { name: { type: "string", description: 'The note\'s name, like "Trip ideas", or its path, like "School/Biology.md".' } }, required: ["name"] },
  eager_input_streaming: true,
};
/** Make a new page (never overwrites). Its content can be long, so it streams; the input is checked before use. */
const CREATE_NOTE_TOOL = {
  name: "create_note",
  description:
    "Create a new note (page) in the user's notes with the given Markdown content. Creates only: it never changes an existing note (a taken name gets a number added). Returns the page's final name, to link to with [[name]].",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: 'The page name, like "Lisbon itinerary" (no .md).' },
      content: { type: "string", description: "The page's Markdown content." },
      folder: { type: "string", description: 'Folder to put it in, like "School". Leave out to use the current note\'s folder.' },
    },
    required: ["name", "content"],
  },
  eager_input_streaming: true,
};
const MAX_CREATED = 10; // pages per message
const MAX_STEPS = 12; // model turns per message: each round of edits, note reads, or a paused search

export type NoteTurn = { role: "user" | "assistant"; content: string | Anthropic.Beta.BetaContentBlockParam[] };

export type NoteAssistantInput = {
  history: NoteTurn[];
  message: string;
  /** Files sent with the message (image and document blocks). */
  files?: Anthropic.Beta.BetaContentBlockParam[];
  note: string;
  path: string;
  /** The linked notes' text and the other notes' names, sent with the message. */
  context: string;
  /** Read another note by name or path (null: no such note). */
  readNote: (name: string) => Promise<{ path: string; content: string } | null>;
  /** Create a new page (folder undefined: the current note's folder). Resolves with its path; throws a message the model can act on. */
  createNote: (name: string, content: string, folder?: string) => Promise<string>;
  webSearch?: boolean;
};

/**
 * Answer a message about a note, editing the note (in memory) with the text
 * editor tool, reading other notes, and searching the web as needed. Streams
 * reply text, status ("Editing the note", "Reading …", "Searching: …"), the
 * note's new text after each edit, and the web pages cited; returns the final note.
 */
export async function* streamNoteAssistant(
  { history, message, files = [], note, path, context, readNote, createNote, webSearch }: NoteAssistantInput,
  { signal, mock }: Omit<StreamOptions, "webSearch"> = {},
): AsyncGenerator<ChatEvent, { note: string; changed: boolean }> {
  if (!process.env.ANTHROPIC_API_KEY || mock) return yield* mockNoteAssistant(message, note, context, files.length, createNote);
  client ??= new Anthropic();
  let current = note;
  let changed = false;
  let wroteText = false;
  let afterTool = false;
  let text = "";
  const cited = new Map<string, string>();
  const seen = new Map<string, string>();
  let tools: Anthropic.Beta.BetaToolUnion[] = [EDITOR_TOOL, READ_NOTE_TOOL, CREATE_NOTE_TOOL, ...(webSearch ? WEB_TOOLS : [])];
  let created = 0;
  let searchDisabled = false;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    // Files first (images before text reads best), then the notes, then what the user asked.
    { role: "user", content: [...files, { type: "text", text: `${context}<note path="/${path}">\n${note}\n</note>\n\n${message || "(See the attached files.)"}` }] },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        system: NOTE_SYSTEM,
        messages,
        tools,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    const toolInput = new Map<number, { name: string; json: string }>(); // tool calls whose input is still streaming
    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            afterTool = true;
            if (block.name === "str_replace_based_edit_tool") yield { type: "status", text: "Editing the note" };
            else toolInput.set(event.index, { name: block.name, json: "" });
          } else if (block.type === "server_tool_use") {
            afterTool = true;
            const known = Object.keys(block.input ?? {}).length ? JSON.stringify(block.input) : "";
            if (known) yield { type: "status", text: describeTool(block.name, known) };
            else toolInput.set(event.index, { name: block.name, json: "" });
          } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
            for (const r of block.content) seen.set(r.url, r.title);
          } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
            seen.set(block.content.url, block.content.content.title ?? new URL(block.content.url).hostname);
          } else if (block.type === "text" && afterTool && wroteText) {
            const gap = /[.!?:)\]]\s*$|\n\s*$/.test(text) ? "\n\n" : /\s$/.test(text) ? "" : " ";
            if (gap) {
              text += gap;
              yield { type: "text", text: gap };
            }
            afterTool = false;
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta;
          if (d.type === "text_delta") {
            wroteText = true;
            text += d.text;
            yield { type: "text", text: d.text };
          } else if (d.type === "citations_delta" && d.citation.type === "web_search_result_location") {
            if (!cited.has(d.citation.url)) cited.set(d.citation.url, d.citation.title ?? "");
          } else if (d.type === "input_json_delta") {
            const t = toolInput.get(event.index);
            if (t) t.json += d.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const t = toolInput.get(event.index);
          if (t?.name === "read_note") yield { type: "status", text: `Reading ${readNoteName(t.json) ?? "a note"}` };
          else if (t?.name === "create_note") yield { type: "status", text: `Creating ${readNoteName(t.json) ?? "a page"}` };
          else if (t) yield { type: "status", text: describeTool(t.name, t.json) };
        }
      }
    } catch (e) {
      // Web search not enabled for this organization: carry on without it, once.
      if (webSearch && !searchDisabled && step === 0 && !wroteText && isWebToolError(e)) {
        tools = [EDITOR_TOOL, READ_NOTE_TOOL, CREATE_NOTE_TOOL];
        searchDisabled = true;
        step--;
        continue;
      }
      throw e;
    }

    const final = await stream.finalMessage();
    // A long server-side search paused the turn: send it back as-is and the API resumes it.
    if (final.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: final.content });
      continue;
    }
    const calls = final.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (final.stop_reason !== "tool_use" || !calls.length) {
      if (final.stop_reason === "refusal") yield { type: "text", text: REFUSAL_NOTE };
      if (final.stop_reason === "max_tokens") yield { type: "text", text: TRUNCATED_NOTE };
      break;
    }
    // Run each call (edits on the note in memory, reads of other notes) and report back to the model.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      if (call.name === "str_replace_based_edit_tool") {
        const r = applyEdit(current, call.input as EditInput);
        if (r.changed) {
          current = r.note;
          changed = true;
          yield { type: "note", content: current };
        }
        results.push({ type: "tool_result", tool_use_id: call.id, content: r.output, ...(r.error ? { is_error: true } : {}) });
      } else if (call.name === "read_note") {
        // The input was streamed (eager_input_streaming): check it before using it.
        const name = (call.input as { name?: unknown })?.name;
        if (typeof name !== "string" || !name.trim()) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: "read_note needs a note name, as a string.", is_error: true });
          continue;
        }
        const found = await readNote(name);
        results.push(
          found
            ? { type: "tool_result", tool_use_id: call.id, content: `<note path="/${found.path}">\n${found.content.slice(0, 40000)}\n</note>` }
            : { type: "tool_result", tool_use_id: call.id, content: `No note named "${name}". Check the list of notes.`, is_error: true },
        );
      } else if (call.name === "create_note") {
        // Streamed input too: check every field before creating anything.
        const { name, content, folder } = (call.input ?? {}) as { name?: unknown; content?: unknown; folder?: unknown };
        if (typeof name !== "string" || !name.trim() || typeof content !== "string" || (folder !== undefined && typeof folder !== "string")) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: "create_note needs a name and content (strings), and optionally a folder (string).", is_error: true });
          continue;
        }
        if (created >= MAX_CREATED) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: `That's the limit of ${MAX_CREATED} new pages per message.`, is_error: true });
          continue;
        }
        try {
          const made = await createNote(name, content, folder?.trim() || undefined);
          created++;
          yield { type: "created", path: made };
          const finalName = made.split("/").pop()!.replace(/\.md$/i, "");
          results.push({ type: "tool_result", tool_use_id: call.id, content: `Created "${finalName}" (/${made}). Link to it from the note with [[${finalName}]].` });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: `Couldn't create the page: ${e instanceof Error ? e.message : "unknown error"}`, is_error: true });
        }
      } else {
        results.push({ type: "tool_result", tool_use_id: call.id, content: `Unknown tool ${call.name}.`, is_error: true });
      }
    }
    messages.push({ role: "assistant", content: final.content }, { role: "user", content: results });
  }

  if (searchDisabled) yield { type: "text", text: "\n\n_(Answered without web search: it isn't enabled for this API key.)_" };
  const sources = replySources(text, cited, seen);
  if (sources.length) yield { type: "sources", sources };
  return { note: current, changed };
}

/** The page name from read_note's or create_note's streamed input, once it's complete. */
function readNoteName(json: string): string | null {
  try {
    const name = (JSON.parse(json) as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** No API key (or dev mock): pretend to edit when asked to change the note, so the UI can be tried for free. */
async function* mockNoteAssistant(
  message: string,
  note: string,
  context: string,
  fileCount = 0,
  createNote?: NoteAssistantInput["createNote"],
): AsyncGenerator<ChatEvent, { note: string; changed: boolean }> {
  const linked = [...context.matchAll(/<note path="\/([^"]+)">/g)].map((m) => m[1]);
  for (const p of linked) {
    yield { type: "status", text: `Reading ${p.replace(/\.md$/i, "")}` };
    await new Promise((r) => setTimeout(r, 300));
  }
  const edits = /\b(add|toggle|edit|change|move|put|write|brainstorm|list)\b/i.test(message);
  let current = note;
  if (edits) {
    yield { type: "status", text: "Editing the note" };
    await new Promise((r) => setTimeout(r, 600));
    current = `${note.replace(/\s*$/, "")}\n\n- (mock edit) ${message.slice(0, 60)}\n`;
    yield { type: "note", content: current };
  }
  // Asked for a page: make one and link it, like the real assistant would.
  let made = "";
  if (createNote && /\bpages?\b/i.test(message)) {
    yield { type: "status", text: "Creating Mock page" };
    await new Promise((r) => setTimeout(r, 400));
    const path = await createNote("Mock page", `# Mock page\n\nCreated by the mock assistant for: ${message.slice(0, 80)}\n`);
    yield { type: "created", path };
    made = path.split("/").pop()!.replace(/\.md$/i, "");
    current = `${current.replace(/\s*$/, "")}\n\n- See [[${made}]]\n`;
    yield { type: "note", content: current };
  }
  const saw = (linked.length ? ` I could see the linked notes: ${linked.join(", ")}.` : "") + (fileCount ? ` You attached ${fileCount} file${fileCount > 1 ? "s" : ""}.` : "");
  const did = made ? `created [[${made}]] and linked it.` : edits ? "added a line to the end of the note." : "";
  const reply = (did ? `**Mock mode:** ${did}` : "**Mock mode:** set `ANTHROPIC_API_KEY` for real answers.") + saw;
  for (const word of reply.split(/(?<=\s)/)) {
    yield { type: "text", text: word };
    await new Promise((r) => setTimeout(r, 15));
  }
  return { note: current, changed: edits || !!made };
}
