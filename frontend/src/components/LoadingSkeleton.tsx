interface LoadingSkeletonProps {
  rows?: number;
}

export default function LoadingSkeleton({ rows = 5 }: LoadingSkeletonProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="overflow-hidden rounded-lg border border-rule bg-canvas"
    >
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <div className="h-3 w-24 animate-pulse rounded bg-rule" />
      </div>
      <div className="divide-y divide-rule">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <div className="h-3 flex-1 animate-pulse rounded bg-canvas-muted" />
            <div className="h-3 w-20 animate-pulse rounded bg-canvas-muted" />
            <div className="h-3 w-12 animate-pulse rounded bg-canvas-muted" />
            <div className="h-3 w-24 animate-pulse rounded bg-canvas-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
