"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Props = {
  tabs: string[];
  /** The open note (null: none). */
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Dragged: put the tab at `index` among the tabs. */
  onMove: (path: string, index: number) => void;
};

/**
 * The open notes as tabs, above the note (and the AI panel beside it). Click to
 * switch, × or a middle-click to close, drag to reorder (the other tabs make
 * room as it passes them). Too many to fit: the row scrolls.
 */
export default function NoteTabs({ tabs, active, onSelect, onClose, onMove }: Props) {
  const row = useRef<HTMLDivElement>(null);
  // A press on a tab, and once it has moved a few pixels, a drag: `grab` is where in the tab it was held.
  // `stop` removes its window listeners.
  const press = useRef<{ path: string; startX: number; grab: number; dragging: boolean; stop: () => void } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const pointerX = useRef(0);
  const suppressClick = useRef(false);
  const tabsNow = useRef(tabs); // for the drag's window listeners
  tabsNow.current = tabs;
  const moveNow = useRef(onMove);
  moveNow.current = onMove;

  // Keep the active tab in view (opened from the sidebar, it may be off to the side).
  useEffect(() => {
    if (!press.current?.dragging) row.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs]);

  const tabEl = (path: string) => [...(row.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])].find((el) => el.dataset.path === path);

  /** Draw the dragged tab under the pointer: shifted from wherever it sits in the row now. */
  const follow = () => {
    const p = press.current;
    const el = p?.dragging ? tabEl(p.path) : null;
    if (!p || !el || !row.current) return;
    // offsetLeft ignores the transform, and is from the row's padding edge (the row is `relative`).
    const home = row.current.getBoundingClientRect().left + row.current.clientLeft + el.offsetLeft - row.current.scrollLeft;
    el.style.transform = `translateX(${pointerX.current - p.grab - home}px)`;
  };
  // After a reorder the tab sits somewhere new: shift it again so it stays under the pointer.
  useLayoutEffect(follow, [tabs]);

  // Followed on the window, not the tab: a tab moved in the row loses its pointer capture.
  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    pointerX.current = e.clientX;
    if (!p.dragging) {
      if (Math.abs(e.clientX - p.startX) < 5) return;
      p.dragging = true;
      setDragging(p.path);
    }
    follow();
    // Where it goes: before the first other tab whose middle is past the dragged tab's middle.
    const el = tabEl(p.path)!;
    const mid = e.clientX - p.grab + el.offsetWidth / 2;
    const tabs = tabsNow.current;
    const others = tabs.filter((t) => t !== p.path);
    let index = others.findIndex((t) => {
      const r = tabEl(t)?.getBoundingClientRect();
      return r && mid < r.left + r.width / 2;
    });
    if (index < 0) index = others.length;
    if (index !== tabs.indexOf(p.path)) moveNow.current(p.path, index);
  };

  const endDrag = () => {
    const p = press.current;
    press.current = null;
    p?.stop();
    if (!p?.dragging) return;
    const el = tabEl(p.path);
    if (el) el.style.transform = "";
    suppressClick.current = true; // the click that ends a drag doesn't select
    setTimeout(() => (suppressClick.current = false));
    setDragging(null);
  };

  return (
    <div
      ref={row}
      role="tablist"
      aria-label="Open notes"
      className="relative flex h-10 shrink-0 items-end gap-px overflow-x-auto border-b border-line bg-panel px-2 [scrollbar-width:none]"
      onWheel={(e) => {
        // A vertical wheel scrolls the row sideways.
        if (row.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) row.current.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((path) => {
        const on = path === active;
        const name = path.split("/").pop()!.replace(/\.md$/i, "");
        return (
          <div
            key={path}
            role="tab"
            aria-selected={on}
            data-path={path}
            title={path}
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as Element).closest("button")) return;
              press.current?.stop();
              const stop = () => {
                window.removeEventListener("pointermove", onPointerMove);
                window.removeEventListener("pointerup", endDrag);
                window.removeEventListener("pointercancel", endDrag);
              };
              press.current = { path, startX: e.clientX, grab: e.clientX - e.currentTarget.getBoundingClientRect().left, dragging: false, stop };
              window.addEventListener("pointermove", onPointerMove);
              window.addEventListener("pointerup", endDrag);
              window.addEventListener("pointercancel", endDrag);
            }}
            onClick={() => !suppressClick.current && onSelect(path)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(path);
              }
            }}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()} // no autoscroll on middle-click
            className={`group relative -mb-px flex h-8 max-w-52 min-w-28 shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 pr-1 pl-3 text-[13px] select-none ${
              on ? "border-line bg-bg text-fg" : "border-transparent text-muted hover:bg-hover hover:text-fg"
            } ${dragging === path ? "z-10 border-line bg-bg shadow-md" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
              title="Close tab"
              aria-label={`Close ${name}`}
              className={`flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg ${on ? "" : "opacity-0 group-hover:opacity-100"}`}
            >
              <svg className="size-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
