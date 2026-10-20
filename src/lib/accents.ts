import type { ElementContent, Parent, Root } from "hast";

/**
 * A letter with a combining accent typed as plain text, like θ̂ (θ + U+0302),
 * μ̃ or x̄. Inter has no combining accents, so the browser draws the hat with a
 * fallback font, which can't place it over a Greek letter (it lands beside it).
 * These few characters are drawn in a font that positions accents properly
 * (STIX Two Text on macOS, Cambria Math on Windows, KaTeX's own font
 * elsewhere): `.accented` in globals.css, `.cm-accent` in the editor.
 */
export const ACCENTED = /\p{L}[̀-ͯ⃐-⃿]+/gu;

/** Rehype plugin for chat replies: wrap accented letters in <span class="accented">. Skips code and math. */
export function rehypeAccents() {
  return (tree: Root) => {
    const walk = (parent: Parent) => {
      const next: ElementContent[] = [];
      for (const child of parent.children as ElementContent[]) {
        if (child.type === "element") {
          const cls = (child.properties.className as string[] | undefined) ?? [];
          if (!["code", "pre"].includes(child.tagName) && !cls.includes("katex")) walk(child);
          next.push(child);
        } else if (child.type === "text" && ACCENTED.test(child.value)) {
          ACCENTED.lastIndex = 0;
          let last = 0;
          for (const m of child.value.matchAll(ACCENTED)) {
            if (m.index! > last) next.push({ type: "text", value: child.value.slice(last, m.index) });
            next.push({ type: "element", tagName: "span", properties: { className: ["accented"] }, children: [{ type: "text", value: m[0] }] });
            last = m.index! + m[0].length;
          }
          if (last < child.value.length) next.push({ type: "text", value: child.value.slice(last) });
        } else next.push(child);
      }
      parent.children = next;
    };
    walk(tree);
  };
}
