/**
 * Math in Markdown: `$x$` and `\(x\)` inline, `$$ … $$` and `\[ … \]` as a
 * display block. Shared by chat replies (remark-math) and the note editor.
 *
 * Single dollars are ambiguous: "it costs $800 and $900" is not a formula.
 * remark-math's own single-dollar rule would render "800 and " as math, so it
 * runs with single dollars off, and this module decides which `$…$` are
 * math using Pandoc's rule instead:
 *  - the opening `$` is followed by a non-space,
 *  - the closing `$` comes right after a non-space and isn't followed by a digit.
 * Those are rewritten as `$$…$$`, which remark-math reads as inline math.
 *
 * Code (fenced blocks and `inline code`) is never touched.
 */

/** `$x$` by Pandoc's rule. Not `\$`, not part of `$$`, not after a letter or digit (US$5). */
const SINGLE = /(?<![\\$\w])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?![\d$])/g;
const DOUBLE = /(?<![\\$])\$\$(?=\S)([^\n]*?\S)\$\$(?!\$)/g;
const PAREN = /\\\((.+?)\\\)/g;
const BRACKET = /\\\[([\s\S]+?)\\\]/g;
const FENCE = /^\s*(```|~~~)/;

/** Rewrite a reply's math into the forms remark-math reads with single dollars off. */
export function normalizeMath(md: string): string {
  if (!/[$\\]/.test(md)) return md; // nothing that could be math
  return mapProse(md, (text) =>
    text
      .replace(BRACKET, (_, tex: string) => `\n$$\n${tex.trim()}\n$$\n`)
      // A line that's only $$…$$ is a display formula; remark-math needs it on separate lines for that.
      // (Before the rewrites below, which produce $$…$$ that should stay inline.)
      .replace(/^([ \t]*)\$\$(?=\S)([^\n]*?\S)\$\$[ \t]*$/gm, (_, indent: string, tex: string) => `${indent}$$\n${indent}${tex}\n${indent}$$`)
      .replace(PAREN, (_, tex: string) => `$$${tex.trim()}$$`)
      .replace(SINGLE, (_, tex: string) => `$$${tex}$$`),
  );
}

/** Apply `fn` to the Markdown outside code, keeping code exactly as it is. */
function mapProse(md: string, fn: (text: string) => string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (prose.length) out.push(withoutInlineCode(prose.join("\n"), fn));
    prose = [];
  };
  for (const line of md.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (f === fence) fence = null;
    } else if (f) {
      flush();
      fence = f;
      out.push(line);
    } else prose.push(line);
  }
  flush();
  return out.join("\n");
}

/** `inline code` spans are swapped for placeholders while `fn` runs, then put back. */
function withoutInlineCode(text: string, fn: (text: string) => string): string {
  const spans: string[] = [];
  const masked = text.replace(/(`+)[^`][\s\S]*?\1/g, (code) => `\u0000${spans.push(code) - 1}\u0000`);
  return fn(masked).replace(/\u0000(\d+)\u0000/g, (_, i: string) => spans[+i]);
}

export type InlineMath = { from: number; to: number; tex: string };

/** Inline formulas in one line of a note (offsets within the line), skipping `code`. For the editor. */
export function findInlineMath(line: string): InlineMath[] {
  if (!/[$\\]/.test(line)) return [];
  const code: [number, number][] = [];
  for (const m of line.matchAll(/(`+)[^`].*?\1/g)) code.push([m.index, m.index + m[0].length]);
  const inCode = (a: number, b: number) => code.some(([x, y]) => a < y && b > x);
  const found: InlineMath[] = [];
  const taken = (a: number, b: number) => found.some((f) => a < f.to && b > f.from);
  for (const re of [DOUBLE, PAREN, SINGLE]) {
    for (const m of line.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      if (!inCode(from, to) && !taken(from, to)) found.push({ from, to, tex: m[1].trim() });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/** A line that opens or closes a display block in a note: `$$` or `\[` / `\]` alone on the line. */
export const DISPLAY_OPEN = /^\s*(\$\$|\\\[)\s*$/;
export const displayClose = (open: string) => (open.trim() === "$$" ? /^\s*\$\$\s*$/ : /^\s*\\\]\s*$/);
/** A whole line that is one display formula: `$$x$$` or `\[x\]`. */
export const DISPLAY_LINE = /^\s*(?:\$\$(?=\S)(.*?\S)\$\$|\\\[(.+?)\\\])\s*$/;
