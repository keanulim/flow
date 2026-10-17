// Which dollars are math (chat replies and the note editor). Run: npm run test:math
import { findInlineMath, normalizeMath } from "../src/lib/math";
let fails = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
check("prices are not math", normalizeMath("It costs $800 and $900."), "It costs $800 and $900.");
check("a price range is not math", normalizeMath("between $5-$10 a month"), "between $5-$10 a month");
check("$x$ is inline math", normalizeMath("so $x^2 + 1$ grows"), "so $$x^2 + 1$$ grows");
check("price and formula in one line", normalizeMath("pay $5 when $n > 3$"), "pay $5 when $$n > 3$$");
check("\\( \\) is inline math", normalizeMath("where \\(a = b\\) holds"), "where $$a = b$$ holds");
check("\\[ \\] is a display block", normalizeMath("see\n\\[ e^{i\\pi} + 1 = 0 \\]"), "see\n\n$$\ne^{i\\pi} + 1 = 0\n$$\n");
check("a line of only $$…$$ is a display block", normalizeMath("$$\\int_0^1 x\\,dx$$"), "$$\n\\int_0^1 x\\,dx\n$$");
check("$$…$$ mid-sentence stays inline", normalizeMath("then $$x$$ here"), "then $$x$$ here");
check("escaped \\$ is not math", normalizeMath("\\$5 and \\$6"), "\\$5 and \\$6");
check("inline code is untouched", normalizeMath("run `echo $HOME$` and $y$"), "run `echo $HOME$` and $$y$$");
check("fenced code is untouched", normalizeMath("```sh\necho $a$\n```\n$b$"), "```sh\necho $a$\n```\n$$b$$");
check("editor: finds inline formulas, skips prices and code", findInlineMath("pay $5 for $x$, `$y$` and \\(z\\)").map((m) => m.tex), ["x", "z"]);
check("editor: $$…$$ counted once", findInlineMath("a $$b$$ c").map((m) => [m.from, m.to, m.tex]), [[2, 7, "b"]]);
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
