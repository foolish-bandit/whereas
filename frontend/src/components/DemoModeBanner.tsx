import { Link } from "react-router-dom";

export default function DemoModeBanner() {
  return (
    <div className="border-b border-info-ring bg-info-soft px-4 py-2.5 text-sm text-info sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-info"
            aria-hidden
          />
          <p className="min-w-0">
            <span className="font-medium">Demo mode</span>
            <span className="hidden sm:inline">
              : using sample data. No documents are uploaded.
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/demo/known-limitations"
            className="rounded border border-info-ring bg-canvas px-2.5 py-1 text-xs font-medium text-info hover:border-info"
            data-testid="demo-banner-known-limitations"
          >
            Known limitations
          </Link>
          <a
            href="https://github.com/foolish-bandit/whereas"
            target="_blank"
            rel="noreferrer noopener"
            className="rounded border border-info-ring bg-canvas px-2.5 py-1 text-xs font-medium text-info hover:border-info"
          >
            View source
          </a>
        </div>
      </div>
    </div>
  );
}
