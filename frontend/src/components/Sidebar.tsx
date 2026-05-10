import { useEffect } from "react";
import { Link, NavLink } from "react-router-dom";

import { demoPath } from "../lib/routes";

const NAV = [
  { to: demoPath("/dashboard"), label: "Dashboard" },
  { to: demoPath("/inbox"), label: "Inbox" },
  { to: demoPath("/requests"), label: "Requests" },
  { to: demoPath("/approvals"), label: "Approvals" },
  { to: demoPath("/approval-templates"), label: "Approval Templates" },
  { to: demoPath("/contracts"), label: "Contracts" },
  { to: demoPath("/agreement-templates"), label: "Agreement Templates" },
  { to: demoPath("/playbooks"), label: "Playbooks" },
  { to: demoPath("/clause-library"), label: "Clause Library" },
  { to: demoPath("/upload"), label: "Upload" },
  { to: demoPath("/settings"), label: "Settings" },
];

interface SidebarProps {
  /**
   * Whether the mobile drawer is open. Ignored on md+ where the
   * sidebar is always pinned to the side.
   */
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
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

  return (
    <>
      <DesktopSidebar />
      <MobileDrawer isOpen={isOpen} onClose={onClose} />
    </>
  );
}

function DesktopSidebar() {
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
      <NavList />
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
}: {
  isOpen: boolean;
  onClose: () => void;
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
        <NavList onNavigate={onClose} />
        <div className="border-t border-rule px-5 py-4 text-xs text-ink-subtle">
          <p>Self-hosted workspace</p>
          <p className="mt-1">v0.0.1 · pre-release</p>
        </div>
      </aside>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void } = {}) {
  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3 text-sm">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            [
              "rounded px-3 py-2 transition-colors",
              isActive
                ? "bg-canvas-muted font-medium text-ink"
                : "text-ink-muted hover:bg-canvas-muted hover:text-ink",
            ].join(" ")
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
