import type { ElementContent, Parent, Root, Text } from "hast";

/**
 * Rehype plugin for a reply that's still streaming in: wraps the text of each
 * arrival ("chunk") in its own <span class="stream-chunk">, which fades in
 * once, when it first appears.
 *
 * `starts` are the Markdown offsets where each chunk began, in order. Text
 * nodes carry their offsets in the Markdown, so each one is split at those
 * points. Earlier chunks keep the same spans (react-markdown keys elements by
 * tag and position: span-0, span-1, ...), so React leaves them alone and they
 * don't fade again; only the new span at the end animates.
 */
export function rehypeFade({ starts, source }: { starts: number[]; source: string }) {
  return (tree: Root) => {
    if (!starts.length) return;
    const walk = (parent: Parent) => {
      const next: ElementContent[] = [];
      for (const child of parent.children as ElementContent[]) {
        if (child.type === "text") next.push(...split(child, starts, source));
        else {
          if ("children" in child) walk(child);
          next.push(child);
        }
      }
      parent.children = next;
    };
    walk(tree);
  };
}

function split(node: Text, starts: number[], source: string): ElementContent[] {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined || !node.value) return [node];
  // Usually the text is exactly its slice of the Markdown. In code blocks the
  // slice includes the ``` fences, so find the text inside it; otherwise
  // (escapes, entities) give up on fading this node.
  let base = from;
  if (to - from !== node.value.length) {
    const at = source.slice(from, to).indexOf(node.value);
    if (at < 0) return [node];
    base = from + at;
  }
  const end = base + node.value.length;

  // The first chunk that reaches into this text (binary search: starts is sorted).
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= base) lo = mid;
    else hi = mid - 1;
  }

  const out: ElementContent[] = [];
  for (let i = lo; i < starts.length && starts[i] < end; i++) {
    const a = Math.max(starts[i], base);
    const b = Math.min(starts[i + 1] ?? end, end);
    if (b <= a) continue;
    out.push({
      type: "element",
      tagName: "span",
      properties: { className: ["stream-chunk"] },
      children: [{ type: "text", value: node.value.slice(a - base, b - base) }],
    });
  }
  return out.length ? out : [node];
}
