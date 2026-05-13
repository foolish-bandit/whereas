import { Link } from "react-router-dom";

interface LimitationGroup {
  id: string;
  heading: string;
  body: string;
  items: { area: string; note: string }[];
}

const GROUPS: LimitationGroup[] = [
  {
    id: "mvp-demo",
    heading: "MVP and demo boundaries",
    body: "Whereas currently ships as a pre-v0.1 evaluator experience. Core CLM workflow surfaces are usable, but parts of the UX are demo/session oriented.",
    items: [
      {
        area: "Demo data",
        note: "Seeded records are fictional and intended for walkthroughs only.",
      },
      {
        area: "Session state",
        note: "Some edits and workflow states may persist only in local browser/session context in demo mode.",
      },
    ],
  },
  {
    id: "integrations",
    heading: "Integrations and external systems",
    body: "The Integrations page distinguishes available-now behavior from planned connectors. Planned connectors are roadmap items, not active syncs.",
    items: [
      {
        area: "Email/chat/CRM",
        note: "Outlook, Gmail, Slack, Teams, Salesforce, and related connectors are not fully wired in this MVP.",
      },
      {
        area: "Calendar/reminders",
        note: "Automated reminder and calendar sync behavior is planned, not currently implemented.",
      },
    ],
  },
  {
    id: "review-ai",
    heading: "Review guidance and AI boundaries",
    body: "Supporting questions, metadata extraction, and workflow guidance help organize review work. They are operational aids and require human validation.",
    items: [
      {
        area: "Structured answers",
        note: "Supporting-question answers are summarized into existing request text fields; a full structured backend answer model is not shipped yet.",
      },
      {
        area: "Legal judgment",
        note: "Whereas does not provide legal advice. Users remain responsible for legal interpretation and decisions.",
      },
    ],
  },
  {
    id: "document-signature",
    heading: "Document conversion and e-signature",
    body: "Repository record and artifact workflows are implemented, with practical MVP constraints around comparison and signature-adjacent handling.",
    items: [
      {
        area: "Redline workflows",
        note: "Compare/history tools exist, but advanced negotiation UX (for example full accept/reject-at-scale flows) remains limited.",
      },
      {
        area: "DocuSeal scope",
        note: "DocuSeal integration behavior follows the current shipped flow; broader enterprise signing orchestration is out of scope for this MVP.",
      },
    ],
  },
  {
    id: "platform",
    heading: "Browser, PWA, and self-hosting",
    body: "Whereas is optimized for local/self-host evaluation. Production-hardening concerns should be reviewed before wider deployment.",
    items: [
      {
        area: "PWA caching",
        note: "Service worker behavior is expected to exclude `/api/*` caching paths.",
      },
      {
        area: "Enterprise controls",
        note: "Full enterprise auth/RBAC/SSO and production certification posture are not represented by this pre-v0.1 release.",
      },
    ],
  },
];

export default function KnownLimitationsPage() {
  return (
    <div data-testid="known-limitations-page">
      <header className="mb-6">
        <h1 className="font-serif text-xl text-ink sm:text-2xl">
          Known limitations
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          This page explains what works today, what remains demo/session-only,
          and what is still planned. For a recommended evaluator path, start on{" "}
          <Link to="/demo/dashboard" className="underline hover:text-ink">
            Dashboard
          </Link>{" "}
          and follow the workflow through Intake, Requests, Repository, and
          Approvals.
        </p>
      </header>

      <div className="space-y-6">
        {GROUPS.map((g) => (
          <section
            key={g.id}
            className="rounded-lg border border-rule bg-canvas p-5"
            data-testid={`known-limitations-${g.id}`}
            id={g.id}
          >
            <h2 className="text-base font-semibold text-ink">{g.heading}</h2>
            <p className="mt-1 text-sm text-ink-muted">{g.body}</p>
            <ul className="mt-3 divide-y divide-rule">
              {g.items.map((item) => (
                <li key={item.area} className="py-2 text-sm">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
                    {item.area}
                  </p>
                  <p className="mt-0.5 text-ink">{item.note}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-6 text-xs text-ink-subtle">
        See the project on{" "}
        <a
          href="https://github.com/foolish-bandit/whereas"
          className="underline hover:text-ink"
        >
          GitHub
        </a>
        , review <Link to="/demo/integrations" className="underline hover:text-ink">Integrations</Link>,
        and check the root README for the current MVP release notes.
      </p>
    </div>
  );
}
