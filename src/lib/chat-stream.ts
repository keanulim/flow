import { api, devMockHeader } from "./client";
import { type ChatEvent, type Source, WEB_SEARCH_KEY } from "./shared";

/**
 * Send to a chat endpoint (/api/chat, or the note assistant's) and read the
 * streamed reply: newline-delimited JSON events (text, what the model is doing,
 * sources, a changed note). Calls the handlers as events arrive and resolves
 * with the whole reply. Throws like fetch (an abort rejects).
 */
export async function postChat(
  body: Record<string, unknown>,
  handlers: { onText: (text: string) => void; onStatus: (text: string) => void; onNote?: (content: string) => void },
  signal?: AbortSignal,
  url = "/api/chat",
): Promise<{ text: string; sources: Source[] }> {
  const res = await api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...devMockHeader() },
    body: JSON.stringify({ webSearch: webSearchOn(), ...body }),
    signal,
  });
  // One JSON event per line; a line can arrive split across chunks.
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  let sources: Source[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const e = JSON.parse(line) as ChatEvent;
      if (e.type === "text") {
        text += e.text;
        handlers.onText(e.text);
      } else if (e.type === "status") {
        handlers.onStatus(e.text);
      } else if (e.type === "note") {
        handlers.onNote?.(e.content);
      } else {
        sources = e.sources;
      }
    }
  }
  return { text, sources };
}

/** The web search setting (Settings > AI); on unless turned off. */
function webSearchOn(): boolean {
  try {
    return localStorage.getItem(WEB_SEARCH_KEY) !== "off";
  } catch {
    return true;
  }
}
