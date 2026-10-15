// Chat -> note conversion without the model: tree shape, toggle structure,
// and how the Markdown renders. Run: npm run test:chat-note

import { Text } from "@codemirror/state";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { buildTree, clean, type ChatNode, placeToggles, promptFor, renderNote, summarizeTree } from "../src/lib/chat-note";
import type { Message, Thread } from "../src/lib/db";
import { missingBlankLines, parseToggles } from "../src/lib/toggles";

// Minimal hast -> HTML (tags and text only; enough to check structure).
type H = { type: string; tagName?: string; value?: string; children?: H[] };
const toHtml = (n: H): string => n.type === "text" ? n.value!.replace(/</g, "&lt;") : n.type === "element" ? `<${n.tagName}>${(n.children ?? []).map(toHtml).join("")}</${n.tagName}>` : (n.children ?? []).map(toHtml).join("");

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) fails++; };

let clock = 0;
const T = (id: string, parent: string | null, fork: string | null, kind: "thread" | "oneoff" = "thread", anchor: string | null = null): Thread =>
  ({ id, parentThreadId: parent, forkMessageId: fork, anchorText: anchor, title: `Title ${id}`, kind, createdAt: clock++ });
const M = (id: string, threadId: string, role: "user" | "assistant", content: string): Message => ({ id, threadId, role, content, createdAt: clock++ });

// above -> main -> { b2 (forked at a2, created first), b1 (forked at a1) -> { nested, oneoff-in-branch }, o1 (one-off), empty }
const threads = [
  T("above", null, null),
  T("main", "above", "x"),
  T("b2", "main", "a2"),
  T("b1", "main", "a1", "thread", "the *cache* key"),
  T("o1", "main", "a1", "oneoff", "TTL"),
  T("nested", "b1", "b1a"),
  T("o2", "b1", "b1a", "oneoff"),
  T("empty", "main", "a1"),
];
const messages = [
  M("x", "above", "assistant", "SHOULD NOT APPEAR"),
  M("u1", "main", "user", "How does caching work?"), M("a1", "main", "assistant", "It stores things."),
  M("u2", "main", "user", "And invalidation?"), M("a2", "main", "assistant", "Hard."),
  M("b2u", "b2", "user", "q b2"), M("b1u", "b1", "user", "q b1"), M("b1a", "b1", "assistant", "a b1"),
  M("o1u", "o1", "user", "q o1"), M("nu", "nested", "user", "q nested"), M("o2u", "o2", "user", "q o2"),
];

const tree = buildTree("main", threads, messages);
const names = (n: ChatNode): unknown => [n.thread.id, n.kind, ...n.children.map(names)];
check("only the clicked thread and below; children ordered by fork point; empty leaf dropped",
  JSON.stringify(names(tree)) === JSON.stringify(["main", "page", ["b1", "branch", ["nested", "branch"], ["o2", "oneoff"]], ["o1", "oneoff"], ["b2", "branch"]]),
  JSON.stringify(names(tree)));
check("prompt has the thread's own messages only", promptFor(tree).includes("How does caching work?") && !promptFor(tree).includes("q b1") && !promptFor(tree).includes("SHOULD NOT"));
check("branch prompt includes the excerpt", promptFor(tree.children[0]).includes('Excerpt it branched from: "the *cache* key"'));
check("one-off prompt asks for a super brief note", /super brief/.test(promptFor(tree.children[1])));
check("prompt lists the branches with markers and their highlights", promptFor(tree).includes('{{branch-1}}: highlighted "the *cache* key"') && promptFor(tree).includes("{{branch-3}}") && !promptFor(tree.children[1]).includes("{{branch"));

// --- placing toggles where their topic comes up ---
const A = "<A>", B = "<B>";
const place = (s: string, t = [A, B]) => placeToggles(s, t);
check("toggle goes right after the marked bullet", place("- one {{branch-1}}\n- two\n- three {{branch-2}}") === `- one\n\n${A}\n\n- two\n- three\n\n${B}`, JSON.stringify(place("- one {{branch-1}}\n- two\n- three {{branch-2}}")));
check("unplaced toggles go at the end; unknown/duplicate markers dropped", place("text {{branch-2}} {{branch-2}} {{branch-9}}") === `text\n\n${B}\n\n${A}`, JSON.stringify(place("text {{branch-2}} {{branch-2}} {{branch-9}}")));
check("a marked table row waits for the table to end", place("| a | b |\n|---|---|\n| x {{branch-1}} | y |\n| z | w |\n\nafter", [A]) === `| a | b |\n|---|---|\n| x | y |\n| z | w |\n\n${A}\n\nafter`);
check("a bullet's sub-bullets stay with it", place("- top {{branch-1}}\n  - sub\n- next", [A]) === `- top\n  - sub\n\n${A}\n\n- next`);
check("markers inside code are left alone", place("```\nx {{branch-1}}\n```", [A]) === "```\nx {{branch-1}}\n```\n\n" + A);
check("a marked heading line keeps its heading", place("## Topic {{branch-1}}\n- point", [A]) === `## Topic\n\n${A}\n\n- point`);

(async () => {
  let running = 0, peak = 0;
  const summaries = await summarizeTree(tree, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return n.kind === "page" ? "## Basics\n\n- caching stores results\n- invalidation is hard {{branch-2}}" : n.thread.id === "nested" ? "- nested note\n\n```js\nconsole.log('</details>')" : `- note for ${n.thread.id}`;
  }, 3);
  check("summaries run in parallel, capped", peak === 3, `peak ${peak}`);
  check("every thread summarized once", summaries.size === 6);

  const md = renderNote(tree, summaries, new Date(2026, 9, 15));
  console.log("\n----- note -----\n" + md + "----------------\n");
  const doc = Text.of(md.split("\n"));
  const p = parseToggles(doc);
  const shape = p.toggles.map((t) => `${doc.sliceString(t.titleFrom, t.titleTo)}@${t.depth}${t.open ? "+" : ""}`);
  check("editor sees the toggles nested correctly, all closed (o1 placed at its marker, the rest at the end)",
    JSON.stringify(shape) === JSON.stringify(["Title o1@0", "Title b1@0", "Title nested@1", "Title o2@1", "Title b2@0"]), JSON.stringify(shape));
  check("every toggle is closed off and has its blank line after <summary>", p.toggles.every((t) => t.closeLine !== null && t.spacerLine !== null));
  check("no blank lines missing (editor won't rewrite the file on open)", missingBlankLines(doc).length === 0, JSON.stringify(missingBlankLines(doc)));
  check("a </details> in model text is escaped, but left alone inside code", clean("x </details>\n```\n</details>\n```") === "x &lt;/details>\n```\n</details>\n```");
  check("an unclosed code fence gets closed", clean("```js\ny") === "```js\ny\n```");

  const proc = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw);
  const html = toHtml((await proc.run(proc.parse(md))) as H);
  const depthOf = (needle: string) => { const i = html.indexOf(needle); const before = html.slice(0, i); return (before.match(/<details>/g) ?? []).length - (before.match(/<\/details>/g) ?? []).length; };
  check("preview: 5 toggles", (html.match(/<details>/g) ?? []).length === 5);
  check("preview: summaries render as Markdown inside toggles", /<li>note for b1<\/li>/.test(html) && /<h2>Basics<\/h2>/.test(html) && /<em>On “the \*cache\* key”<\/em>|<em>On “the \\\*cache\\\* key”<\/em>|<em>On “the \*cache\* key”/.test(html), html.match(/On “[^<]*/)?.[0]);
  check("preview: nesting depth (nested note inside b1, b2 at top level)", depthOf("nested note") === 2 && depthOf("note for b2") === 1 && depthOf("caching stores") === 0,
    `${depthOf("nested note")} ${depthOf("note for b2")} ${depthOf("caching stores")}`);
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
