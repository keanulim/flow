# Flow

An AI chat app built around one annoying problem: you're deep in a conversation, something in a reply catches your eye, you ask about it, and now the whole chat has wandered off. Twenty messages later the thing you actually cared about is buried.

Flow lets you go on tangents without wrecking the main thread. And because the good stuff from a chat usually deserves to live somewhere, it comes with a notes app (Obsidian-style, plain Markdown files) that the AI can read and write.

## The idea: conversations are trees

Every chat in Flow is a tree, not a line.

- **Highlight anything in a reply and press `⌘K`.** A side panel opens where you can ask about just that bit. The highlight stays in the reply as a link back to your side question.
- **The main thread never sees your tangents.** A side question gets the conversation up to where you branched, plus the excerpt you highlighted, and nothing after. The main thread carries on as if you never left. This is the core of the app (`src/lib/context.ts`, tested by `npm run test:context`).
- **Quick questions stay quick.** Side questions start as one-offs and stay out of your way. If one turns into something worth keeping, hit **Save to map** and it becomes a real branch you can branch from again.
- **The map shows where you are.** The sidebar draws the conversation as a tree with your current path lit up. Click it and move around with WASD.

Branching is also cheap. Side threads share the main thread's prompt cache up to the fork point, so asking on the side doesn't mean paying to resend the whole conversation.

## Chats

The chat itself has the things you'd expect, plus a few you'd want:

- **Web search.** Claude searches and reads pages when it needs to, and the sources show up as chips under the reply. You can turn it off in Settings.
- **Attachments.** Drop in images, PDFs or text and code files, paste a screenshot, or use the paperclip. Big images get shrunk in the browser first, since every image is resent with each later message.
- **Math.** LaTeX renders properly (`$x^2$`, `$$…$$`, `\(…\)`). "$5 and $10" still reads as money, not a formula.
- **Code** gets syntax highlighting and a copy button.
- **Auto titles.** Chats and branches get named by what they're actually about.
- **Retry** shows up only when a reply went wrong (an error, a stop, a cut-off). There's no point rerolling a good answer.

## Notes

On the Home side there's a notes app that works on a folder of Markdown files, so it plays nicely with Obsidian. Point `FLOW_VAULT_PATH` at an existing vault and it just works.

- **Tabs.** Double-click a note (or right-click → Open in new tab) to open it in a tab of its own. A plain click opens it in the current tab, like Obsidian. Drag tabs to reorder them.
- **Live preview editing.** One editor, no edit/preview toggle. Markdown renders as you type and the raw syntax shows up only on the line you're editing. Tables, task lists, code blocks and math all render.
- **`[[Links]]` between notes**, with suggestions as you type `[[`. You can also link to chats, which show up in light red with a line on top.
- **Toggles.** Start a line with `/>` to make a collapsible section.
- **Images.** Paste or drop an image into a note. It's saved next to the note as a real file and embedded as `![[Pasted image ….png]]`, the same way Obsidian does it.
- **Turn a chat into a note.** Hit **Make note** on a chat and watch it write itself: a summary of the main thread, with branches and side questions folded in as toggles right where they came up.

### The note assistant

The λ button in the bottom right opens an AI panel beside your notes. It's one conversation, separate from your chats, that stays put as you move between notes. It always knows which note you have open and can actually **edit it**: reorganize it, add to it, brainstorm into it. You can watch the edits land live, and **Undo changes** puts it back.

It also knows what's around the note:
- notes linked with `[[…]]` are sent along automatically,
- it can read any other note in your vault (read-only, it only ever edits the open one),
- it can search the web, and you can attach files to it too.

## Running it

```bash
npm install
cp .env.local.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev
```

Then open http://localhost:3000.

**No API key? Everything still runs.** Without one, Flow uses a mock model. Every reply lists exactly which messages its thread sent, which turns out to be a nice way to see the context isolation working. With a key set, you can still force the mock for free testing by running `localStorage.setItem("flow.mock", "1")` in the browser console.

Your data stays local. Chats live in SQLite (`data/flow.db`), uploads in `data/attachments/`, and notes in `data/vault/` (or your own vault). All of it is git-ignored.

## Public demo

Flow has a demo mode for sharing it with people (say, on a resume) without your API key or your notes:

- **AI replies are simulated**, always, even if an API key is set. The demo can't cost anything.
- **Every visitor gets a private sandbox** seeded with sample chats and notes (from `demo/`), so nobody sees anyone else's changes. Sandboxes live in temporary storage and are deleted after 6 hours unused.

Turn it on with the environment variable `FLOW_DEMO=1`.

**Deploying to Vercel:**

1. Import the GitHub repo at [vercel.com/new](https://vercel.com/new) and add the environment variable `FLOW_DEMO` = `1`. *Don't* add `ANTHROPIC_API_KEY`.
2. Add a free **Upstash Redis** database from the project's **Storage** tab (Vercel Marketplace) and connect it to the project. It sets the `KV_REST_API_URL` / `KV_REST_API_TOKEN` variables Flow looks for.
3. Redeploy. Every push to `main` redeploys after that.

Why Redis: Vercel runs several copies of the server, each with its own temporary disk, and a visitor's requests can land on any of them. The real copy of each sandbox lives in Redis (about 70 KB each); each server's disk is just a cache of it. Without Redis, a visitor would see their changes come and go.

To try demo mode locally without disturbing the dev server:

```bash
NEXT_DIST_DIR=.next-demo FLOW_DEMO=1 npx next build && NEXT_DIST_DIR=.next-demo FLOW_DEMO=1 npx next start -p 3001
```

## Keyboard

The full list is in Settings (`⌘,`). The ones you'll actually use:

| Key | What it does |
|---|---|
| `⌘K` | In a chat: ask on the side about the highlight (or the latest reply). In a note: link the selection to a page |
| `Esc` / `⇧Esc` | Close the side panel and go up a level / jump back to the main thread |
| `⌥↑` `⌥↓` | Flip between side threads |
| `⌘\` | Show or hide the side panel |
| `W A S D` | Move around the map (click the sidebar first) |
| `[[` | Link to a note or chat |
| `⌘⌥←` | Back to the note you came from |

Right-click handles the rest: renaming and deleting chats and files, linking a highlight to a page.

## Under the hood

Built with Next.js 15, React 19, TypeScript, Tailwind 4, SQLite (better-sqlite3), CodeMirror 6 and the Anthropic SDK. Everything runs on Claude Haiku 5.5 (fast and cheap); switching to Sonnet is one line in `src/lib/llm.ts`.

If you want to poke around:

| File | What's in it |
|---|---|
| `src/lib/context.ts` | What each thread gets to see: the tree-walking that keeps tangents out of the main thread |
| `src/lib/llm.ts` | Streaming from Claude, web tools, prompt caching, and the note assistant's editing loop |
| `src/lib/live-markdown.ts` | The live-preview editor (CodeMirror decorations) |
| `src/lib/wikilinks.ts` | `[[links]]`, chat links, image embeds, paste and drop |
| `src/lib/toggles.ts` | Collapsible toggles in notes |
| `src/lib/math.ts` | Telling math dollars from money dollars |
| `src/lib/rehype-anchors.ts` | Turning highlighted excerpts into clickable marks in rendered replies |

Tests are plain scripts: `npm run test:context`, `test:notes`, `test:math`, `test:toggles`, `test:note-edit` and `test:chat-note`.
