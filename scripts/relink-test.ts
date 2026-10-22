// Links stay working when notes, images or folders are renamed or moved. Run: npm run test:relink
import { type Files, relinkNote } from "../src/lib/relink";
let fails = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const files = (paths: string[]): Files => ({
  notes: paths.filter((p) => p.endsWith(".md")).map((p) => ({ path: p, name: p.split("/").pop()!.replace(/\.md$/, ""), folder: folderOf(p) })),
  others: paths.filter((p) => !p.endsWith(".md")).map((p) => ({ path: p, name: p.split("/").pop()!, folder: folderOf(p) })),
});
const run = (text: string, from: string, beforePaths: string[], moves: [string, string][], fromAfter = from) => {
  const moved = new Map(moves);
  const afterPaths = beforePaths.map((p) => moved.get(p) ?? p);
  return relinkNote(text, from, fromAfter, files(beforePaths), files(afterPaths), moved) ?? text;
};

const vault = ["Home.md", "Trip.md", "School/Bio.md", "School/pic.png"];
check("a rename updates the link", run("See [[Trip]].", "Home.md", vault, [["Trip.md", "Travel.md"]]), "See [[Travel]].");
check("label and heading are kept", run("[[Trip#Day 1|the plan]]", "Home.md", vault, [["Trip.md", "Travel.md"]]), "[[Travel#Day 1|the plan]]");
check("links to other notes are untouched", run("[[Trip]] and [[Home]]", "Home.md", vault, [["Trip.md", "Travel.md"]]), "[[Travel]] and [[Home]]");
check("an image embed follows a rename", run("![[pic.png|300]]", "School/Bio.md", vault, [["School/pic.png", "School/cell.png"]]), "![[cell.png|300]]");
check("a path link follows a folder rename, staying a path", run("[[School/Bio]]", "Home.md", vault, [["School/Bio.md", "Uni/Bio.md"], ["School/pic.png", "Uni/pic.png"]]), "[[Uni/Bio]]");
check("links in code stay as written", run("`[[Trip]]`\n```\n[[Trip]]\n```\n[[Trip]]", "Home.md", vault, [["Trip.md", "Travel.md"]]), "`[[Trip]]`\n```\n[[Trip]]\n```\n[[Travel]]");
// Two notes named Plan: the link from School/ meant School/Plan.md (same folder first).
const two = ["Plan.md", "School/Plan.md", "School/Notes.md"];
check("moving a note away keeps what a same-folder link meant", run("[[Plan]]", "School/Notes.md", two, [["School/Notes.md", "Notes.md"]], "Notes.md"), "[[School/Plan]]");
check("a new name already used elsewhere becomes a path", run("[[Trip]]", "Home.md", ["Home.md", "Trip.md", "Other/Travel.md"], [["Trip.md", "School/Travel.md"]]), "[[School/Travel]]");
check("a link that pointed nowhere stays as it was", run("[[Nowhere]]", "Home.md", vault, [["Trip.md", "Travel.md"]]), "[[Nowhere]]");
check("chat links are never touched", run("[KV](chat:abc) [[Trip]]", "Home.md", vault, [["Trip.md", "Travel.md"]]), "[KV](chat:abc) [[Travel]]");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
