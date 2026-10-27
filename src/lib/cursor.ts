import type { EditorState } from "@codemirror/state";

/**
 * Is the cursor (or a selection) in or right next to this range? The editor
 * shows a piece of Markdown's raw syntax (the ** of bold, a formula's LaTeX,
 * a link's brackets) only then, so clicking elsewhere on the same line keeps
 * it rendered.
 */
export function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}
