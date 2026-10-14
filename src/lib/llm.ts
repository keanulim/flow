import Anthropic from "@anthropic-ai/sdk";
import type { BuiltContext } from "./context";

export const MODEL = "claude-opus-5-5";

// Frozen on purpose: the system prompt is the first thing in the cached
// prefix, so any change to it (timestamps, per-request ids) would invalidate
// the cache for every thread.
const SYSTEM = `You are Flow, an assistant built to keep the user in a state of focus.
Some user messages are side questions about an excerpt of an earlier reply. Answer those directly and compactly. The user will return to the main thread afterward, so don't recap the main topic.
Use Markdown formatting.`;

export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };

/** Streams the reply as text chunks; returns token usage when done. */
export function streamReply(ctx: BuiltContext): AsyncGenerator<string, Usage | null> {
  return process.env.ANTHROPIC_API_KEY ? streamClaude(ctx) : streamMock(ctx);
}

const client = new Anthropic();

async function* streamClaude(ctx: BuiltContext): AsyncGenerator<string, Usage | null> {
  const messages = withForkBreakpoint(ctx);

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    system: SYSTEM,
    messages,
    // Second breakpoint: auto-caches the tail, so the next turn in this
    // same thread reuses everything up to here.
    cache_control: { type: "ephemeral" },
    // Opus 5.5 always uses adaptive thinking; effort is the speed/depth dial.
    // medium is this model's default, set explicitly so it's easy to tune.
    output_config: { effort: "medium" },
    // If a safety classifier declines, retry server-side on a suitable model
    // instead of leaving the user with a dead end.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

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
async function* streamMock({ messages, inheritedUntil }: BuiltContext): AsyncGenerator<string, Usage | null> {
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
    yield word;
    await new Promise((r) => setTimeout(r, 8));
  }
  return null;
}
