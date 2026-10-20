// Notes on text (==words==[^1] plus [^1]: note). Run: npm run test:annotations
import { addAnnotation, parseAnnotations, removeAnnotation, type TextChange, updateAnnotation } from "../src/lib/annotations";
let fails = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
/** Apply changes the way CodeMirror does: all positions refer to the original text. */
const apply = (doc: string, changes: TextChange[]) => [...changes].sort((a, b) => b.from - a.from).reduce((d, c) => d.slice(0, c.from) + c.insert + d.slice(c.to), doc);

const doc = "# Tasks\n\nKV store with TTL, bank system.\n";
const at = doc.indexOf("KV store");
const a = addAnnotation(doc, at, at + "KV store".length, "Ask about eviction")!;
const one = apply(doc, a.changes);
check("adds the highlight and a note at the end", one, "# Tasks\n\nKV store with TTL, bank system.\n".replace("KV store", "==KV store==[^1]").replace(/\n$/, "") + "\n\n[^1]: Ask about eviction\n");

const at2 = one.indexOf("bank system");
const b = addAnnotation(one, at2, at2 + "bank system".length, "Two lines\nof note")!;
const two = apply(one, b.changes);
check("the next note gets the next number and joins the list", b.id, "2");
check("a multi-line note is indented so it stays one note", two.endsWith("[^1]: Ask about eviction\n[^2]: Two lines\n    of note\n"), true);

const parsed = parseAnnotations(two);
check("parses both notes", [...parsed.defs.values()].map((d) => [d.id, d.text]), [["1", "Ask about eviction"], ["2", "Two lines\nof note"]]);
check("the highlighted words", parsed.refs.map((r) => two.slice(r.textFrom, r.textTo)), ["KV store", "bank system"]);

const edited = apply(two, updateAnnotation(two, "1", "Ask about LRU")!);
check("editing a note changes only its text", parseAnnotations(edited).defs.get("1")?.text, "Ask about LRU");

const removed = apply(two, removeAnnotation(two, "1"));
check("removing a note restores the words and deletes the note", removed.includes("KV store with") && !removed.includes("[^1]") && removed.includes("==bank system==[^2]"), true);
check("removing both gives back the original text", apply(removed, removeAnnotation(removed, "2")).trimEnd(), doc.trimEnd());

check("several lines can't be annotated", addAnnotation(doc, 0, doc.length, "x"), null);
check("an empty note isn't added", addAnnotation(doc, at, at + 2, "  "), null);
const code = "```\n==x==[^1]\n```\n";
check("code blocks are left alone", parseAnnotations(code).refs.length, 0);
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
