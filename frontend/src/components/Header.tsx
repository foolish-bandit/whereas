import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import CommandPalette from "./CommandPalette";
import DemoModePill from "./DemoModePill";
import { getDashboardSummary } from "../lib/api";
import { demoPath } from "../lib/routes";

interface HeaderProps {
  devUserId: string | null;
  demoMode?: boolean;
  onOpenSidebar: () => void;
}

const NEW_ITEMS: { label: string; to: string }[] = [
  { label: "New request", to: demoPath("/requests?new=1") },
  { label: "Upload to repository", to: demoPath("/upload") },
  { label: "Start from template", to: demoPath("/requests/templates") },
  { label: "New playbook rule", to: demoPath("/playbooks?new=rule") },
  { label: "New clause", to: demoPath("/clause-manager?new=1") },
];

function isModifier(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

export default function Header({
  devUserId,
  demoMode,
  onOpenSidebar,
}: HeaderProps) {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [overdue, setOverdue] = useState(0);

  // Global ⌘K / Ctrl+K opens the palette from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && isModifier(e)) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setNewOpen(false);
        setBellOpen(false);
        setUserOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Notification bell badge = open approval steps for current user.
  // We reuse the dashboard summary endpoint that the Sidebar already
  // calls; the fetch is best-effort.
  useEffect(() => {
    let cancelled = false;
    getDashboardSummary()
      .then((s) => {
        if (cancelled) return;
        if (s && s.counts) {
          // Total of overdue + pending approval steps; the existing
          // summary exposes overdue_approval_steps already.
          setOverdue(s.counts.overdue_approval_steps ?? 0);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
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
          {demoMode && (
            <div className="hidden md:inline-flex">
              <DemoModePill />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search (Cmd+K)"
          className="hidden min-w-0 max-w-md flex-1 items-center gap-2 rounded border border-rule bg-canvas-subtle px-2.5 py-1.5 text-xs text-ink-subtle hover:border-rule-strong md:inline-flex"
          data-testid="header-search-trigger"
        >
          <span aria-hidden>🔍</span>
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded border border-rule bg-canvas px-1.5 py-0.5 text-[10px] text-ink-muted">
            ⌘K
          </kbd>
        </button>

        <div className="flex shrink-0 items-center gap-2 text-xs sm:gap-3">
          <Dropdown
            open={newOpen}
            setOpen={setNewOpen}
            label="+ New"
            testIdRoot="header-new"
            buttonClassName="rounded border border-ink bg-ink px-2.5 py-1 text-canvas hover:bg-accent-ring"
          >
            <ul role="menu" className="py-1">
              {NEW_ITEMS.map((it) => (
                <li key={it.label}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNewOpen(false);
                      navigate(it.to);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-canvas-subtle"
                    data-testid={`header-new-${it.label
                      .toLowerCase()
                      .replace(/\s+/g, "-")}`}
                  >
                    {it.label}
                  </button>
                </li>
              ))}
            </ul>
          </Dropdown>

          <Dropdown
            open={bellOpen}
            setOpen={setBellOpen}
            label={
              <span className="relative inline-flex">
                <span aria-hidden>🔔</span>
                {overdue > 0 && (
                  <span
                    className="absolute -right-2 -top-1 rounded-full bg-danger px-1 text-[9px] font-medium tabular-nums text-canvas"
                    data-testid="header-bell-badge"
                  >
                    {overdue}
                  </span>
                )}
              </span>
            }
            ariaLabel="Notifications"
            testIdRoot="header-bell"
            buttonClassName="relative inline-flex h-8 w-8 items-center justify-center rounded border border-rule bg-canvas text-ink-muted hover:border-rule-strong"
          >
            <div className="w-72 p-2" data-testid="header-bell-popover">
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
                Approvals
              </p>
              {overdue > 0 ? (
                <p className="px-2 py-1 text-sm text-ink">
                  You have <span className="font-medium">{overdue}</span>{" "}
                  overdue approval{" "}
                  {overdue === 1 ? "step" : "steps"}.
                </p>
              ) : (
                <p className="px-2 py-1 text-sm text-ink-muted">
                  No overdue approval steps.
                </p>
              )}
              <Link
                to={demoPath("/approvals/tasks")}
                onClick={() => setBellOpen(false)}
                className="mt-1 block rounded px-2 py-1 text-sm text-ink underline hover:bg-canvas-subtle"
                data-testid="header-bell-view-all"
              >
                View all tasks →
              </Link>
            </div>
          </Dropdown>

          <Dropdown
            open={userOpen}
            setOpen={setUserOpen}
            label={
              <span
                aria-hidden
                className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-canvas-muted text-[11px] font-medium text-ink-muted"
              >
                LD
              </span>
            }
            ariaLabel="Account"
            testIdRoot="header-user"
            buttonClassName="inline-flex h-8 items-center justify-center rounded border border-rule bg-canvas px-1.5 hover:border-rule-strong"
          >
            <div className="w-56 py-1" data-testid="header-user-menu">
              <div className="border-b border-rule px-3 py-2">
                <p className="text-sm font-medium text-ink">Local Developer</p>
                <p className="text-[11px] text-ink-subtle">
                  {devUserId
                    ? `dev ${devUserId.slice(0, 8)}`
                    : "no dev user set"}
                </p>
              </div>
              <Link
                to={demoPath("/settings")}
                onClick={() => setUserOpen(false)}
                role="menuitem"
                className="block px-3 py-1.5 text-sm text-ink hover:bg-canvas-subtle"
                data-testid="header-user-settings"
              >
                Settings
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => setUserOpen(false)}
                className="block w-full px-3 py-1.5 text-left text-sm text-ink-muted hover:bg-canvas-subtle"
                data-testid="header-user-signout"
                title="Sign-out is stubbed in demo mode."
              >
                Sign out
              </button>
            </div>
          </Dropdown>

        </div>
      </header>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </>
  );
}

interface DropdownProps {
  open: boolean;
  setOpen: (v: boolean) => void;
  label: React.ReactNode;
  ariaLabel?: string;
  testIdRoot: string;
  buttonClassName: string;
  children: React.ReactNode;
}

function Dropdown({
  open,
  setOpen,
  label,
  ariaLabel,
  testIdRoot,
  buttonClassName,
  children,
}: DropdownProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={buttonClassName}
        data-testid={`${testIdRoot}-trigger`}
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 rounded border border-rule bg-canvas shadow-md"
          data-testid={`${testIdRoot}-menu`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
