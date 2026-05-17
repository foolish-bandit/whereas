import { NavLink, Outlet } from "react-router-dom";

import { demoPath } from "../lib/routes";

/**
 * Shared layout for everything mounted under ``/approvals/*`` except
 * detail pages. Renders the "Approvals" title and the tab bar so the
 * five tab views (Overview / Tasks / Workflows / Templates / Policies)
 * share a single navigation frame.
 *
 * Tabs are real ``react-router-dom`` ``NavLink``s rather than client-
 * side state, so:
 *  - Deep links to ``/approvals/tasks`` etc. still work.
 *  - Browser back/forward navigate between tabs.
 *  - Each tab's existing component (with its own data loaders and
 *    deep-link handlers) is unchanged; only the framing moves.
 *
 * Detail pages (``/approvals/tasks/:id``, ``/approvals/workflows/:id``)
 * stay outside this layout. By the time a reviewer is reading a single
 * step, the tab bar would just be visual noise above the back button.
 */

interface Tab {
  to: string;
  label: string;
  // Match nested routes — e.g. the Tasks tab should stay highlighted
  // when a list-page deep link like ``?status=open`` is open, but not
  // when the route is the detail page ``/approvals/tasks/:id``
  // (which doesn't render the hub layout at all).
  end?: boolean;
  testId: string;
}

const TABS: Tab[] = [
  {
    to: demoPath("/approvals"),
    label: "Overview",
    end: true,
    testId: "approvals-hub-tab-overview",
  },
  {
    to: demoPath("/approvals/tasks"),
    label: "Tasks",
    testId: "approvals-hub-tab-tasks",
  },
  {
    to: demoPath("/approvals/workflows"),
    label: "Workflows",
    testId: "approvals-hub-tab-workflows",
  },
  {
    to: demoPath("/approvals/templates"),
    label: "Templates",
    testId: "approvals-hub-tab-templates",
  },
  {
    to: demoPath("/approvals/policies"),
    label: "Policies",
    testId: "approvals-hub-tab-policies",
  },
];

export default function ApprovalsHubLayout() {
  return (
    <div className="space-y-6" data-testid="approvals-hub">
      <header>
        <h1 className="text-lg font-semibold text-ink">Approvals</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Manage approval work in one place: what is waiting on you, what is
          in flight, and which templates and policies are active. Approval
          routing supports process control, not legal advice.
        </p>
      </header>
      <nav
        aria-label="Approvals sections"
        className="border-b border-rule"
        data-testid="approvals-hub-tabs"
      >
        <ul className="-mb-px flex flex-wrap gap-1">
          {TABS.map((tab) => (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                end={tab.end}
                data-testid={tab.testId}
                className={({ isActive }) =>
                  [
                    "inline-flex items-center border-b-2 px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "border-accent text-ink"
                      : "border-transparent text-ink-muted hover:border-rule-strong hover:text-ink",
                  ].join(" ")
                }
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
