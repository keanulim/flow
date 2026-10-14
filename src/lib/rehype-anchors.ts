import type { Element, ElementContent, Parent, Root, Text } from "hast";

export type Anchor = { threadId: string; text: string; active: boolean; oneOff?: boolean };

/**
 * Rehype plugin: wraps each side thread's anchor text in a <mark data-thread-id>
 * so the highlight itself becomes the link to its side thread.
 *
 * Matching ignores whitespace, because Selection.toString() and the rendered
 * tree disagree about newlines between blocks. Works across element
 * boundaries: an anchor spanning "plain **bold**" becomes two marks.
 */
export function rehypeAnchors({ anchors }: { anchors: Anchor[] }) {
  return (tree: Root) => {
    if (!anchors.length) return;

    // 1. Text nodes in document order, plus a whitespace-free flat string
    //    where every char remembers which text node and offset it came from.
    const texts: { node: Text; parent: Parent }[] = [];
    const walk = (parent: Parent) => {
      for (const child of parent.children) {
        if (child.type === "text") texts.push({ node: child, parent });
        else if ("children" in child) walk(child);
      }
    };
    walk(tree);

    let flat = "";
    const origin: { t: number; off: number }[] = [];
    texts.forEach(({ node }, t) => {
      for (let off = 0; off < node.value.length; off++) {
        if (/\s/.test(node.value[off])) continue;
        flat += node.value[off];
        origin.push({ t, off });
      }
    });

    // 2. Per text node, the [start, end) ranges to wrap. Overlapping anchors
    //    are skipped rather than nested.
    const ranges = new Map<number, { start: number; end: number; anchor: Anchor }[]>();
    for (const anchor of anchors) {
      const needle = anchor.text.replace(/\s+/g, "");
      const pos = needle ? flat.indexOf(needle) : -1;
      if (pos === -1) continue;

      const pieces = new Map<number, { start: number; end: number }>();
      for (let i = pos; i < pos + needle.length; i++) {
        const { t, off } = origin[i];
        const p = pieces.get(t);
        if (p) p.end = off + 1;
        else pieces.set(t, { start: off, end: off + 1 });
      }
      const overlaps = [...pieces].some(([t, p]) =>
        (ranges.get(t) ?? []).some((r) => p.start < r.end && r.start < p.end),
      );
      if (overlaps) continue;
      for (const [t, p] of pieces) ranges.set(t, [...(ranges.get(t) ?? []), { ...p, anchor }]);
    }

    // 3. Split each affected text node into text / mark / text pieces.
    const replacements = new Map<Text, ElementContent[]>();
    for (const [t, rs] of ranges) {
      const { value } = texts[t].node;
      const out: ElementContent[] = [];
      let cursor = 0;
      for (const r of rs.sort((a, b) => a.start - b.start)) {
        if (r.start > cursor) out.push({ type: "text", value: value.slice(cursor, r.start) });
        out.push(mark(r.anchor, value.slice(r.start, r.end)));
        cursor = r.end;
      }
      if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
      replacements.set(texts[t].node, out);
    }
    const parents = new Set(texts.filter(({ node }) => replacements.has(node)).map(({ parent }) => parent));
    for (const parent of parents) {
      parent.children = parent.children.flatMap((c) =>
        c.type === "text" && replacements.has(c) ? replacements.get(c)! : [c],
      ) as Parent["children"];
    }
  };
}

function mark(anchor: Anchor, value: string): Element {
  return {
    type: "element",
    tagName: "mark",
    properties: {
      dataThreadId: anchor.threadId,
      className: ["anchor", anchor.oneOff && "oneoff", anchor.active && "active"].filter(Boolean) as string[],
      title: anchor.oneOff ? "Open side question" : "Open side thread",
    },
    children: [{ type: "text", value }],
  };
}
