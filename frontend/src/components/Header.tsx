import { Link } from "react-router-dom";

interface HeaderProps {
  devUserId: string | null;
  demoMode?: boolean;
}

export default function Header({ devUserId, demoMode }: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-rule bg-canvas px-6">
      <div className="flex items-center gap-3">
        <span className="font-serif text-lg tracking-tight text-ink md:hidden">
          Whereas
        </span>
        <span className="hidden items-center gap-2 rounded-full border border-rule bg-canvas-subtle px-2.5 py-1 text-xs uppercase tracking-wider text-ink-subtle md:inline-flex">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          {demoMode ? "Demo workspace" : "Self-hosted workspace"}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {demoMode ? (
          <span
            className="flex items-center gap-2 rounded border border-info-ring bg-info-soft px-2.5 py-1 text-info"
            title="The frontend is running with mock data; no backend is being called."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden />
            <span>Demo mode</span>
          </span>
        ) : devUserId ? (
          <Link
            to="/settings"
            className="group flex items-center gap-2 rounded border border-rule bg-canvas-subtle px-2.5 py-1 text-ink-muted hover:border-rule-strong hover:text-ink"
            title="Change development user ID"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            <span className="font-mono text-[11px]">
              dev user · {devUserId.slice(0, 8)}
            </span>
          </Link>
        ) : (
          <Link
            to="/settings"
            className="flex items-center gap-2 rounded border border-warning-ring bg-warning-soft px-2.5 py-1 text-warning hover:border-warning"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
            <span>No dev user set</span>
          </Link>
        )}
      </div>
    </header>
  );
}
