// The note assistant's create_note: create-only, never overwrites. Run: npm run test:create-note
// Uses a throwaway vault in the OS temp folder, never your notes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vault-"));
process.env.FLOW_VAULT_PATH = vault;

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fails++;
};

(async () => {
  const { cleanNoteName, createNoteWithContent } = await import("../src/lib/vault");
  fs.mkdirSync(path.join(vault, "School"));
  fs.writeFileSync(path.join(vault, "School", "Ideas.md"), "original");

  const a = await createNoteWithContent("School", "Ideas", "new");
  check("a taken name gets a number", a === "School/Ideas 1.md", a);
  check("the existing note is untouched", fs.readFileSync(path.join(vault, "School", "Ideas.md"), "utf8") === "original");
  check("the new page has its content", fs.readFileSync(path.join(vault, a), "utf8") === "new");
  check("names are cleaned", cleanNoteName('a/b: "c"?.md') === "a b c", cleanNoteName('a/b: "c"?.md'));
  const evil = await createNoteWithContent("", "../../evil", "x");
  check("no escaping the folder (and no hidden file)", evil === "evil.md", evil);
  const missing = await createNoteWithContent("Nope", "x", "x").then(() => "created", (e: Error) => e.message);
  check("a missing folder is an error", missing === "Not found", missing);
  const outside = await createNoteWithContent("../..", "x", "x").then(() => "created", (e: Error) => e.message);
  check("a folder outside the vault is refused", outside === "Invalid path", outside);
  fs.rmSync(vault, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
