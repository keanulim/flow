/** The note the Home button opens, and what it starts with when Home creates it. */
export const HOME_NOTE = "Home";

export const HOME_WELCOME = `# Welcome to Flow

Flow is an AI chat built to keep you in a state of focus. Ask about anything without losing your place, then turn what you learned into notes you keep.

This page is a note too: everything here is plain Markdown that you can edit. Read through it once, then make it yours (see the bottom).

## Chats

Open **Chats** in the sidebar and start a **New chat**. Then:

- **Ask on the side.** Highlight any part of a reply and press **⌘K** (Ctrl+K on Windows), or click **Ask on the side**. Your question opens in a side panel, so the main conversation stays clean. The highlight becomes a link back to it.
- **Keep the good ones.** Side questions stay out of the way until you press **Save to map**. Saved threads can branch again, as deep as you like.
- **Know where you are.** The map in the sidebar shows the conversation as a tree, with your current path lit up. Click the sidebar, then move with **W A S D**.
- **Make a note.** The **Make note** button at the top of a chat summarizes it into a note in *Chat notes*. You can watch it being written. Branches become collapsible sections, placed right under the line they're about.

<details>
<summary>Chat shortcuts</summary>

- **⌘K**: ask on the side about the highlight (or the latest reply)
- **Esc**: close the side panel, then go up a level
- **⇧Esc**: back to the main thread
- **⌥↑ / ⌥↓**: switch between side threads
- **⌘\\\\**: show or hide the side panel
</details>

## Notes

Your notes live in the sidebar on Home. They're real \`.md\` files on your computer, so they also open in Obsidian or any other editor.

- **Write.** Type \`#\`, \`##\` or \`###\` and a space for headings. \`**bold**\`, \`*italic*\` and \`- \` lists render as you type. Click a line to see its Markdown.
- **Fold.** Type \`/>\` at the start of a line to make a toggle like the ones on this page.
- **Link pages.** Select some text, press **⌘K** (or right-click → **Link to…**) and pick a page, a chat or a web address, or make a new page from it. **⌘⌥←** brings you back. You can also type \`[[\` to link a note you already have, like [[Home]].
- **Link chats.** \`[[\` suggests your chats too. Chat links are red, and clicking one opens that exact chat or branch.
- **Organize.** Drag notes into folders. Right-click a note or folder to rename, delete, or add to it.

<details>
<summary>Note shortcuts</summary>

- **/>**: at the start of a line, make it a toggle
- **Enter on a toggle's title**: open toggle, new line inside; closed toggle, new line after it
- **Tab / ⇧Tab**: move the line after a toggle into it, or a line inside out
- **⌫ on an empty last line**: step out of a toggle (⌫ again goes back in)
- **⌘K on selected text**: link it to a page
- **⌘⌥←**: back to the note you came from
</details>

Every shortcut is also in **Settings** (bottom of the sidebar, or **⌘,**).

## Try it

- [ ] Start a chat and ask something you're curious about
- [ ] Highlight part of the answer and ask a side question
- [ ] Save that side question to the map and branch from it
- [ ] Press **Make note** and watch the note appear
- [ ] Link a word on this page to a new page

## Make this page yours

This is your home: the page you land on every time you click **Home**. Delete everything above and turn it into whatever helps you focus, like a list of projects, links to the notes you use most, or today's priorities.

If you ever delete this file, clicking **Home** creates a fresh copy of this guide.
`;
