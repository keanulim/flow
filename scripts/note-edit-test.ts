// The note assistant's edit tool on an in-memory note. Run: npm run test:note-edit
import { applyEdit } from "../src/lib/note-edit";
let fails = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) fails++; };
const note = "# Ideas\n\n- one\n- two\n- two\n\nend";

const v = applyEdit(note, { command: "view" });
check("view numbers the lines", v.output.startsWith("1\t# Ideas") && v.output.includes("7\tend") && !v.changed);
check("view a range", applyEdit(note, { command: "view", view_range: [3, 4] }).output === "3\t- one\n4\t- two");
const r = applyEdit(note, { command: "str_replace", old_str: "- one", new_str: "- uno" });
check("str_replace one match", r.note.includes("- uno") && r.changed && !r.error);
check("str_replace: several matches is an error", applyEdit(note, { command: "str_replace", old_str: "- two", new_str: "x" }).error === true);
check("str_replace: no match is an error, note untouched", (() => { const x = applyEdit(note, { command: "str_replace", old_str: "nope", new_str: "x" }); return x.error === true && x.note === note; })());
check("str_replace: $ in new text is literal", applyEdit(note, { command: "str_replace", old_str: "end", new_str: "costs $& $1" }).note.endsWith("costs $& $1"));
const ins = applyEdit(note, { command: "insert", insert_line: 0, insert_text: "top\n" });
check("insert at the start", ins.note.startsWith("top\n# Ideas"));
check("insert after the last line", applyEdit(note, { command: "insert", insert_line: 7, insert_text: "after" }).note.endsWith("end\nafter"));
check("insert out of range is an error", applyEdit(note, { command: "insert", insert_line: 99, insert_text: "x" }).error === true);
check("create rewrites the note", applyEdit(note, { command: "create", file_text: "new" }).note === "new");
check("unknown command is an error", applyEdit(note, { command: "delete" }).error === true);
check("path is ignored (only this note can change)", applyEdit(note, { command: "create", path: "../../etc/passwd", file_text: "x" }).note === "x");
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
