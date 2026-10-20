// Images removed from a note go to the trash (if no other note shows them) and come back on undo.
// Run: npm run test:note-images. Uses a throwaway vault in the OS temp folder, never your notes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vault-"));
process.env.FLOW_VAULT_PATH = vault;
let fails = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
const exists = (rel: string) => fs.existsSync(path.join(vault, rel));
const write = (rel: string, text: string) => fs.writeFileSync(path.join(vault, rel), text);

(async () => {
  const { embeddedImages } = await import("../src/lib/notes");
  const { saveNote } = await import("../src/lib/note-images");
  check("finds embeds (with widths), once each, not in code", embeddedImages("![[a.png]] ![[b.png|300]] ![[A.png]]\n```\n![[c.png]]\n```"), ["a.png", "b.png"]);

  fs.mkdirSync(path.join(vault, "School"));
  write("School/one.png", "x");
  write("School/shared.png", "x");
  write("School/kept.png", "x");
  write("School/A.md", "# A\n![[one.png]]\n![[shared.png]]\n");
  write("School/B.md", "# B\n![[shared.png]]\n");

  let r = await saveNote("School/A.md", "# A\n![[shared.png]]\n");
  check("removing an image from the page trashes it", [r.removed, exists("School/one.png")], [["School/one.png"], false]);
  check("it went to .trash, not deleted", fs.readdirSync(path.join(vault, ".trash")).some((f) => f.startsWith("one (")), true);

  r = await saveNote("School/A.md", "# A\n");
  check("an image another note still shows is kept", [r.removed, exists("School/shared.png")], [[], true]);

  r = await saveNote("School/A.md", "# A\n![[one.png]]\n");
  check("putting the embed back (undo) restores the image", [r.restored, exists("School/one.png")], [["School/one.png"], true]);

  // Cut the line from A and paste it into B: A saves first (trashed), then B (restored).
  r = await saveNote("School/A.md", "# A\n");
  const cut = r.removed;
  r = await saveNote("School/B.md", "# B\n![[shared.png]]\n![[one.png]]\n");
  check("cut and paste into another note: trashed, then restored", [cut, r.restored, exists("School/one.png")], [["School/one.png"], ["School/one.png"], true]);

  check("images no note mentioned before are left alone", exists("School/kept.png"), true);
  r = await saveNote("School/B.md", "# B\n![[shared.png]]\n![[one.png]]\nmore text\n");
  check("an ordinary edit trashes nothing", r, { removed: [], restored: [] });

  fs.rmSync(vault, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
