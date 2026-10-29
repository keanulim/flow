# Flow: the project guide

A learning companion for this codebase: what Flow is, how every piece works, why it was built that way, what broke along the way, and what's next. It's written to be read top to bottom once, then used as a reference.

> **Keeping it current:** when you add a feature, add a line to [the log](#12-build-log), a row to the [code map](#7-code-map) if there's a new file, and anything you learned to [lessons](#10-bugs-and-lessons).

---

## Contents

1. [What Flow is](#1-what-flow-is)
2. [Running it](#2-running-it)
3. [The big picture](#3-the-big-picture)
4. [Core concepts, explained](#4-core-concepts-explained)
5. [Features, by area](#5-features-by-area)
6. [Data: where everything lives](#6-data-where-everything-lives)
7. [Code map](#7-code-map)
8. [API routes](#8-api-routes)
9. [Tests](#9-tests)
10. [Bugs and lessons](#10-bugs-and-lessons)
11. [Decisions and trade-offs](#11-decisions-and-trade-offs)
12. [Build log](#12-build-log)
13. [Ideas backlog](#13-ideas-backlog)
14. [Glossary](#14-glossary)

---

## 1. What Flow is

An AI chat app built for staying in flow, plus an Obsidian-style notes app, in one place.

**The problem:** in a normal AI chat, asking about something in a reply ("wait, what does *idempotent* mean?") drags the whole conversation sideways. Twenty messages later, the thing you cared about is buried, and the model's context is cluttered with tangents.

**Flow's answer:** conversations are **trees**, not lines. Highlight anything in a reply and ask about it on the side. The side question gets the context it needs, the main thread never sees it, and you return to exactly where you were.

**The second half:** the useful parts of chats deserve to live somewhere. Flow has a notes app that works on plain Markdown files (compatible with Obsidian), can turn a whole chat tree into a structured note, and has an AI assistant beside every note that can edit it, read your other notes, search the web, and create new pages.

**Stack:** Next.js 15 (App Router), React 19, TypeScript, Tailwind 4, SQLite (better-sqlite3), CodeMirror 6, the Anthropic SDK. About 9,000 lines.

**Models:** everything runs on **Claude Haiku 5.5** (`claude-haiku-5-5`): replies, notes, the assistant and titles. It's set at the top of `src/lib/llm.ts`. To switch back to Sonnet 5.5 for higher quality, change `MODEL` there; Sonnet can also use the newer web tools (dynamic filtering) and a server-side fallback when a reply is declined, which Haiku doesn't have.

---

## 2. Running it

```bash
npm install
cp .env.local.example .env.local   # then add ANTHROPIC_API_KEY=...
npm run dev                        # http://localhost:3000
```

| Setting | Where | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | `.env.local` | Real model replies. Without it, everything runs on a free mock. |
| `FLOW_VAULT_PATH` | `.env.local` | Point the notes app at an existing folder (e.g. your Obsidian vault). Default: `data/vault`. |
| `FLOW_DB_PATH` | `.env.local` | Where the SQLite database goes. Default: `data/flow.db`. |
| `flow.mock` | browser `localStorage` | `"1"` forces the free mock even with a key (dev only); `"think"` adds a 2s pause first. |

**Mock mode** is a real feature, not just a fallback: each mock reply lists exactly which messages its thread sent to the "model", which is how you can *see* context isolation working. The note assistant's mock also pretends to edit, read linked notes and create pages, so the whole UI can be tried for free.

**Checks** (run all before committing):

```bash
npx tsc --noEmit        # types
npm run lint            # eslint
npm run test:context    # and the other test:* scripts, see section 9
```

---

## 3. The big picture

```
 Browser (React)                                     Server (Next.js route handlers)
 ─────────────────                                   ───────────────────────────────
 Flow.tsx  ── the app shell: state + wiring
  ├─ Sidebar ── Home / Chats / Files, lists, map
  ├─ ThreadPane ── center chat ──┐
  ├─ SidePanel ── side threads ──┤ POST /api/chat ──▶ chat/route.ts
  │                              │   (NDJSON stream)    ├─ context.ts   builds what the model sees
  │                              │                      ├─ attachments  reads files into blocks
  │                              │                      ├─ llm.ts       streams from Claude
  │                              │◀── text/status/sources events
  ├─ NoteEditor ── CodeMirror ───┤ GET/PUT /api/files/content ──▶ vault.ts (files on disk)
  └─ AssistantPanel ─────────────┘ POST /api/notes/assist ──▶ llm.ts tool loop
                                                             (edit / read / create / web)
 hooks/: useConversation, useStreaming, useVault, useChatIndex
                                          SQLite (db.ts): threads, messages, note chats
                                          Disk: data/vault (notes, images), data/attachments
```

**One request, end to end (sending a chat message):**

1. You press Enter. `useStreaming.send` shows your message immediately (an "optimistic" temp message) and POSTs to `/api/chat` with ids it chose itself.
2. `chat/route.ts` saves your message, then `buildContext` walks the thread tree to decide what the model sees, and `attachFiles` reads any attached files in.
3. `streamReply` (in `llm.ts`) calls Claude with streaming on. Each piece of text, each "Searching: …" status, and the final list of sources goes back as one JSON object per line.
4. The browser reads those lines (`chat-stream.ts`), buffers text into one React update per animation frame, and fades each new chunk in.
5. When the stream ends, the server saves the reply and (for a new thread) writes a title with Haiku. The browser swaps its temp messages for the saved ones by id, with no refetch.

---

## 4. Core concepts, explained

### 4.1 Conversations are trees (context isolation)

**File:** `src/lib/context.ts` · **Test:** `npm run test:context`

Each **thread** has an optional parent and a fork point (the message it branched from) plus, usually, an anchor (the highlighted text). The rule for what the model sees:

| Thread | Sees |
|---|---|
| Main thread | Only its own messages. Side questions never leak in. |
| Side thread | The parent's messages **up to and including the fork point**, then its own. The highlighted excerpt is folded into its first question. |
| Side of a side | Recursively: its parent's whole lineage up to the fork, then its own. |

The stored message stays exactly what you typed; the "This is a side question about this excerpt…" framing is added only when building the request. `context.ts` touches neither the database nor the network, which is why it's easy to test with in-memory data.

**One-offs vs. saved branches:** side questions start as **one-offs** (`kind: "oneoff"`): quick, dashed, kept out of the map. **Save to map** promotes one to a real branch (`kind: "thread"`) that you can branch from again. Branching from inside the side panel promotes that thread to the center, so you only ever see two levels at once.

### 4.2 Streaming (and why it doesn't stutter)

**Files:** `llm.ts`, `chat/route.ts`, `chat-stream.ts`, `useStreaming.ts`, `rehype-fade.ts`

- **NDJSON:** the server sends newline-delimited JSON events: `text`, `status` ("Searching: …"), `sources`, and for the assistant `note` (the note's new text) and `created` (a new page). A line can arrive split across network chunks, so the reader keeps a buffer and only parses complete lines.
- **One render per frame:** tokens arrive far faster than the screen refreshes. `useStreaming` buffers them and applies them with `requestAnimationFrame`, so at most about 60 renders a second. There's also a 50ms `setTimeout` fallback, because some windows report as visible but never paint, and rAF would never fire there.
- **Fade-in:** `rehype-fade` wraps each arrival of text in its own `<span class="stream-chunk">`. React keys spans by position, so old chunks keep their spans and don't re-animate; only the newest one fades.
- **Memoized bubbles:** rendering Markdown is the most expensive thing on screen, so `Bubble` is `memo`ized with a custom comparison. Finished messages don't re-render on every token.
- **Stop = stop billing:** the Stop button aborts the fetch; the server sees the disconnect and aborts the model call, which stops generation (and cost). A stopped reply is saved with `_(stopped)_`, so the model knows next turn that it was cut off.

### 4.3 Prompt caching

**File:** `llm.ts` (`withForkBreakpoint`)

Claude can cache a prompt's **prefix**, and later requests that start with the exact same bytes read it from the cache at a fraction of the cost.

- The system prompt is frozen (no timestamps or ids in it), since any change there would break the cache for every thread.
- A **top-level `cache_control`** caches the tail of each request, so the next turn in the same thread reuses everything before it.
- A **breakpoint at the fork point** means a side thread's request starts with the exact bytes of the main thread up to where it branched, so asking on the side reuses the main thread's cache instead of paying for it again.

### 4.4 Web search and reading pages

**File:** `llm.ts` (`WEB_TOOLS`, `describeTool`, `replySources`)

These are **server tools**: Anthropic runs them, and the model decides when to search or fetch. Flow uses the newer versions with **dynamic filtering** (the model writes code to filter results before they enter its context, which keeps replies cheaper). The details:

- **Caps:** `max_uses` is 5 searches and 3 page reads per reply.
- **`pause_turn`:** a long run of searches can pause the turn. The loop sends it back as-is and the API resumes, up to 4 times.
- **Sources:** with dynamic filtering there are no citation markers, so sources come from the links in the reply that match pages the model actually searched or read.
- **Fallback:** if web tools aren't enabled for the API key, the request is retried once without them, and the reply says so.
- **The setting** lives in Settings, stored in `localStorage`, and is sent with each message.

### 4.5 Tool use: the note assistant's loop

**File:** `llm.ts` (`streamNoteAssistant`) · **Route:** `api/notes/assist/route.ts`

The assistant beside a note is an **agent loop**: call the model, run any tools it asked for, send the results back, and repeat until it stops asking (at most 12 steps). Its tools:

| Tool | Kind | What it does |
|---|---|---|
| `str_replace_based_edit_tool` | Anthropic's text editor tool | Edits the open note **in memory** (`note-edit.ts`): view, str_replace, insert, create. The path the model gives is ignored, so it can only ever touch this note. |
| `read_note` | custom | Reads any other note by name or path. Read-only. |
| `create_note` | custom | Makes a new page. **Create-only**: never overwrites; a taken name gets a number. Max 10 per message. |
| `web_search`, `web_fetch` | server | Same as in chats. |

Key ideas worth knowing:

- **Edits happen in memory, then save once.** Each edit streams the note's new text to the browser (`note` event), so you watch it change live while the editor is read-only. The file is written when the turn ends.
- **Eager input streaming:** custom tools set `eager_input_streaming: true`, so long inputs (like a page's content) stream in instead of arriving in one burst. The catch: the SDK's tolerant parser can hand back a **truncated** input, so the code checks every field's type before running a tool, and sends an error back to the model if it's wrong.
- **Context it gets:** the notes this one links to with `[[…]]` (up to 8, 12,000 characters each, 60,000 in total), plus the names of up to 300 other notes, so it knows what it can `read_note`.
- **Undo:** the panel keeps the note from before the reply and the paths it created. Undo restores the note and moves the new pages to the vault's trash.

### 4.6 The live-preview editor

**Files:** `live-markdown.ts`, `wikilinks.ts`, `toggles.ts`, `MarkdownEditor.tsx`

The file stays **plain Markdown**; only how it's displayed changes. CodeMirror 6 does this with **decorations**:

- `Decoration.replace` hides syntax (the `#` of a heading, `**` around bold) or swaps it for a **widget** (a bullet, a checkbox, a table, a rendered formula, an image).
- `Decoration.line` styles whole lines (headings, code blocks, gaps between blocks).
- `Decoration.mark` styles ranges (links, inline code).

The trick that makes it feel like Obsidian: **markup hides everywhere except on the line the cursor is on**, where the raw text comes back so it can be edited.

Two ways to provide decorations, both used here:

- **StateField** (`livePreview`): computed from the document state. Required for decorations that replace line breaks, like a whole table or display formula drawn as one block.
- **ViewPlugin** (`wikilinks`): computed from the view, re-run on changes. Simpler, but can't replace line breaks.

**Spacing:** a blank line renders as a short 0.75em gap, list items get a little air, and headings get room above them, so the editor reads like a rendered page.

### 4.7 Links, embeds and how names resolve

**Files:** `wikilinks.ts`, `notes.ts`, `LinkPicker.tsx` · **Tests:** `test:notes`, `test:links`

| Syntax | Means | Looks like |
|---|---|---|
| `[[Page]]`, `[[Page\|text]]` | link to a note | purple highlight (dashed if the page doesn't exist yet) |
| `[text](chat:<id>)` | link to a chat or branch | light red, with a line on top |
| `[text](https://…)` | web link | underlined |
| `![[photo.png]]`, `![[photo.png\|300]]` | embedded image (optional width) | the image |
| `==words==[^1]` + `[^1]: note` | your note about those words | yellow highlighter; click to see, edit or remove the note |

**Resolution** (shared by the editor and the assistant, so they always agree): a bare name prefers a note in the **same folder** as the current one, then the **shortest path**. A name containing `/` is treated as an exact path.

**Renames and moves keep links working** (`relink.ts`, `test:relink`): every `[[link]]` and `![[embed]]` in the vault is resolved before and after the change, and any that would now point somewhere else (or nowhere) is rewritten to point where it did. Labels and `#headings` are kept, a link written as a path stays a path, a name now shared with another note becomes a path, and links in code are left alone. If the open note was rewritten, the editor reloads it, so its next save can't put the old links back.

**Linking selected text:** ⌘K (or right-click → Link to…) opens a picker. With nothing typed, "New page" comes first, so ⌘K then Enter creates a page. Once you type, matches come first.

### 4.8 Toggles

**File:** `toggles.ts` · **Test:** `test:toggles`

Collapsible blocks are stored as standard HTML `<details>`, which GitHub and Obsidian's reading view also fold:

```markdown
<details open>
<summary>Title</summary>

Body: ordinary Markdown

</details>
```

The tag lines are hidden and protected from accidental edits. Type `/>` at the start of a line to make one. There are careful Enter, Backspace and Tab rules for moving lines in and out (listed in Settings).

### 4.9 Math

**File:** `math.ts` · **Test:** `test:math`

KaTeX renders `$x$`, `\(x\)`, `$$ … $$` and `\[ … \]` in chats and notes. The interesting part is that **dollar signs are ambiguous**: "it costs $800 and $900" is money, not a formula. Out of the box, remark-math renders "800 and " as math, which was checked before writing any code. So single dollars are turned off in the plugin, and `normalizeMath` applies **Pandoc's rule** instead:

- an opening `$` must be followed by a non-space;
- a closing `$` must follow a non-space and **not be followed by a digit**.

`$5-$10` stays money; `$n > 3$` is math. Code blocks and inline code are never touched.

### 4.10 Attachments and images

**Files:** `attachments.ts`, `upload.ts`, `api/attachments/*`, `api/files/image`, `api/files/raw`

**Chat attachments** (paperclip, paste or drop) are images, PDFs and text or code files:

- **Storage:** stored once in `data/attachments/<id>` with a metadata `.json` next to it. The message keeps only the metadata.
- **Every request reads them again**, because the API keeps nothing between requests. Images go in as image blocks, PDFs as document blocks (the model reads both the text and the page images), and text files as plain-text documents.
- **Images are shrunk in the browser** to 2000px on the long side before upload. An image costs about one token per 28×28 pixels and is **resent with every later message in that chat**, so this saves cost on every turn (2000px is about 60% of the cost of the model's 2576px maximum).
- **Limits:** images 8 MB, PDFs 15 MB, text 1 MB. Unused uploads are pruned after a day.

**Images in notes** work like Obsidian: paste or drop saves a real file next to the note (`Pasted image YYYYMMDDHHmmss.png`) and inserts `![[…]]`.

### 4.11 The vault and its security boundary

**File:** `vault.ts` · **Test:** `test:create-note`

Every file operation goes through `resolveInVault`, which turns a path from the browser into an absolute path **guaranteed to be inside the vault**. It rejects:

- `..` segments,
- absolute paths,
- symlinks that point outside the vault (it checks the real path),
- anything in `.trash`.

**Deleting moves to `.trash`** with a timestamp, never erases. Creating never overwrites (files are opened with the `wx` flag, which fails if the file exists). Images are served with a sandbox Content-Security-Policy and `nosniff`, so an SVG with a script in it can't run.

### 4.12 Themes

**Files:** `globals.css`, `theme.ts`, `layout.tsx`

Every color is a **CSS variable** (`--bg`, `--fg`, `--muted`, `--line`, `--accent`, the `--code-*` colors, and so on). A theme is just a block that redefines them under `[data-theme="…"]`. Tailwind classes like `bg-bg` and `text-muted` point at those variables. The themes:

- **Light** (the default)
- **Dark**
- **Neon** (a high-contrast dark theme)
- **Nord**, **Mocha** (Catppuccin) and **Rosé** (Rosé Pine Dawn, light): based on popular editor color schemes

**No flash on reload:** a tiny inline script in `<head>` reads the saved theme from `localStorage` and sets `data-theme` **before the page paints**. Without it, a dark-theme user would see a white flash on every load. Even the file tree's folder arrow changes per theme in CSS alone: soft in Mocha and Rosé, pixelated in Neon, sharp in the rest.

### 4.13 Demo mode (a public demo)

**Files:** `sandbox.ts`, `sandbox-route.ts`, `middleware.ts`, `demo/`

With `FLOW_DEMO=1` (for a deployment you can share), the app runs with simulated AI and a **private sandbox per visitor**:

1. The middleware gives each new visitor a random id in a cookie.
2. Every API route is wrapped in `sandboxed()`, which finds that visitor's folder (`/tmp/flow-demo/<id>`), creating it from `demo/` (sample notes and chats) the first time.
3. **AsyncLocalStorage** carries "this request's sandbox" through all of the request's async work, including streamed replies. `db.ts`, `vault.ts` and `attachments.ts` ask `dbPath()` / `vaultDir()` / `dataDir()` instead of using fixed paths, so none of them had to change how they work.
4. `realModel()` in `llm.ts` refuses to call Claude in demo mode, even with a key set.

Outside demo mode none of this applies: no sandbox, data in `data/` as always. Sandboxes unused for 6 hours are deleted.

**On Vercel, with Redis:** serverless hosts run several copies (instances) of the server, each with its own `/tmp`, and one visitor's requests land on any of them. The first deploy showed it: a "Chat notes" folder appeared and disappeared as requests alternated between two instances. So with Upstash Redis configured, the real copy of each sandbox lives in Redis and each `/tmp` is a cache:

- Before a request: compare the sandbox's version in Redis with the local copy's; download if it's behind.
- After a request that changes something (anything but GET), once the response has finished (streamed replies too): upload it as the next version (data first, then the version number).
- A new visitor's first requests arrive in parallel, possibly on different instances: only the first to store its seeded copy wins (`SET … NX`), and the others download that one, so message ids agree everywhere.
- Demo databases use SQLite's plain rollback journal instead of WAL, so the database is a single file that's safe to copy. Demo uploads are capped at 1 MB; a sandbox is about 70 KB.

---

## 5. Features, by area

### Chats
- Ask on the side about a highlight (⌘K) or a whole reply; nested branches; one-offs vs. saved branches.
- The thread map in the sidebar, navigable with WASD; a resizable split between the chat list and the map.
- Streaming with fade-in; Stop; Retry only on replies that went wrong (error, stopped, cut off, declined, empty).
- Web search with source chips; copy buttons; code highlighting; math.
- Attachments: images, PDFs, text and code files.
- AI titles for chats and branches (Haiku); rename or delete from the right-click menu (deleting takes its branches with it).
- Search across chats.
- **Make note:** turns a chat and its branches into a note, written live. Each thread is summarized by its own model call in parallel, and the structure (toggles placed where each topic comes up) is built in code, so the model can't break it.
- A fade above the message box.

### Notes
- An Obsidian-compatible vault of plain `.md` files, with a folder tree: drag to arrange (a line shows where it'll go; a folder's middle drops into it; the list scrolls near its edges), right-click to rename or delete. Select several: click one, shift-click another for everything between (⌘-click adds or removes one); drag any of them to move them all, or right-click → Delete N items. Your order is saved in `.flow/order.json` inside the vault; folders never arranged sort folders first, then A to Z.
- Images aren't listed in the sidebar (they live in the vault for the notes that show them). Images removed from a page go to the trash when no other note shows them (undo brings them back).
- The live-preview editor (one editor, no edit/preview toggle) with autosave 600ms after you stop typing.
- `[[links]]` with suggestions, chat links, web links, and the link picker for selected text.
- Toggles, task lists, tables, code blocks, math, embedded images.
- **Notes on text:** right-click selected words → Add note…; click the highlighted words later to see, edit or remove it. Stored as Obsidian highlight + standard footnote, so it stays plain Markdown. The note lines at the end of the file are hidden in the editor (they show as text only if the cursor goes into them).
- **Tabs**, Obsidian style: clicking a note (or following a link) shows it in the current tab; double-click it in the sidebar, or right-click → Open in new tab, to give it a tab of its own. × or a middle-click closes a tab; drag tabs to reorder them. Tabs follow renames and moves, close when their note is deleted, and are remembered in the browser.
- **Home:** a page of its own (the sidebar is empty there), seeded with a welcome guide.
- A "← back" trail when following links (⌘⌥←).

### The note assistant (λ button, bottom right)
- One conversation across all notes, kept out of Chats; it doesn't change as you switch notes. Each message records the note that was open (shown as a divider where it changes), the latest message brings that note in full, and only that note can be edited. A reply in progress keeps editing its note even if you switch away.
- Edits the note live, reads linked and other notes, searches the web, takes attachments, creates new pages.
- Undo reverts everything from the last reply.

### Sidebar and app
- Search, then one row: **Home**, a chat icon, a files icon. New chat appears under that row on the chat side.
- Themes, a web search switch and every keyboard shortcut are in Settings (⌘,).
- A pixel-lambda icon; the tab title is `_`.

---

## 6. Data: where everything lives

All of this is git-ignored, so your data never ends up on GitHub.

| What | Where |
|---|---|
| Chats, messages, note-assistant conversations | `data/flow.db` (SQLite) |
| Notes and their images | `data/vault/` (or `FLOW_VAULT_PATH`) |
| Deleted notes and images | `data/vault/.trash/` |
| The order you've arranged files in | `data/vault/.flow/order.json` |
| Chat attachments | `data/attachments/` |
| Theme, web search switch, mock mode, sidebar split, folders open | browser `localStorage` (`flow.*`) |

**Database tables** (`db.ts`):

| Table | Columns | Notes |
|---|---|---|
| `threads` | id, parent_thread_id, fork_message_id, anchor_text, title, kind, auto_titled, created_at | `parent_thread_id` null = a main thread. Deleting cascades to branches. |
| `messages` | id, thread_id, role, content, created_at, attachments | `attachments` is JSON metadata. Deleting a message cascades to branches forked from it. |
| `assistant_messages` | id, note_path, role, content, created_at, attachments | The assistant's one conversation; note_path is the note open at the time (follows renames). |
| `note_chat_messages` | id, note_path, role, content, created_at, attachments | Old per-note conversations, kept but no longer used. |

**Migrations:** `CREATE TABLE IF NOT EXISTS` never changes an existing table, so new columns are added in `migrate()` with `ALTER TABLE` when missing. It runs on every module load because in dev the connection survives hot reloads.

---

## 7. Code map

### `src/lib/`: logic (mostly pure, testable)

| File | What it's for |
|---|---|
| `context.ts` | What each thread sends to the model (the tree walk). |
| `llm.ts` | Every model call: chat streaming, web tools, caching, titles, the note assistant's tool loop, mocks. |
| `db.ts` | SQLite schema, migrations, queries. |
| `shared.ts` | Types and constants used by both browser and server (events, reply markers, attachments). No server imports. |
| `vault.ts` | The notes folder: list, read, write, create, move, trash, images, and the security boundary. |
| `relink.ts` | Rewriting links after a rename or move so they keep pointing at the same notes and images. |
| `notes.ts` | Notes by name: listing, `[[link]]` and embed resolution, linked pages. Shared by the editor and the assistant. |
| `note-edit.ts` | Applies the text editor tool's commands to a note in memory. |
| `note-images.ts` | Saving a note, and moving images it no longer shows to the trash (and back on undo). |
| `attachments.ts` | Chat attachments on disk, as model content blocks, and pruning. |
| `upload.ts` | Browser side: shrink images, upload. |
| `chat-stream.ts` | Browser side: POST and read the NDJSON stream. |
| `client.ts` | `fetch` that turns failures into readable errors; the dev mock header. |
| `chat-note.ts` | Building a note from a chat tree (structure in code, summaries from the model). |
| `titles.ts` | AI chat titles. |
| `live-markdown.ts` | The CodeMirror live-preview extension (headings, lists, tables, code, math, images…). |
| `wikilinks.ts` | Links, chat links, image embeds, paste and drop, ⌘K, the `[[` suggestions. |
| `toggles.ts` | Collapsible `<details>` blocks in the editor. |
| `annotations.ts` | Notes on text: parsing, adding, editing and removing `==words==[^1]` notes, and how they look and open in the editor. |
| `math.ts` | Which dollars are math. |
| `rehype-anchors.ts` | Draws branch highlights inside rendered replies (even across bold or italic). |
| `rehype-fade.ts` | Fade-in for streaming text. |
| `theme.ts` | The theme list and the no-flash boot script. |
| `home-note.ts` | The Home note's welcome guide. |
| `sandbox.ts` | Demo mode: which sandbox a request is in, and the data paths that follow it. |
| `sandbox-route.ts` | Demo mode: the route wrapper, creating and seeding sandboxes, cleaning up old ones. |

### `src/hooks/`: state for the app shell

| File | What it's for |
|---|---|
| `useConversation.ts` | The open conversation's tree, focus, side panel, navigation, branching. |
| `useStreaming.ts` | Sending, streaming replies, Stop, Retry. |
| `useVault.ts` | The file list, the open note, the link trail, tabs, file operations, adding images. |
| `useChatIndex.ts` | All chat titles, for `[[` suggestions and chat links. |

### `src/components/`

| File | What it's for |
|---|---|
| `Flow.tsx` | The app shell: wires the hooks to the UI, keyboard shortcuts, navigation between Home, Chats and Files. |
| `Sidebar.tsx` | Search, the Home/Chats/Files row, chat list and map, file tree. |
| `FileTree.tsx` | The folder tree: drag to move, right-click menu, per-theme arrows. |
| `ThreadMap.tsx` | The conversation tree diagram in the sidebar. |
| `chat/ThreadPane.tsx` | The center chat. |
| `chat/SidePanel.tsx` | Side threads. |
| `chat/Messages.tsx` | Message list, bubbles, streaming bubble, attachments, the message box. |
| `NoteTabs.tsx` | The tab bar above notes. |
| `NoteEditor.tsx` | A note: header, autosave, live writing. |
| `MarkdownEditor.tsx` | The CodeMirror instance; right-click menu; the link picker. |
| `LinkPicker.tsx` | Link selected text to a page, chat or web address. |
| `AnnotationPopup.tsx` | Writing, showing, editing and removing a note on text. |
| `AssistantPanel.tsx` | The note assistant. |
| `Settings.tsx` | Themes, the web search switch, shortcuts. |
| `ContextMenu.tsx`, `RenameInput.tsx`, `LambdaMark.tsx` | Small shared pieces. |

---

## 8. API routes

| Route | Methods | Does |
|---|---|---|
| `/api/chat` | POST | Send a message (or retry) and stream the reply. |
| `/api/threads` | GET, POST | List conversations (`?all=1`: every thread); create one, or fork a side thread. |
| `/api/threads/[id]` | GET, PATCH, DELETE | A conversation's whole tree; rename or save to map; delete with branches. |
| `/api/threads/[id]/root` | GET | Which conversation a branch belongs to (for chat links). |
| `/api/threads/[id]/note` | POST | Make a note from a chat, streamed. Keeps going even if the page closes. |
| `/api/threads/titles` | POST | Write titles for old threads still on placeholders. |
| `/api/search` | GET | Conversations matching a query. |
| `/api/attachments` | POST | Upload a chat attachment. |
| `/api/attachments/[id]` | GET | Serve one (thumbnails, opening it). |
| `/api/files` | GET, POST, PATCH, DELETE | The vault tree; create; rename or move; trash. |
| `/api/files/content` | GET, PUT | Read or save a note. |
| `/api/files/image` | POST | Add an image to the vault (paste or drop). |
| `/api/files/raw` | GET | Serve a vault image. |
| `/api/notes/assist` | GET, POST, DELETE | A note's assistant conversation; send to it (streamed); start over. |

---

## 9. Tests

Plain scripts run with `tsx`; each prints PASS or FAIL per check.

| Script | Checks |
|---|---|
| `test:context` | Context isolation: side threads see up to the fork, the main thread never sees tangents. |
| `test:toggles` | Toggle parsing and editing rules. |
| `test:chat-note` | Building notes from chat trees (branch placement, nesting). |
| `test:note-edit` | The text editor tool's commands on a note. |
| `test:notes` | Link and embed resolution, linked pages. |
| `test:math` | Dollars vs. math, `\(…\)` and `\[…\]`, code left alone. |
| `test:create-note` | create_note never overwrites and can't escape the vault (in a temporary vault). |
| `test:links` | The Markdown that linking selected text writes, including awkward characters. |
| `test:annotations` | Adding, numbering, editing and removing notes on text; multi-line notes; code left alone. |
| `test:note-images` | Images removed from a page go to the trash unless another note shows them; undo and cut-and-paste restore them. |
| `test:relink` | Links after renames and moves: labels, headings, embeds, folders, name clashes, code left alone. |
| `test:order` | Arranging files: saved order, moves between folders, renames keeping their spot, deletes, nothing outside the vault. |

Browser checks happen in the preview with **mock mode** (free). Real API checks are kept to single, cheap requests.

---

## 10. Bugs and lessons

Real bugs from building this, with what each one teaches.

| Bug | Cause | Lesson |
|---|---|---|
| "$800 and $900" became a formula | remark-math's single-dollar rule | **Check library defaults with real inputs before building on them.** |
| Pasted image showed "Image not found" | The embed was drawn before React rendered the new file list (`setState` isn't immediate) | Wait for the committed render (an effect) before acting on new state. |
| Home highlighted for 30ms when going to Files | Two state updates were split by an `await`, so the in-between state was painted | **Pick everything first, then update state together**, with no `await` in between. |
| A slow startup load pulled you back to Home | An older async action finished after a newer one | Number your navigations; a stale one checks and gives up. |
| `encodeURIComponent` left `(` `)` alone | It only encodes some characters; `)` ends a Markdown link | Test with the real-world worst case (Wikipedia addresses). |
| A bare image name matched the vault root first | The exact-path rule ran before the same-folder rule | Name rules need tests with duplicate names. |
| A dropped image split an existing `![[…]]` | The drop position landed inside another link | Snap insert positions out of existing syntax. |
| `../../evil` produced a hidden file | Leading dots weren't stripped after cleaning | Security tests should check the *result* is sensible, not just "didn't escape". |
| Rotating a 4×7 pixel arrow blurred it | Rotation put its center on half a pixel | Pixel art needs whole-pixel positions; draw both states instead of rotating. |
| Web search results had no citations | Dynamic filtering runs search from code, so no citation markers | Derive sources from links that match pages actually seen. |
| Math in chats: fractions overlapped, subscripts full-size | Two KaTeX versions: chats rendered with 0.16 (inside rehype-katex), the page loaded 0.19's CSS, which renamed `.sizing` to `.katex-sizing` | **One version of a library everywhere** (`npm ls <pkg>` shows duplicates). |
| Hats (θ̂) drawn beside Greek letters | Inter has no combining accents, so the hat came from a fallback font that can't place it on Greek | Measure which font draws a character (`unicodeRange`); draw just those characters in a font that can. |
| Example `![[photo.png]]` in inline code counted as a real embed | Embeds were found everywhere except code *blocks* | Treat inline code like code blocks wherever syntax is detected. |
| The demo's files appeared and disappeared on Vercel | Each serverless instance has its own `/tmp`, and requests alternate between instances | **Serverless means no shared disk.** Keep state somewhere every instance can reach (here Redis), and test with two local instances. |
| A formatter rewrote a whole file | It used a different style than the project | Don't run tools the project doesn't use; keep diffs to what changed. |

**General habits that paid off:**
- Reproduce a bug and **measure it** before fixing it (the highlight flash was recorded with a MutationObserver: Chats → Files → Home → Files), then measure again after.
- Test in mock mode first, then one real request.
- Clean up test data (names start with `zz-` so they're easy to find).

---

## 11. Decisions and trade-offs

| Decision | Why | Cost |
|---|---|---|
| Plain Markdown files, not a database, for notes | You own them; Obsidian and any editor can open them | No block-level features like Notion's synced blocks or databases. |
| Toggles as `<details>` HTML | Standard; other apps fold them too | Slightly noisy raw text (hidden in the editor). |
| SQLite for chats | Zero setup, fast, one file | Single machine; would need a server database to share or sync. |
| Side questions start as one-offs | Most tangents are quick; the map stays clean | One extra click to keep one. |
| Retry only on failed replies | Rerolling a good answer adds noise and cost | No "try a different answer" button. |
| Assistant edits in memory, saves once | Can't leave a half-edited file; Undo is simple | A failed save at the end loses the edit (rare). |
| create_note is create-only | The worst case is an extra page, which Undo removes | It can't reorganize other existing notes. |
| Files resent every turn (no Files API) | Simple, local-first | Bigger requests in long chats with many files. |
| Images shrunk to 2000px | About 40% cheaper per image, per turn | Tiny text in huge screenshots may lose detail. |
| The structure of made notes is built in code | The model can't break toggles | Less freedom in how notes are laid out. |

---

## 12. Build log

| Date | What landed |
|---|---|
| Oct 13 | Side threads, nested branches, the thread map. |
| Oct 14 | Side questions unsaved by default; failure handling; search; Home; Stop; streaming performance. |
| Oct 15 | Notes workspace; chats to notes; live note writing; chat links; one rendered editor; themes; streaming fade-in; hooks and components split; AI titles; chat rename and delete. |
| Oct 17 | Note assistant (edits, reads notes, web search, attachments); chat web search; uploads; math; images in notes; page creation; sidebar redesign; Neon theme; README rewrite. |
| Oct 19 | Link selected words to pages, chats or web pages; chat fade. |
| Oct 21 | Renames and moves keep links working. Math in tables; code blocks line up inside toggles. |
| Oct 21 | Demo mode for a public deployment: simulated AI, a private seeded sandbox per visitor, synced through Redis on Vercel. Next.js and React security patches. |
| Oct 20 | Notes on text: highlight words, attach a note, click to see it. Everything switched to Haiku 5.5. Fixed math rendering in chats and accented letters (θ̂). Images removed from pages go to the trash. Drag to arrange files. |
| Oct 29 | The note assistant became one conversation across notes (it still sees and edits the open one). Tabs for notes. |
| | *Add new entries here.* |

---

## 13. Ideas backlog

Offered or discussed, not built yet. Roughly by value.

- **User testing.** Have 5 to 10 people use Flow for a week; note what confuses them. This would also give real numbers for a resume.
- **The assistant sees embedded images** in the note, like chat attachments.
- **Notion import.** Read Notion's Markdown and CSV export, strip the IDs from filenames, convert links and toggles.
- **The fade in the side panel and assistant panel.**
- **Edit a sent message** and re-run from there.
- **Model picker** (Opus for hard questions, Haiku for quick ones).
- **Import chats** from ChatGPT or Claude exports.
- **Desktop app** with Tauri (the long-term plan).

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Thread** | One line of conversation: the main thread, or a branch. |
| **Branch / side thread** | A thread forked from a message, usually about a highlighted excerpt. |
| **One-off** | A side question kept out of the map until you save it. |
| **Fork point** | The message a branch starts from; it sees everything up to it. |
| **Anchor** | The highlighted text a branch is about; drawn as a highlight in the reply. |
| **Vault** | The folder of notes (Obsidian's word). |
| **Embed** | `![[file]]`: an image shown inside a note. |
| **Decoration / widget** | CodeMirror's way to style or replace text on screen without changing the file. |
| **NDJSON** | Newline-delimited JSON: one JSON object per line, good for streaming. |
| **Prompt caching** | Reusing an identical prompt prefix at lower cost. |
| **Server tool** | A tool Anthropic runs (web search or fetch), not your code. |
| **Agent loop** | Call the model, run the tools it asks for, send results back, repeat. |
| **Eager input streaming** | Tool inputs stream as they're generated; you must validate them before use. |
| **Optimistic update** | Show the result immediately and reconcile with the server after. |
| **Hydration** | React attaching behavior to server-rendered HTML; clicks before it are lost. |
| **Mock mode** | Free fake replies that show exactly what context was sent. |
