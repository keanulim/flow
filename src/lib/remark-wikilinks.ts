import type { Link, Parent, PhrasingContent, Root, Text } from "mdast";
import { linkTarget } from "./wikilinks";

const LINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
export const NOTE_HREF = "#note="; // preview links point here; NoteEditor intercepts the click

/** Remark plugin: `[[Page]]` / `[[Page|text]]` -> links the notes preview can open. */
export function remarkWikilinks({ exists }: { exists: (target: string) => boolean }) {
  return (tree: Root) => {
    const walk = (node: Parent) => {
      const next: unknown[] = [];
      for (const child of node.children) {
        if (child.type === "text") next.push(...split(child, exists));
        else {
          if ("children" in child && child.type !== "link") walk(child as Parent);
          next.push(child);
        }
      }
      node.children = next as Parent["children"];
    };
    walk(tree);
  };
}

function split(node: Text, exists: (target: string) => boolean): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let last = 0;
  for (const m of node.value.matchAll(LINK)) {
    if (m.index! > last) out.push({ type: "text", value: node.value.slice(last, m.index) });
    const target = linkTarget(m[1]);
    const link: Link = {
      type: "link",
      url: NOTE_HREF + encodeURIComponent(target),
      children: [{ type: "text", value: m[2] ?? m[1] }],
      data: { hProperties: { className: exists(target) ? ["wikilink"] : ["wikilink", "wikilink-new"] } },
    };
    out.push(link);
    last = m.index! + m[0].length;
  }
  if (!out.length) return [node];
  if (last < node.value.length) out.push({ type: "text", value: node.value.slice(last) });
  return out;
}
