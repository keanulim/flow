"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Thread } from "@/lib/db";

const ROW = 28; // px per node row
const INDENT = 16; // px per nesting level
const X0 = 12; // x of the root node

type Props = {
  threads: Thread[];
  rootId: string;
  focusId: string; // thread in the center pane
  sideId: string | null; // thread open in the side panel, if any
  counts: Map<string, number>; // messages per thread
  streaming: Set<string>;
  onNavigate: (id: string) => void; // show this thread in the center, keep keyboard focus here
  onExit: () => void; // leave the map (Enter / Esc)
  ref?: React.Ref<HTMLDivElement>; // the focusable element, so the sidebar can focus it
};

/**
 * The conversation tree as a node graph. Layout is a depth-first walk: one row
 * per thread, x by nesting depth. Positions only change when threads are
 * added, so the map stays stable enough to navigate by muscle memory.
 */
export default function ThreadMap({ threads, rootId, focusId, sideId, counts, streaming, onNavigate, onExit, ref }: Props) {
  // Read the saved preference after mount: the server render has no
  // localStorage, so reading it during render would cause a hydration mismatch.
  const [collapse, setCollapse] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem("flow.map.collapse") === "0") setCollapse(false);
    } catch {}
  }, []);
  const toggleCollapse = () =>
    setCollapse((c) => {
      try {
        localStorage.setItem("flow.map.collapse", c ? "0" : "1");
      } catch {}
      return !c;
    });

  // The path from main down to where you are. Computed from *all* threads,
  // since collapsing decides visibility based on it.
  const onPath = useMemo(() => {
    const parent = new Map(threads.map((t) => [t.id, t.parentThreadId]));
    const path = new Set<string>();
    for (let id: string | null | undefined = focusId; id && parent.has(id); id = parent.get(id)) path.add(id);
    return path;
  }, [threads, focusId]);

  // Collapsed mode: a thread's children are shown only if it's on your path.
  // You see where you are, the siblings at every level above, and one level down.
  const visible = useMemo(
    () => (collapse ? threads.filter((t) => !t.parentThreadId || onPath.has(t.parentThreadId)) : threads),
    [collapse, threads, onPath],
  );
  const hiddenUnder = useMemo(() => countHidden(threads, new Set(visible.map((t) => t.id))), [threads, visible]);

  const nodes = useMemo(() => layout(visible, rootId), [visible, rootId]);
  const byId = new Map(nodes.map((n) => [n.thread.id, n]));
  const [active, setActive] = useState(false); // keyboard focus is in the map
  const [hovered, setHovered] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());

  // Keep the current node visible while moving through a long map.
  useEffect(() => {
    rows.current.get(focusId)?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  /** WASD (or arrows): W/S = previous/next sibling, A = parent, D = child. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = byId.get(focusId)?.thread;
    if (!cur) return;
    const parentId = cur.parentThreadId;
    const siblings = parentId ? childrenOf(nodes, parentId) : [cur];
    const i = siblings.findIndex((t) => t.id === cur.id);
    let next: string | undefined;

    switch (e.key) {
      case "w": case "W": case "ArrowUp":
        next = siblings[i - 1]?.id;
        break;
      case "s": case "S": case "ArrowDown":
        next = siblings[i + 1]?.id;
        break;
      case "a": case "A": case "ArrowLeft":
        next = parentId ?? undefined;
        break;
      case "d": case "D": case "ArrowRight":
        next = childrenOf(nodes, cur.id)[0]?.id;
        break;
      case "Enter": case "Escape":
        onExit();
        break;
      default:
        return; // let every other key behave normally
    }
    // Handled: don't scroll the sidebar, and don't let the window-level
    // shortcuts (Esc = close panel / go up) also react.
    e.preventDefault();
    e.stopPropagation();
    if (next) onNavigate(next);
  };

  const radius = (id: string) => (id === rootId ? 6 : 3.5 + Math.min(3, (counts.get(id) ?? 0) / 4));
  const height = nodes.length * ROW;

  // Each edge runs from its parent's dot, so siblings share the vertical
  // stretch above them. Gray edges are painted first and lit ones last, or a
  // later sibling's gray line would be drawn over the highlighted path.
  const edges = nodes
    .flatMap(({ thread, x, y }) => {
      const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
      if (!parent) return [];
      const lit = onPath.has(thread.id) || (thread.id === sideId && onPath.has(parent.thread.id));
      const d = `M ${parent.x} ${parent.y + radius(parent.thread.id)} V ${y - 6} Q ${parent.x} ${y} ${parent.x + 6} ${y} H ${x - radius(thread.id)}`;
      return [{ id: thread.id, d, lit }];
    })
    .sort((a, b) => Number(a.lit) - Number(b.lit));

  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      className="outline-none"
    >
      <div className="flex items-baseline justify-between px-2 pt-3 pb-1">
        <span className="flex items-baseline gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">Map</span>
          <button
            onClick={toggleCollapse}
            className="text-[11px] text-muted hover:text-fg"
            title={collapse ? "Showing your path only. Click to show every thread." : "Showing every thread. Click to show your path only."}
          >
            {collapse ? "path" : "all"}
          </button>
        </span>
        <span
          title="W/S: siblings · A: parent · D: child · Enter: exit"
          className={`whitespace-nowrap text-[11px] text-muted transition-opacity ${active ? "opacity-100" : "opacity-0"}`}
        >
          WASD to move · ↵ exit
        </span>
      </div>
      <div className="relative" style={{ height }}>
        {/* Layer 1: row highlights, painted *under* the graph so they never hide its lines. */}
        {nodes.map(({ thread, y }) => {
          const id = thread.id;
          const cursor = id === focusId && active;
          if (!cursor && id !== hovered) return null;
          return (
            <div
              key={`h-${id}`}
              style={{ top: y - ROW / 2, height: ROW }}
              className={`absolute inset-x-0 rounded-md ${cursor ? "bg-hover ring-1 ring-accent/40" : "bg-hover/70"}`}
            />
          );
        })}

        {/* Layer 2: edges and nodes. */}
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width="100%" height={height}>
          {edges.map(({ id, d, lit }) => (
            <path
              key={`e-${id}`}
              d={d}
              fill="none"
              stroke={lit ? "var(--accent)" : "var(--line)"}
              strokeWidth={lit ? 1.75 : 1.25}
            />
          ))}
          {nodes.map(({ thread, x, y }) => {
            const id = thread.id;
            const isFocus = id === focusId;
            const isSide = id === sideId;
            return (
              <g key={`n-${id}`}>
                {isFocus && <circle cx={x} cy={y} r={radius(id) + 5} fill="var(--accent)" opacity={0.15} />}
                <circle
                  cx={x}
                  cy={y}
                  r={radius(id)}
                  fill={isFocus || isSide || onPath.has(id) ? "var(--accent)" : "var(--muted)"}
                  opacity={isFocus || onPath.has(id) || isSide ? 1 : 0.55}
                  stroke={isSide ? "var(--accent)" : "none"}
                  strokeWidth={isSide ? 2 : 0}
                  className={streaming.has(id) ? "animate-pulse" : undefined}
                />
                {isSide && <circle cx={x} cy={y} r={radius(id) + 3} fill="none" stroke="var(--accent)" strokeWidth={1.25} />}
              </g>
            );
          })}
        </svg>

        {/* Layer 3: transparent click targets and labels. */}
        {nodes.map(({ thread, depth, y }) => {
          const id = thread.id;
          const isFocus = id === focusId;
          return (
            <button
              key={`l-${id}`}
              ref={(el) => {
                if (el) rows.current.set(id, el);
                else rows.current.delete(id);
              }}
              tabIndex={-1}
              onClick={() => onNavigate(id)}
              onMouseEnter={() => setHovered(id)}
              onMouseLeave={() => setHovered((h) => (h === id ? null : h))}
              title={thread.anchorText ? `“${thread.anchorText}”` : thread.title}
              style={{ top: y - ROW / 2, height: ROW, paddingLeft: X0 + depth * INDENT + 12 }}
              className={`absolute inset-x-0 flex items-center truncate pr-2 text-left text-[13px] ${
                isFocus ? "font-medium text-fg" : id === sideId || onPath.has(id) ? "text-fg" : "text-muted hover:text-fg"
              }`}
            >
              <span className="truncate">{id === rootId ? "Main" : thread.title}</span>
              {hiddenUnder.get(id) ? (
                <span className="ml-1.5 shrink-0 text-[11px] text-muted" title={`${hiddenUnder.get(id)} hidden thread(s) below`}>
                  +{hiddenUnder.get(id)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** For each visible thread, how many of its descendants are hidden. */
function countHidden(threads: Thread[], visible: Set<string>): Map<string, number> {
  const kids = new Map<string, string[]>();
  for (const t of threads) if (t.parentThreadId) kids.set(t.parentThreadId, [...(kids.get(t.parentThreadId) ?? []), t.id]);
  const descendants = (id: string): number =>
    (kids.get(id) ?? []).reduce((n, c) => n + 1 + descendants(c), 0);
  const out = new Map<string, number>();
  for (const id of visible) {
    const hidden = (kids.get(id) ?? []).filter((c) => !visible.has(c));
    if (hidden.length) out.set(id, hidden.reduce((n, c) => n + 1 + descendants(c), 0));
  }
  return out;
}

function childrenOf(nodes: Node[], parentId: string): Thread[] {
  // Same order as the layout, so W/S move exactly as the map reads.
  return nodes.filter((n) => n.thread.parentThreadId === parentId).map((n) => n.thread);
}

type Node = { thread: Thread; depth: number; x: number; y: number };

function layout(threads: Thread[], rootId: string): Node[] {
  const children = new Map<string, Thread[]>();
  for (const t of threads) {
    if (!t.parentThreadId) continue;
    children.set(t.parentThreadId, [...(children.get(t.parentThreadId) ?? []), t]);
  }
  const root = threads.find((t) => t.id === rootId);
  if (!root) return [];

  const out: Node[] = [];
  const visit = (t: Thread, depth: number) => {
    out.push({ thread: t, depth, x: X0 + depth * INDENT, y: out.length * ROW + ROW / 2 });
    for (const c of (children.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)) visit(c, depth + 1);
  };
  visit(root, 0);
  return out;
}
