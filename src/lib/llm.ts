import Anthropic from "@anthropic-ai/sdk";
import type { BuiltContext } from "./context";

export const MODEL = "claude-sonnet-5-5";

// Frozen on purpose: the system prompt is the first thing in the cached
// prefix, so any change to it (timestamps, per-request ids) would invalidate
// the cache for every thread.
const SYSTEM = `You are Flow, an assistant built to keep the user in a state of focus.
Some user messages are side questions about an excerpt of an earlier reply. Answer those directly and compactly. The user will return to the main thread afterward, so don't recap the main topic.
Use Markdown formatting.`;

export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };

export type StreamOptions = {
  /** Use the free mock reply even if an API key is set (dev testing).
   *  "think" adds a 2s pause before the first chunk, like the model's thinking phase. */
  mock?: boolean | "think";
  /** Aborting it stops generation (and billing) mid-reply. */
  signal?: AbortSignal;
};

/** Streams the reply as text chunks; returns token usage when done. */
export function streamReply(ctx: BuiltContext, opts: StreamOptions = {}): AsyncGenerator<string, Usage | null> {
  return process.env.ANTHROPIC_API_KEY && !opts.mock ? streamClaude(ctx, opts) : streamMock(ctx, opts);
}

// Created on first use, not at import: if the key is added to .env.local while
// the dev server is running, a client built at import time would have no key.
let client: Anthropic | undefined;

async function* streamClaude(ctx: BuiltContext, { signal }: StreamOptions): AsyncGenerator<string, Usage | null> {
  const messages = withForkBreakpoint(ctx);

  client ??= new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    system: SYSTEM,
    messages,
    // Second breakpoint: auto-caches the tail, so the next turn in this
    // same thread reuses everything up to here.
    cache_control: { type: "ephemeral" },
    // Adaptive thinking is on by default; effort is the speed/depth dial.
    output_config: { effort: "medium" },
    // If a safety classifier declines, retry server-side on a suitable model
    // instead of leaving the user with a dead end.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  }, { signal }); // aborting cancels the HTTP request to the API

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") yield "\n\n_The model declined to answer this one._";
  if (final.stop_reason === "max_tokens") yield "\n\n_[reply truncated: hit max_tokens]_";
  return {
    input: final.usage.input_tokens,
    cacheRead: final.usage.cache_read_input_tokens ?? 0,
    cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
    output: final.usage.output_tokens,
  };
}

/** Marks the last inherited message so side threads share the main thread's cached prefix. */
function withForkBreakpoint({ messages, inheritedUntil }: BuiltContext): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m, i) =>
    i === inheritedUntil
      ? {
          role: m.role,
          content: [{ type: "text", text: String(m.content), cache_control: { type: "ephemeral" } }],
        }
      : (m as Anthropic.Beta.BetaMessageParam),
  );
}

/** No API key? Reply with exactly what the model *would* have received. */
async function* streamMock({ messages, inheritedUntil }: BuiltContext, { signal, mock }: StreamOptions): AsyncGenerator<string, Usage | null> {
  if (mock === "think") {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 2000);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
    });
  }
  const lines = [
    `**Mock mode** (set \`ANTHROPIC_API_KEY\` in \`.env.local\` for real replies). This thread sent **${messages.length}** messages:`,
    "",
    ...messages.map((m, i) => {
      const preview = String(m.content).replace(/\s+/g, " ").slice(0, 80);
      const tag = i <= inheritedUntil ? " _(inherited)_" : "";
      return `${i + 1}. **${m.role}**${tag}: ${preview}`;
    }),
  ];
  for (const word of lines.join("\n").split(/(?<=\s)/)) {
    signal?.throwIfAborted();
    yield word;
    await new Promise((r) => setTimeout(r, 8));
  }
  return null;
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
