import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { getDashboardSummary } from "../lib/api";
import { demoPath } from "../lib/routes";

// Top-level navigation grouped into four sections so the rail still
// reads cleanly as History, Analytics, Integrations, and Audit log
// land. Sub-surfaces (Inbox, Approval Workflows, Upload) are reachable
// from their respective workspace landings rather than the sidebar.
interface NavItem {
  to: string;
  label: string;
  Icon: (props: IconProps) => JSX.Element;
  badge?: "approvals" | "soon";
}
interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    id: "work",
    label: "Work",
    items: [
      { to: demoPath("/dashboard"), label: "Dashboard", Icon: DashboardIcon },
      { to: demoPath("/analytics"), label: "Analytics", Icon: AnalyticsIcon },
      { to: demoPath("/intake"), label: "Intake", Icon: IntakeIcon },
      { to: demoPath("/inbox"), label: "Inbox", Icon: InboxIcon },
      {
        to: demoPath("/approvals"),
        label: "Approvals",
        Icon: ApprovalsIcon,
        badge: "approvals",
      },
    ],
  },
  {
    id: "library",
    label: "Library",
    items: [
      { to: demoPath("/repository"), label: "Repository", Icon: RepositoryIcon },
      { to: demoPath("/requests"), label: "Requests", Icon: RequestsIcon },
      {
        to: demoPath("/requests/templates"),
        label: "Templates",
        Icon: TemplatesIcon,
      },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    items: [
      { to: demoPath("/playbooks"), label: "Playbooks", Icon: PlaybooksIcon },
      {
        to: demoPath("/clause-manager"),
        label: "Clause Manager",
        Icon: ClauseIcon,
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      { to: demoPath("/settings"), label: "Settings", Icon: SettingsIcon },
      {
        to: demoPath("/integrations"),
        label: "Integrations",
        Icon: IntegrationsIcon,
        badge: "soon",
      },
    ],
  },
];
type IconProps = { className?: string };
function BaseIcon({ className, children }: { className?: string; children: ReactNode }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>{children}</svg>;
}
function DashboardIcon({ className }: IconProps) { return <BaseIcon className={className}><rect x="3" y="3" width="6" height="6" /><rect x="11" y="3" width="6" height="4" /><rect x="11" y="9" width="6" height="8" /><rect x="3" y="11" width="6" height="6" /></BaseIcon>; }
function RepositoryIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M3 6h14v10H3z" /><path d="M3 9h14" /><path d="M7 6V4h6v2" /></BaseIcon>; }
function RequestsIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M5 3h8l3 3v11H5z" /><path d="M13 3v3h3" /><path d="M8 11h6M8 14h4" /></BaseIcon>; }
function PlaybooksIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M4 4h6v12H4zM10 4h6v12h-6z" /></BaseIcon>; }
function ClauseIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M10 3v14M4 6l6 4-6 4M16 6l-6 4 6 4" /></BaseIcon>; }
function ApprovalsIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M10 3l6 2v5c0 3.5-2.2 5.8-6 7-3.8-1.2-6-3.5-6-7V5z" /><path d="M7.5 10.5l1.7 1.7 3.3-3.3" /></BaseIcon>; }
function SettingsIcon({ className }: IconProps) { return <BaseIcon className={className}><circle cx="10" cy="10" r="2.5" /><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.2 5.2l1.4 1.4M13.4 13.4l1.4 1.4M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4" /></BaseIcon>; }
function InboxIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M3 11v5h14v-5l-3-6H6z" /><path d="M3 11h4l1 2h4l1-2h4" /></BaseIcon>; }
function IntakeIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M10 3v10M7 10l3 3 3-3" /><path d="M4 15h12" /></BaseIcon>; }
function TemplatesIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3" /><path d="M7 9h6M7 12h6M7 15h4" /></BaseIcon>; }
function IntegrationsIcon({ className }: IconProps) { return <BaseIcon className={className}><circle cx="5" cy="10" r="2" /><circle cx="15" cy="6" r="2" /><circle cx="15" cy="14" r="2" /><path d="M7 10l6-4M7 10l6 4" /></BaseIcon>; }
function AnalyticsIcon({ className }: IconProps) { return <BaseIcon className={className}><path d="M3 17V7M9 17V11M15 17V5M3 17h16" /></BaseIcon>; }

interface SidebarProps {
  /**
   * Whether the mobile drawer is open. Ignored on md+ where the
   * sidebar is always pinned to the side.
   */
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Per-nav-entry overdue counts, sourced from the dashboard summary
 * endpoint (PR #86). The sidebar surfaces these as small badges so a
 * pending overdue approval is obvious from anywhere in the app.
 *
 * The fetch is best-effort: if it fails, the sidebar still renders
 * with no badges so navigation is never blocked.
 */
interface OverdueCounts {
  approvalSteps: number;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const [overdue, setOverdue] = useState<OverdueCounts | null>(null);

  // Close the mobile drawer when the user presses Escape, and lock
  // body scroll while the drawer is open so the underlying page
  // doesn't shift around behind the overlay.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    let aborted = false;
    getDashboardSummary()
      .then((summary) => {
        if (aborted) return;
        if (summary && summary.counts) {
          setOverdue({
            approvalSteps: summary.counts.overdue_approval_steps,
          });
        }
      })
      .catch(() => {
        // Best-effort — the sidebar must keep rendering even if the
        // counts can't be fetched (no dev user, network error, etc.).
      });
    return () => {
      aborted = true;
    };
  }, []);

  return (
    <>
      <DesktopSidebar overdue={overdue} />
      <MobileDrawer
        isOpen={isOpen}
        onClose={onClose}
        overdue={overdue}
      />
    </>
  );
}

function DesktopSidebar({ overdue }: { overdue: OverdueCounts | null }) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-rule bg-canvas md:flex">
      <div className="flex h-14 items-center border-b border-rule px-5">
        <Link
          to="/"
          className="font-serif text-lg tracking-tight text-ink hover:text-ink-muted"
          aria-label="Whereas home"
        >
          Whereas
        </Link>
      </div>
      <NavList overdue={overdue} />
      <div className="border-t border-rule px-5 py-4 text-xs text-ink-subtle">
        <p>Self-hosted workspace</p>
        <p className="mt-1">v0.0.1 · pre-release</p>
      </div>
    </aside>
  );
}

function MobileDrawer({
  isOpen,
  onClose,
  overdue,
}: {
  isOpen: boolean;
  onClose: () => void;
  overdue: OverdueCounts | null;
}) {
  return (
    <div
      className={[
        "fixed inset-0 z-40 md:hidden",
        isOpen ? "" : "pointer-events-none",
      ].join(" ")}
      aria-hidden={!isOpen}
    >
      <button
        type="button"
        aria-label="Close navigation"
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
        className={[
          "absolute inset-0 bg-ink/40 transition-opacity",
          isOpen ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />
      <aside
        role="dialog"
        aria-label="Navigation"
        aria-modal="true"
        className={[
          "absolute inset-y-0 left-0 flex w-64 max-w-[85%] flex-col border-r border-rule bg-canvas shadow-xl transition-transform",
          isOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-rule px-5">
          <Link
            to="/"
            onClick={onClose}
            className="font-serif text-lg tracking-tight text-ink hover:text-ink-muted"
            aria-label="Whereas home"
          >
            Whereas
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="-mr-2 inline-flex h-9 w-9 items-center justify-center rounded text-ink-muted hover:bg-canvas-subtle hover:text-ink"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-5 w-5"
              aria-hidden
            >
              <path
                fillRule="evenodd"
                d="M5.22 5.22a.75.75 0 0 1 1.06 0L10 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L8.94 10 5.22 6.28a.75.75 0 0 1 0-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
        <NavList onNavigate={onClose} overdue={overdue} />
        <div className="border-t border-rule px-5 py-4 text-xs text-ink-subtle">
          <p>Self-hosted workspace</p>
          <p className="mt-1">v0.0.1 · pre-release</p>
        </div>
      </aside>
    </div>
  );
}

// Some top-level entries should stay highlighted even when the user
// is on a legacy alias or a sub-page that lives under the same
// workspace. e.g. /demo/contracts is the legacy alias for the
// Repository workspace; /demo/approval-workflows is a deep-link
// destination that still belongs under Approvals.
const NAV_EXTRA_MATCHES: Record<string, string[]> = {
  [demoPath("/repository")]: [
    demoPath("/contracts"),
    demoPath("/upload"),
  ],
  [demoPath("/requests")]: [
    demoPath("/agreement-templates"),
    demoPath("/requests/templates"),
  ],
  [demoPath("/approvals")]: [
    demoPath("/inbox"),
    demoPath("/approval-workflows"),
    demoPath("/approval-templates"),
    demoPath("/approval-policies"),
  ],
  [demoPath("/clause-manager")]: [demoPath("/clause-library")],
};

function NavList({
  onNavigate,
  overdue,
}: {
  onNavigate?: () => void;
  overdue?: OverdueCounts | null;
}) {
  const { pathname } = useLocation();
  const approvalsBadge = overdue?.approvalSteps ?? 0;
  return (
    <nav
      className="flex flex-1 flex-col overflow-y-auto p-3 text-sm"
      data-testid="sidebar-nav"
    >
      {NAV_SECTIONS.map((section, sectionIdx) => (
        <div key={section.id} data-testid={`sidebar-section-${section.id}`}>
          <p
            className={[
              "px-3 mb-1 text-[10px] uppercase tracking-[0.2em] text-ink-subtle",
              sectionIdx === 0 ? "mt-0" : "mt-4",
            ].join(" ")}
          >
            {section.label}
          </p>
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const Icon = item.Icon;
              const extras = NAV_EXTRA_MATCHES[item.to] ?? [];
              const matchesExtra = extras.some(
                (p) => pathname === p || pathname.startsWith(`${p}/`),
              );
              const showApprovalsBadge =
                item.badge === "approvals" && approvalsBadge > 0;
              const showSoonBadge = item.badge === "soon";
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    [
                      "flex items-center justify-between rounded px-3 py-2 transition-colors",
                      isActive || matchesExtra
                        ? "bg-canvas-muted font-medium text-ink"
                        : "text-ink-muted hover:bg-canvas-muted hover:text-ink",
                    ].join(" ")
                  }
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-4 w-4" aria-hidden />
                    <span>{item.label}</span>
                  </span>
                  {showApprovalsBadge && (
                    <span
                      className="rounded bg-danger px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-canvas"
                      data-testid="sidebar-overdue-badge"
                      aria-label={`${approvalsBadge} overdue approval ${
                        approvalsBadge === 1 ? "step" : "steps"
                      }`}
                    >
                      {approvalsBadge}
                    </span>
                  )}
                  {showSoonBadge && (
                    <span
                      className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-subtle"
                      data-testid={`sidebar-soon-badge-${item.label.toLowerCase()}`}
                    >
                      Soon
                    </span>
                  )}
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
