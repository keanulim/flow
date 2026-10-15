// Toggle (<details>) behaviour without a browser: parsing, edit protection,
// housekeeping. Run: npm run test:toggles

import { EditorState, Text } from "@codemirror/state";
import { HOME_WELCOME } from "../src/lib/home-note";
import { missingBlankLines, parseToggles, toggles, withTrailingLine } from "../src/lib/toggles";
let fails = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) fails++; };
const roles = (src: string) => { const p = parseToggles(Text.of(src.split("\n"))); return src.split("\n").map((_, i) => p.lines.get(i + 1)?.role ?? "-"); };

// --- parser ---
check("basic open toggle", JSON.stringify(roles("<details open>\n<summary>T</summary>\n\nbody\n</details>")) === JSON.stringify(["open","summary","spacer","body","close"]));
check("blank line after </details> is the toggle's trailer", JSON.stringify(roles("<details open>\n<summary>T</summary>\n\nbody\n</details>\n\nafter")) === JSON.stringify(["open","summary","spacer","body","close","trailer","-"]));
const glued = Text.of("<details open>\n<summary>T</summary>\n\nbody\n</details>\nglued".split("\n"));
check("content glued under </details> gets a blank line inserted", JSON.stringify(missingBlankLines(glued)) === JSON.stringify([glued.line(5).to]));
check("nested closes back-to-back need no blank line", missingBlankLines(Text.of("<details open>\n<summary>A</summary>\n\n<details open>\n<summary>B</summary>\n\nx\n</details>\n</details>\n\nend".split("\n"))).length === 0);
check("a note ending in a toggle gets a trailer and a visible line", withTrailingLine("<details open>\n<summary>T</summary>\n\nx\n</details>").endsWith("</details>\n\n"));
const nested = parseToggles(Text.of("<details open>\n<summary>Outer</summary>\n\na\n<details>\n<summary>Inner</summary>\n\nb\n</details>\nc\n</details>".split("\n")));
check("nested: two toggles, inner depth 1, inner closed", nested.toggles.length === 2 && nested.toggles[1].depth === 1 && !nested.toggles[1].open && nested.toggles[1].parent === nested.toggles[0]);
check("nested: 'c' after inner belongs to outer", nested.lines.get(10)?.toggle === nested.toggles[0]);
const unclosed = parseToggles(Text.of("<details open>\n<summary>T</summary>\n\nx\ny".split("\n")));
check("unclosed toggle runs to the end", unclosed.toggles[0].closeLine === null && unclosed.toggles[0].bodyLast === 5);
check("<details> inside a code fence is ignored", parseToggles(Text.of("```\n<details open>\n<summary>no</summary>\n```".split("\n"))).toggles.length === 0);
check("missing spacer: body starts right after summary", JSON.stringify(roles("<details open>\n<summary>T</summary>\nbody\n</details>")) === JSON.stringify(["open","summary","body","close"]));
const t0 = parseToggles(Text.of("<details open>\n<summary>Hello</summary>\n\n\n</details>".split("\n"))).toggles[0];
const doc0 = "<details open>\n<summary>Hello</summary>\n\n\n</details>";
check("title positions point at the text", doc0.slice(t0.titleFrom, t0.titleTo) === "Hello");

// --- protection (no view needed) ---
const mk = (doc: string, cursor?: number) => EditorState.create({ doc, extensions: [toggles()], selection: cursor === undefined ? undefined : { anchor: cursor } });
const s = mk(doc0 + "\n");
const titleEnd = t0.titleTo;
const after = (spec: object) => s.update(spec as never).state.doc.toString();
check("typing at the end of the title works", after({ changes: { from: titleEnd, insert: "!" }, userEvent: "input.type" }).includes("<summary>Hello!</summary>"));
check("Delete at the end of the title can't eat </summary>", after({ changes: { from: titleEnd, to: titleEnd + 1 }, userEvent: "delete.forward" }) === s.doc.toString());
check("Backspace at the start of the title can't eat <summary>", after({ changes: { from: t0.titleFrom - 1, to: t0.titleFrom }, userEvent: "delete.backward" }) === s.doc.toString());
const bodyLineStart = doc0.indexOf("\n\n\n") + 2; // the empty body line (after the hidden spacer line)
check("Backspace at body start can't merge into the hidden spacer", after({ changes: { from: bodyLineStart - 1, to: bodyLineStart }, userEvent: "delete.backward" }) === s.doc.toString());
check("Delete at the end of the body can't merge into </details>", after({ changes: { from: bodyLineStart, to: bodyLineStart + 1 }, userEvent: "delete.forward" }) === s.doc.toString());
check("typing inside the body works", after({ changes: { from: bodyLineStart, insert: "note" }, userEvent: "input.type" }).includes("\n\nnote\n</details>"));
check("select-all delete removes everything", after({ changes: { from: 0, to: s.doc.length }, userEvent: "delete" }) === "");
check("undo can restore anything", after({ changes: { from: 0, to: 20 }, userEvent: "undo" }).length === s.doc.length - 20);

// --- housekeeping ---
const noTrail = mk(doc0);
check("typing keeps a blank line + a visible line after a final toggle", noTrail.update({ changes: { from: bodyLineStart, insert: "x" }, userEvent: "input.type" }).state.doc.toString().endsWith("</details>\n\n"));
const gluedState = mk("<details open>\n<summary>T</summary>\n\nbody\n</details>\n\nlater");
const merged = gluedState.update({ changes: { from: gluedState.doc.line(6).from - 1, to: gluedState.doc.line(6).to + 1 }, userEvent: "input.paste" }).state.doc.toString();
check("an edit that glues content under </details> gets the blank line back", merged.includes("</details>\n\nlater") || merged === gluedState.doc.toString(), JSON.stringify(merged.slice(-20)));
const clamped = s.update({ selection: { anchor: s.doc.line(2).to } }).state.selection.main.head;
check("cursor at the end of a title line is clamped into the title", clamped === titleEnd, `(got ${clamped}, title ends at ${titleEnd})`);

// --- Backspace out and back in (needs a view, so only the structure is checked here; the browser test covers keys) ---
const outDoc = "<details open>\n<summary>T</summary>\n\nlast text\n\n</details>\n\nafter";
check("an empty last body line is the toggle's last line", (() => { const p = parseToggles(Text.of(outDoc.split("\n"))); const t = p.toggles[0]; return t.bodyLast === 5 && p.lines.get(5)?.role === "body"; })());

// --- the Home page guide is well-formed (it's written into new Home notes) ---
const home = Text.of(HOME_WELCOME.split("\n"));
const homeToggles = parseToggles(home).toggles;
check("Home guide: two closed toggles, each closed off with its blank line", homeToggles.length === 2 && homeToggles.every((t) => !t.open && t.closeLine !== null && t.spacerLine !== null), JSON.stringify(homeToggles.map((t) => home.sliceString(t.titleFrom, t.titleTo))));
check("Home guide: no blank lines missing (the editor won't rewrite it on open)", missingBlankLines(home).length === 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
if (fails) process.exit(1);
