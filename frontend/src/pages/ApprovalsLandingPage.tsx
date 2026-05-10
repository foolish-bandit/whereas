import { Link } from "react-router-dom";

import { demoPath } from "../lib/routes";

interface ApprovalsCard {
  to: string;
  title: string;
  description: string;
  testId: string;
}

const CARDS: ApprovalsCard[] = [
  {
    to: demoPath("/approvals/tasks"),
    title: "Approval tasks",
    description:
      "Open approval steps assigned to you. Triage what's waiting on a decision today.",
    testId: "approvals-card-tasks",
  },
  {
    to: demoPath("/approvals/workflows"),
    title: "Approval workflows",
    description:
      "Active approval processes attached to requests and contracts. View progress and resolve in-flight workflows.",
    testId: "approvals-card-workflows",
  },
  {
    to: demoPath("/approvals/templates"),
    title: "Approval templates",
    description:
      "Reusable approval step lists. Build a blueprint once and instantiate it for any request or contract.",
    testId: "approvals-card-templates",
  },
  {
    to: demoPath("/approvals/policies"),
    title: "Approval policies",
    description:
      "Rules that attach approval workflows to matching requests automatically.",
    testId: "approvals-card-policies",
  },
];

export default function ApprovalsLandingPage() {
  return (
    <div className="space-y-6" data-testid="approvals-landing">
      <div>
        <h1 className="text-lg font-semibold text-ink">Approvals</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          One place to manage the approval surface of CLM — what's waiting on
          you, what's in flight, the templates you reuse, and the policies that
          attach approvals to incoming requests.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {CARDS.map((card) => (
          <Link
            key={card.to}
            to={card.to}
            data-testid={card.testId}
            className="group rounded border border-rule bg-canvas p-4 transition-colors hover:border-rule-strong hover:bg-canvas-subtle"
          >
            <p className="text-sm font-medium text-ink group-hover:text-ink">
              {card.title}
            </p>
            <p className="mt-1 text-xs text-ink-muted">{card.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
