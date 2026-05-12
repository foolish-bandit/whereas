import EmptyState from "../components/EmptyState";
import Pill from "../components/ui/Pill";

const PLANNED = [
  {
    name: "Nango",
    description:
      "OAuth + connector hub for the SaaS-app integrations below. Self-hostable.",
  },
  {
    name: "Outlook",
    description:
      "Pull inbound contract attachments from a watched mailbox into the Repository.",
  },
  {
    name: "Slack",
    description:
      "Notify on approval-step assignment, gate blocks, and signature completion.",
  },
  {
    name: "Salesforce",
    description:
      "Link a Repository record to an Opportunity; mirror status back to the CRM.",
  },
  {
    name: "HubSpot",
    description:
      "Link a Repository record to a HubSpot Deal; mirror status back to the CRM.",
  },
];

export default function IntegrationsPage() {
  return (
    <div data-testid="integrations-page">
      <header className="mb-6">
        <h1 className="font-serif text-xl text-ink sm:text-2xl">Integrations</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Integrations are not available in this release. The list below
          is the planned target set — none of them ship today.
        </p>
      </header>
      <EmptyState
        title="Coming soon"
        description="Whereas focuses on the contract workspace itself for v0.1. SaaS-app integrations will land behind a self-hostable Nango deployment so credentials never leave your infrastructure."
      />
      <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {PLANNED.map((p) => (
          <article
            key={p.name}
            className="rounded-lg border border-rule bg-canvas p-4"
            data-testid={`integration-stub-${p.name.toLowerCase()}`}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">{p.name}</h2>
              <Pill tone="neutral" variant="soft">
                Coming soon
              </Pill>
            </div>
            <p className="mt-2 text-xs text-ink-muted">{p.description}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
