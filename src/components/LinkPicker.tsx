"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type LinkChoice =
  | { kind: "new"; name: string }
  | { kind: "note"; target: string }
  | { kind: "chat"; id: string; title: string }
  | { kind: "url"; url: string };

type Props = {
  /** Where to show it (under the selection), in viewport pixels. */
  x: number;
  y: number;
  /** The selected text: what a new page is named after, unless something is typed. */
  text: string;
  notes: { name: string; folder: string }[];
  chats: { id: string; title: string; detail: string }[];
  onPick: (choice: LinkChoice) => void;
  onClose: () => void;
};

/** "example.com/x" or "https://…": something to link to on the web. */
function asUrl(q: string): string | null {
  const t = q.trim();
  if (/^(https?:\/\/|mailto:)\S+$/i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`;
  return null;
}

const MAX_EACH = 6;

/**
 * Link the selected text to something: a note, a chat, a web address, or a
 * new page named after it. Type to search notes and chats, or paste a link.
 * ↑↓ to move, ↵ to pick, Esc to close.
 */
export default function LinkPicker({ x, y, text, notes, chats, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { key: string; label: string; detail?: string; kind: string; choice: LinkChoice }[] = [];
    const url = asUrl(query);
    if (url) out.push({ key: "url", label: url, kind: "Web link", choice: { kind: "url", url } });
    const name = (query.trim() || text).slice(0, 100);
    const matchNote = notes.filter((n) => !q || n.name.toLowerCase().includes(q)).slice(0, MAX_EACH);
    // A name used by more than one note is linked by its path, so it points at the right one.
    const shared = (n: string) => notes.filter((m) => m.name.toLowerCase() === n.toLowerCase()).length > 1;
    // Nothing typed: "New page" first, so ⌘K ↵ links a page of the selected text, as before.
    // Typing a search: what it matches first, and making a new page last.
    const offerNew = !url && !matchNote.some((n) => n.name.toLowerCase() === name.toLowerCase());
    const newPage = { key: "new", label: `New page “${name}”`, kind: "Create", choice: { kind: "new" as const, name } };
    if (offerNew && !q) out.push(newPage);
    for (const n of matchNote) {
      out.push({ key: `n:${n.folder}/${n.name}`, label: n.name, detail: n.folder || undefined, kind: "Page", choice: { kind: "note", target: shared(n.name) && n.folder ? `${n.folder}/${n.name}` : n.name } });
    }
    for (const c of chats.filter((c) => !q || c.title.toLowerCase().includes(q)).slice(0, MAX_EACH)) {
      out.push({ key: `c:${c.id}`, label: c.title, detail: c.detail, kind: "Chat", choice: { kind: "chat", id: c.id, title: c.title } });
    }
    if (offerNew && q) out.push(newPage);
    return out;
  }, [query, text, notes, chats]);

  useEffect(() => setActive(0), [query]);

  // Click outside closes it.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [onClose]);

  // Keep it on screen.
  const left = Math.max(8, Math.min(x, window.innerWidth - 336));
  const top = Math.min(y, window.innerHeight - 340);

  return (
    <div ref={box} style={{ left, top }} className="fixed z-50 w-80 overflow-hidden rounded-lg border border-line bg-bg text-sm shadow-lg">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + options.length) % Math.max(options.length, 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const o = options[active];
            if (o) onPick(o.choice);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // don't also close panels elsewhere in the app
            onClose();
          }
        }}
        placeholder="Search pages and chats, or paste a link"
        className="w-full border-b border-line bg-transparent px-3 py-2 outline-none placeholder:text-muted"
      />
      <div className="max-h-72 overflow-y-auto p-1">
        {options.length === 0 && <p className="px-2.5 py-2 text-muted">Nothing matches</p>}
        {options.map((o, i) => (
          <button
            key={o.key}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(o.choice)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left ${i === active ? "bg-hover" : ""}`}
          >
            <span className="w-14 shrink-0 text-[11px] text-muted">{o.kind}</span>
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.detail && <span className="max-w-24 shrink-0 truncate text-xs text-muted">{o.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
