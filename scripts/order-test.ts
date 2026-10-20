// Arranging files by dragging: the saved order, and keeping it right through renames, moves and deletes.
// Run: npm run test:order. Uses a throwaway vault in the OS temp folder, never your notes.
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

(async () => {
  const v = await import("../src/lib/vault");
  type E = Awaited<ReturnType<typeof v.listVault>>[number];
  const names = (list: E[]) => list.map((e) => e.name);
  const inFolder = async (folder: string) => {
    let list = await v.listVault();
    for (const part of folder ? folder.split("/") : []) list = (list.find((e) => e.name === part) as Extract<E, { type: "folder" }>).children;
    return names(list);
  };
  fs.mkdirSync(path.join(vault, "School"));
  for (const n of ["a.md", "b.md", "c.md"]) fs.writeFileSync(path.join(vault, n), "");
  fs.writeFileSync(path.join(vault, "School", "x.md"), "");

  check("never arranged: folders first, then A to Z", await inFolder(""), ["School", "a.md", "b.md", "c.md"]);
  await v.placeEntry("c.md", "", "a.md");
  check("drag c above a", await inFolder(""), ["School", "c.md", "a.md", "b.md"]);
  await v.placeEntry("School", "", null);
  check("drag the folder to the end", await inFolder(""), ["c.md", "a.md", "b.md", "School"]);
  await v.placeEntry("a.md", "School", "x.md");
  check("drag a into School, above x", [await inFolder(""), await inFolder("School")], [["c.md", "b.md", "School"], ["a.md", "x.md"]]);
  await v.moveEntry("b.md", "renamed.md");
  check("a rename keeps its spot", await inFolder(""), ["c.md", "renamed.md", "School"]);
  fs.writeFileSync(path.join(vault, "new.md"), "");
  check("something new goes after the arranged items", await inFolder(""), ["c.md", "renamed.md", "School", "new.md"]);
  await v.moveEntry("School", "Uni");
  check("renaming a folder keeps its own order inside", await inFolder("Uni"), ["a.md", "x.md"]);
  await v.trashEntry("c.md");
  check("deleting removes it from the order", await inFolder(""), ["renamed.md", "Uni", "new.md"]);
  check("the order file is hidden from the tree", (await v.listVault()).some((e) => e.name.startsWith(".")), false);
  const outside = await v.placeEntry("new.md", "../..", null).then(() => "moved", (e: Error) => e.message);
  check("can't arrange into a folder outside the vault", outside, "Invalid path");

  fs.rmSync(vault, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
