// Resolving [[links]] to notes (shared by the editor and the note assistant). Run: npm run test:notes
import { embeddedImages, linkedPages, listNotes, listOtherFiles, resolveFile, resolveNote, type NoteInfo } from "../src/lib/notes";
let fails = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) fails++; };
const notes: NoteInfo[] = [
  { path: "Trip.md", name: "Trip", folder: "" },
  { path: "School/Trip.md", name: "Trip", folder: "School" },
  { path: "School/Biology.md", name: "Biology", folder: "School" },
];
check("same name: the one in the current folder wins", resolveNote("Trip", "School/Biology.md", notes) === "School/Trip.md");
check("same name, other folder: the shortest path", resolveNote("Trip", "Other/x.md", notes) === "Trip.md");
check("exact folder/name", resolveNote("School/Trip", null, notes) === "School/Trip.md");
check("case-insensitive, .md optional", resolveNote("biology.md", "School/x.md", notes) === "School/Biology.md");
check("unknown note", resolveNote("Nope", null, notes) === null);
const md = "See [[Trip]] and [[Biology|bio notes]] and [[Trip#Day 1]].\n```\n[[NotALink]]\n```\nAlso [[ School/Trip ]].";
check("linked pages: aliases and headings stripped, deduped, code skipped", JSON.stringify(linkedPages(md)) === JSON.stringify(["Trip", "Biology", "School/Trip"]), JSON.stringify(linkedPages(md)));
check("an ![[embed]] is not a linked page", JSON.stringify(linkedPages("![[Trip.png]] and [[Trip]]")) === JSON.stringify(["Trip"]));
const images: NoteInfo[] = [
  { path: "Pasted image 1.png", name: "Pasted image 1.png", folder: "" },
  { path: "School/Pasted image 1.png", name: "Pasted image 1.png", folder: "School" },
  { path: "School/diagram.PNG", name: "diagram.PNG", folder: "School" },
];
check("embed: same name, the one in the note's folder wins", resolveFile("Pasted image 1.png", "School/Biology.md", images) === "School/Pasted image 1.png");
check("embed: from elsewhere, the shortest path", resolveFile("Pasted image 1.png", "Other/x.md", images) === "Pasted image 1.png");
check("embed: by full path, any case", resolveFile("school/diagram.png", null, images) === "School/diagram.PNG");
check("embed: missing", resolveFile("nope.png", null, images) === null);
const tree = [{ type: "folder" as const, name: "A", path: "A", children: [{ type: "file" as const, name: "n.md", path: "A/n.md" }, { type: "file" as const, name: "p.png", path: "A/p.png" }] }];
check("notes and images are listed apart", listNotes(tree).map((n) => n.path).join() === "A/n.md" && listOtherFiles(tree).map((n) => n.path).join() === "A/p.png");
check("embeds in `inline code` are examples, not real", JSON.stringify(embeddedImages("see `![[photo.png]]` and ![[real.png]]")) === JSON.stringify(["real.png"]));
check("links in `inline code` are examples too", JSON.stringify(linkedPages("write `[[Page]]` or [[Real]]")) === JSON.stringify(["Real"]));
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
