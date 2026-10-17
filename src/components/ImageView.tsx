/** An image from the vault, opened from the file tree. */
export default function ImageView({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-line px-8 text-sm">
        <div className="min-w-0 truncate text-muted">
          {parts.slice(0, -1).map((p) => (
            <span key={p}>
              {p} <span className="mx-1">/</span>
            </span>
          ))}
          <span className="font-medium text-fg">{parts.at(-1)}</span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
        {/* eslint-disable-next-line @next/next/no-img-element -- a vault file served by our API */}
        <img src={`/api/files/raw?path=${encodeURIComponent(path)}`} alt={parts.at(-1)} className="max-h-full max-w-full rounded-lg object-contain" />
      </div>
    </div>
  );
}
