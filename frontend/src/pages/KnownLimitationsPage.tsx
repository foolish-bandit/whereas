import { Link } from "react-router-dom";

interface LimitationGroup {
  id: string;
  heading: string;
  body: string;
  items: { area: string; note: string }[];
}

const GROUPS: LimitationGroup[] = [
  {
    id: "auth",
    heading: "Authentication and identity",
    body: "The deployment does not yet ship a full authentication or user-management story. The backend identifies requests by a header that points at a row in the users table.",
    items: [
      {
        area: "Sign-in",
        note: "Sign-in via the user dropdown is a placeholder in demo mode; production deployments configure their identity provider out-of-band.",
      },
      {
        area: "User picker UX",
        note: "Workflow steps and policies currently identify users by ID rather than a typeahead. A user picker is planned for a later release.",
      },
    ],
  },
  {
    id: "playbooks",
    heading: "Playbooks",
    body: "Playbooks ship as YAML you author and load into the backend. The web app reads playbooks and renders rule results; it does not yet edit them.",
    items: [
      {
        area: "In-app authoring",
        note: "Adding, editing, or reordering playbook rules from the Playbooks UI is read-only today; round-trip through the YAML source.",
      },
      {
        area: "Clause Manager linkage",
        note: "Cross-referencing a playbook rule to a managed clause from the rule editor is not wired yet. Both surfaces ship today; the integration is planned.",
      },
    ],
  },
  {
    id: "history",
    heading: "Document History and templates",
    body: "Version diff is word-level. Paragraph-aware diff, redline-accept/reject, and template per-version download require additional work that is not part of v0.1.",
    items: [
      {
        area: "Per-version template download",
        note: "Each template tracks an active version and the body it produces. A standalone per-version download endpoint is planned.",
      },
      {
        area: "Redline accept/reject",
        note: "The diff view is read-only. Accepting or rejecting individual changes is a planned v0.2 negotiation feature.",
      },
    ],
  },
  {
    id: "integrations",
    heading: "Integrations",
    body: "No external integrations ship in v0.1. The Integrations page lists the planned target set (Nango, Outlook, Slack, Salesforce, HubSpot).",
    items: [
      {
        area: "Inbound email",
        note: "Watching an inbox for contract attachments is on the roadmap; today, contracts arrive via upload only.",
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
          Areas the v0.1 release intentionally leaves rough. Whereas
          surfaces information about agreements; it does not provide
          legal advice, and it does not yet ship every feature a mature
          CLM stack covers. This page lists the gaps so they are
          obvious to evaluators.
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
        , or open the{" "}
        <Link
          to="/demo/integrations"
          className="underline hover:text-ink"
        >
          Integrations
        </Link>{" "}
        page for the planned external connectors.
      </p>
    </div>
  );
}
