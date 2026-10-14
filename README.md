# Flow

An AI chat interface built for flow state. Ask side questions without cluttering the main conversation, and always know where you are.

## Features

- **Ask on the side.** Highlight any part of a reply and press `⌘K` to ask about it in a side panel. The highlight (dashed) becomes a link back to that question. Side questions stay out of the map until you press **Save to map**.
- **Context isolation.** The main thread never sees side questions. A side thread sees the main history up to where it branched, plus the excerpt, and nothing after.
- **Nested threads.** Save a side question to the map, then branch from inside it: it moves to the center, with breadcrumbs back to main.
- **Map.** The sidebar shows the conversation as a tree with your current path lit up. Click the sidebar and move with WASD: `W`/`S` for siblings, `A` for parent, `D` for child. Set it to show only your path, or every thread.

## Running it

```bash
npm install
cp .env.local.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev
```

Without an API key, Flow runs in mock mode. Each reply lists exactly what context its thread sent, which is useful for checking isolation.

## Keyboard

| Key | Action |
|---|---|
| `⌘K` | Ask on the side (about the highlight, or the latest reply) |
| `Esc` | Close the side panel, then go up a level |
| `⇧Esc` | Back to main |
| `⌥↑` / `⌥↓` | Switch side threads |
| `⌘\` | Toggle the side panel |
| WASD / arrows | Move through the map (after clicking the sidebar) |

## How it works

- `src/lib/context.ts` builds what each thread sends to the model by walking up the thread tree. Run `npm run test:context` to check the isolation rules.
- `src/lib/llm.ts` streams from Claude (`claude-opus-5-5`). It places a prompt-cache breakpoint at the fork point, so side threads reuse the main thread's cached prefix.
- `src/lib/db.ts` stores threads and messages in SQLite (`data/flow.db`, git-ignored).
- `src/lib/rehype-anchors.ts` turns highlighted excerpts into clickable marks inside rendered Markdown, including excerpts that span formatting.

Stack: Next.js 15, React 19, TypeScript, Tailwind 4, better-sqlite3, Anthropic SDK.
