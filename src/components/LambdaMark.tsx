/** Flow's mark: a pixel capital lambda (5×6 blocks), drawn in the current text color. */
const BLOCKS = ["..#..", "..#..", ".#.#.", ".#.#.", "#...#", "#...#"];

export default function LambdaMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 5 6" shapeRendering="crispEdges" fill="currentColor" aria-hidden="true">
      {BLOCKS.flatMap((row, y) => [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null)))}
    </svg>
  );
}
