import { Link } from "react-router-dom";

const GITHUB_URL = "https://github.com/foolish-bandit/whereas";

/**
 * Lightweight chrome for the marketing pages. Deliberately not the
 * AppShell sidebar/header — the marketing surface has nothing to
 * navigate yet besides "Demo" and "GitHub".
 */
export default function MarketingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-10">
        <Link
          to="/"
          aria-label="Whereas home"
          className="flex items-center gap-2"
        >
          <span className="font-serif text-lg tracking-tight text-ink">
            Whereas
          </span>
          <span className="hidden rounded-full border border-rule bg-canvas-subtle px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-subtle sm:inline">
            pre-v0.1
          </span>
        </Link>
        <nav className="flex items-center gap-2 text-sm sm:gap-3">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="hidden items-center rounded border border-rule bg-canvas px-3 py-1.5 text-sm font-medium text-ink hover:border-rule-strong sm:inline-flex"
          >
            GitHub
          </a>
          <Link
            to="/demo"
            className="inline-flex items-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:py-1.5"
          >
            Open demo
          </Link>
        </nav>
      </div>
    </header>
  );
}
