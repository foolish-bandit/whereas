import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { mountedPath } from "../lib/routes";

interface MenuItem {
  label: string;
  hint: string;
  path: string;
  testId: string;
}

const MENU_ITEMS: MenuItem[] = [
  {
    label: "Upload to Repository",
    hint: "Add a signed Repository record or document",
    path: "/upload",
    testId: "start-new-upload",
  },
  {
    label: "Start Request",
    hint: "Kick off a new contract request",
    path: "/requests#new-request",
    testId: "start-new-start-request",
  },
  {
    label: "Start from Agreement Template",
    hint: "Use a saved template to draft faster",
    path: "/requests/templates",
    testId: "start-new-start-from-agreement-template",
  },
  {
    label: "Open Inbox Intake",
    hint: "Process an incoming contract",
    path: "/inbox",
    testId: "start-new-open-inbox-intake",
  },
  {
    label: "View Approval Tasks",
    hint: "See contracts awaiting your review",
    path: "/approvals/tasks",
    testId: "start-new-view-approval-tasks",
  },
  {
    label: "Add Playbook Rule",
    hint: "Define a new deviation check",
    path: "/playbooks",
    testId: "start-new-add-playbook-rule",
  },
  {
    label: "Add Clause",
    hint: "Extend the clause library",
    path: "/clause-manager",
    testId: "start-new-add-clause",
  },
];

export default function StartNewMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded border border-ink bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:bg-accent-ring"
        data-testid="start-new-trigger"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
        </svg>
        Start new
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 w-72 rounded border border-rule bg-canvas shadow-md"
          role="menu"
          data-testid="start-new-menu"
        >
          <ul className="py-1">
            {MENU_ITEMS.map((item) => (
              <li key={item.label}>
                <Link
                  to={mountedPath(item.path, pathname)}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="flex flex-col px-3 py-2 hover:bg-canvas-subtle"
                  data-testid={item.testId}
                >
                  <span className="text-sm font-medium text-ink">
                    {item.label}
                  </span>
                  <span className="text-xs text-ink-subtle">{item.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
