// What linking selected text writes (⌘K → pick a page, chat or web address). Run: npm run test:links
import { linkMarkdown } from "../src/lib/wikilinks";
let fails = 0;
const check = (label: string, got: string, want: string) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${got}\n      want ${want}`}`);
  if (!ok) fails++;
};
check("a word linked to a page keeps the word as its label", linkMarkdown("KV", { kind: "note", target: "Practice problem - in-memory key-value store" }), "[[Practice problem - in-memory key-value store|KV]]");
check("same text as the page: no label needed", linkMarkdown("trip ideas", { kind: "note", target: "Trip ideas" }), "[[Trip ideas]]");
check("a page shared by two folders is linked by path", linkMarkdown("bio", { kind: "note", target: "School/Biology" }), "[[School/Biology|bio]]");
check("| and brackets can't break a page link", linkMarkdown("a|b [c]", { kind: "note", target: "X" }), "[[X|a b c]]");
check("a word linked to a chat", linkMarkdown("KV", { kind: "chat", id: "abc-123" }), "[KV](chat:abc-123)");
check("a word linked to the web", linkMarkdown("docs", { kind: "url", url: "https://example.com/a" }), "[docs](https://example.com/a)");
check("spaces and parens in a web address are encoded", linkMarkdown("wiki", { kind: "url", url: "https://en.wikipedia.org/wiki/Key (computing)" }), "[wiki](https://en.wikipedia.org/wiki/Key%20%28computing%29)");
check("brackets in the label can't break a web link", linkMarkdown("see [1]", { kind: "url", url: "https://x.io" }), "[see (1)](https://x.io)");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
