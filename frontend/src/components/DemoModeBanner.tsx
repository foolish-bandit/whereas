export default function DemoModeBanner() {
  return (
    <div className="border-b border-info-ring bg-info-soft px-6 py-2.5 text-sm text-info">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-hidden />
          <p>
            <span className="font-medium">Demo mode</span>: using sample data.
            No documents are uploaded.
          </p>
        </div>
        <a
          href="https://github.com/foolish-bandit/whereas"
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded border border-info-ring bg-canvas px-2.5 py-1 text-xs font-medium text-info hover:border-info"
        >
          View source
        </a>
      </div>
    </div>
  );
}
