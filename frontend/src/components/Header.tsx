import { Link } from "react-router-dom";

interface HeaderProps {
  devUserId: string | null;
  demoMode?: boolean;
  onOpenSidebar: () => void;
}

export default function Header({
  devUserId,
  demoMode,
  onOpenSidebar,
}: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-rule bg-canvas px-3 sm:gap-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open navigation"
          className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-canvas-subtle hover:text-ink md:hidden"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-5 w-5"
            aria-hidden
          >
            <path
              fillRule="evenodd"
              d="M3 5.75A.75.75 0 0 1 3.75 5h12.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 5.75Zm0 4.25a.75.75 0 0 1 .75-.75h12.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 10Zm.75 3.5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H3.75Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <span className="truncate font-serif text-lg tracking-tight text-ink md:hidden">
          Whereas
        </span>
        <span className="hidden items-center gap-2 rounded-full border border-rule bg-canvas-subtle px-2.5 py-1 text-xs uppercase tracking-wider text-ink-subtle md:inline-flex">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          {demoMode ? "Demo workspace" : "Self-hosted workspace"}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs sm:gap-3">
        {demoMode ? (
          <span
            className="flex items-center gap-2 rounded border border-info-ring bg-info-soft px-2 py-1 text-info sm:px-2.5"
            title="The frontend is running with mock data; no backend is being called."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden />
            <span className="hidden sm:inline">Demo mode</span>
            <span className="sm:hidden">Demo</span>
          </span>
        ) : devUserId ? (
          <Link
            to="/demo/settings"
            className="group flex items-center gap-2 rounded border border-rule bg-canvas-subtle px-2 py-1 text-ink-muted hover:border-rule-strong hover:text-ink sm:px-2.5"
            title="Change development user ID"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            <span className="font-mono text-[11px]">
              <span className="hidden sm:inline">dev user · </span>
              {devUserId.slice(0, 8)}
            </span>
          </Link>
        ) : (
          <Link
            to="/demo/settings"
            className="flex items-center gap-2 rounded border border-warning-ring bg-warning-soft px-2 py-1 text-warning hover:border-warning sm:px-2.5"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
            <span className="hidden sm:inline">No dev user set</span>
            <span className="sm:hidden">No user</span>
          </Link>
        )}
      </div>
    </header>
  );
}
