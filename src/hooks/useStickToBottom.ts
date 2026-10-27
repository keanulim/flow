"use client";

import { useCallback, useRef } from "react";

/** Sent (on window) by the message box when it changes height, so the lists above it can stay pinned. */
export const COMPOSER_RESIZED = "flow:composer-resized";

/**
 * Keep a scrolling message list pinned to its newest message when the list's
 * own height changes, e.g. the message box below it growing as you type. The
 * browser keeps the scroll position, which would slide the newest messages out
 * of view behind the box; this scrolls them back into view instead, but only
 * if you were already at the bottom (not while you're reading further up).
 *
 * Returns a callback ref for the scrolling element.
 */
export function useStickToBottom() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    // Were you at the bottom before this resize? Worked out from the list's previous height
    // (a resize doesn't move the scroll position or change the content), so it doesn't depend
    // on scroll events, which arrive later and only when the page paints.
    let lastHeight = el.clientHeight;
    const pin = () => {
      const wasAtBottom = el.scrollHeight - el.scrollTop - lastHeight < 48;
      if (wasAtBottom) el.scrollTop = el.scrollHeight;
      lastHeight = el.clientHeight;
    };
    // The message box tells us right away when it grows or shrinks; a ResizeObserver
    // also catches other changes (the window resized), but only fires when the page paints.
    window.addEventListener(COMPOSER_RESIZED, pin);
    const resized = new ResizeObserver(pin);
    resized.observe(el);
    cleanup.current = () => {
      window.removeEventListener(COMPOSER_RESIZED, pin);
      resized.disconnect();
    };
  }, []);
}
