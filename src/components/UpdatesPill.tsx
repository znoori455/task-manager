"use client";

/** "3 updated · show": changes by others that the frozen list order doesn't reflect yet. */
export function UpdatesPill({ count, onShow }: { count: number; onShow: () => void }) {
  if (count === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <button
        onClick={onShow}
        data-testid="updates-pill"
        className="pointer-events-auto rounded-full bg-sky-600 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-sky-700"
      >
        {count} updated · show
      </button>
    </div>
  );
}
