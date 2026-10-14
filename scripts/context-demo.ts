// Proves context isolation with in-memory data: no DB, no API calls.
// Run: npx tsx scripts/context-demo.ts
import { buildContext, type ContextLoader } from "../src/lib/context";
import type { Message, Thread } from "../src/lib/db";

const threads: Thread[] = [];
const messages: Message[] = [];
let clock = 0;

const thread = (id: string, parent: string | null = null, fork: string | null = null, anchor: string | null = null) =>
  threads.push({ id, parentThreadId: parent, forkMessageId: fork, anchorText: anchor, title: id, kind: "thread", createdAt: clock++ });
const msg = (id: string, threadId: string, role: Message["role"], content: string) =>
  messages.push({ id, threadId, role, content, createdAt: clock++ });

const load: ContextLoader = {
  getThread: (id) => threads.find((t) => t.id === id),
  getMessages: (tid) => messages.filter((m) => m.threadId === tid),
};

// Main conversation
thread("main");
msg("m1", "main", "user", "Explain how a B-tree works.");
msg("m2", "main", "assistant", "A B-tree is a self-balancing tree... nodes split when they exceed the fanout...");

// Side question forked off m2, about a highlighted phrase
thread("side", "main", "m2", "nodes split when they exceed the fanout");
msg("s1", "side", "user", "What does fanout mean?");
msg("s2", "side", "assistant", "Fanout is the max number of children per node.");

// Main conversation keeps going AFTER the fork
msg("m3", "main", "user", "How does that compare to an LSM tree?");
msg("m4", "main", "assistant", "LSM trees buffer writes in memory...");

// A side question on the side question (nested)
thread("nested", "side", "s2");
msg("n1", "nested", "user", "Is fanout the same as branching factor?");

for (const id of ["main", "side", "nested"]) {
  const { messages: ctx, inheritedUntil } = buildContext(id, load);
  console.log(`\n=== what "${id}" sends to the model (inherited through index ${inheritedUntil}) ===`);
  ctx.forEach((m, i) =>
    console.log(`  [${i}] ${m.role.padEnd(9)} ${String(m.content).replace(/\n/g, " ⏎ ").slice(0, 110)}`),
  );
}

// Assertions, so this is a test and not just a printout
const sent = (id: string) => buildContext(id, load).messages.map((m) => String(m.content)).join("\n");
const check = (label: string, ok: boolean) => console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
console.log();
check("main never sees the side question", !sent("main").includes("fanout mean"));
check("side sees main up to the fork", sent("side").includes("B-tree"));
check("side does NOT see main messages after the fork", !sent("side").includes("LSM"));
check("side's first question carries the excerpt", sent("side").includes("<excerpt>"));
check("nested inherits main + side history", sent("nested").includes("B-tree") && sent("nested").includes("max number of children"));
check("nested does not see main's later turns", !sent("nested").includes("LSM"));
