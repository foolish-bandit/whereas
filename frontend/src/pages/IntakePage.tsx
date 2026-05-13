import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import { mountedPath } from "../lib/routes";

interface IntakeCard {
  title: string;
  description: string;
  cta: string;
  path: string;
  testId: string;
  Icon: (props: { className?: string }) => JSX.Element;
}

function BaseIcon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}
function UploadIcon({ className }: { className?: string }) {
  return (
    <BaseIcon className={className}>
      <path d="M10 13V4M7 7l3-3 3 3" />
      <path d="M4 14v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" />
    </BaseIcon>
  );
}
function RequestIcon({ className }: { className?: string }) {
  return (
    <BaseIcon className={className}>
      <path d="M5 3h8l3 3v11H5z" />
      <path d="M13 3v3h3" />
      <path d="M8 11h6M8 14h4" />
    </BaseIcon>
  );
}
function TemplatesIcon({ className }: { className?: string }) {
  return (
    <BaseIcon className={className}>
      <path d="M5 3h7l3 3v11H5z" />
      <path d="M12 3v3h3" />
      <path d="M7 9h6M7 12h6M7 15h4" />
    </BaseIcon>
  );
}
function InboxIcon({ className }: { className?: string }) {
  return (
    <BaseIcon className={className}>
      <path d="M3 11v5h14v-5l-3-6H6z" />
      <path d="M3 11h4l1 2h4l1-2h4" />
    </BaseIcon>
  );
}
function ApprovalsIcon({ className }: { className?: string }) {
  return (
    <BaseIcon className={className}>
      <path d="M10 3l6 2v5c0 3.5-2.2 5.8-6 7-3.8-1.2-6-3.5-6-7V5z" />
      <path d="M7.5 10.5l1.7 1.7 3.3-3.3" />
    </BaseIcon>
  );
}

const CARDS: IntakeCard[] = [
  {
    title: "Upload an existing agreement",
    description:
      "Add a signed, executed, or in-progress agreement to the Repository.",
    cta: "Upload to Repository",
    path: "/upload",
    testId: "intake-card-upload",
    Icon: UploadIcon,
  },
  {
    title: "Ask for legal or commercial review",
    description:
      "Create a Request for third-party paper, legal review, or business approval.",
    cta: "Start Request",
    path: "/requests#new-request",
    testId: "intake-card-request",
    Icon: RequestIcon,
  },
  {
    title: "Start from a template",
    description:
      "Generate an agreement from an approved reusable template.",
    cta: "Browse Templates",
    path: "/requests/templates",
    testId: "intake-card-templates",
    Icon: TemplatesIcon,
  },
  {
    title: "Triage intake queue",
    description:
      "Classify new intake items and route them to Requests or Repository.",
    cta: "Open Inbox",
    path: "/inbox",
    testId: "intake-card-inbox",
    Icon: InboxIcon,
  },
  {
    title: "Check approval tasks",
    description: "Review pending approvals and blocked workflows.",
    cta: "Open Approval Tasks",
    path: "/approvals/tasks",
    testId: "intake-card-approvals",
    Icon: ApprovalsIcon,
  },
];

export default function IntakePage() {
  const { pathname } = useLocation();

  return (
    <div className="space-y-6" data-testid="intake-page">
      <div>
        <h1 className="text-lg font-semibold text-ink">Intake</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Start contract work from one guided front door.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {CARDS.map((card) => {
          const Icon = card.Icon;
          const href = mountedPath(card.path, pathname);
          return (
            <Link
              key={card.testId}
              to={href}
              data-testid={card.testId}
              className="group flex flex-col gap-3 rounded border border-rule bg-canvas p-5 transition-colors hover:border-rule-strong hover:bg-canvas-subtle"
            >
              <div className="flex items-center gap-2">
                <Icon className="h-5 w-5 text-ink-muted group-hover:text-ink" />
                <p className="text-sm font-medium text-ink">{card.title}</p>
              </div>
              <p className="text-xs text-ink-muted">{card.description}</p>
              <span
                className="inline-flex items-center gap-1 text-xs font-medium text-ink"
                data-testid={`${card.testId}-cta`}
              >
                {card.cta}
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="h-3.5 w-3.5"
                  aria-hidden
                >
                  <path d="M3 8h10M9 4l4 4-4 4" />
                </svg>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
