import Pill from "../components/ui/Pill";

type IntegrationStatus = "available" | "planned";

interface Integration {
  name: string;
  category: string;
  status: IntegrationStatus;
  description: string;
}

const INTEGRATIONS: Integration[] = [
  // E-signature
  {
    name: "DocuSeal",
    category: "E-signature",
    status: "available",
    description:
      "Self-hostable e-signature engine that runs alongside Whereas in the same Docker Compose. Send contracts for signature directly from the repository.",
  },
  // Document editing
  {
    name: "Microsoft Word",
    category: "Document editing",
    status: "planned",
    description:
      "Round-trip contract drafts between Whereas and Word. Import .docx files and push redlines back without leaving your editor.",
  },
  {
    name: "Google Docs",
    category: "Document editing",
    status: "planned",
    description:
      "Edit contracts in Google Docs and sync versions back to the Whereas repository automatically.",
  },
  // Communication
  {
    name: "Outlook",
    category: "Communication",
    status: "planned",
    description:
      "Pull inbound contract attachments from a watched mailbox into the repository and trigger intake workflows.",
  },
  {
    name: "Gmail",
    category: "Communication",
    status: "planned",
    description:
      "Watch a Gmail label or inbox for contract-related attachments and route them into the intake queue.",
  },
  {
    name: "Slack",
    category: "Communication",
    status: "planned",
    description:
      "Notify on approval-step assignment, gate blocks, and signature completion. Mentions route back to the contract record.",
  },
  {
    name: "Microsoft Teams",
    category: "Communication",
    status: "planned",
    description:
      "Post contract status updates and approval requests as adaptive cards in Teams channels.",
  },
  // CRM / business systems
  {
    name: "Salesforce",
    category: "CRM / Business systems",
    status: "planned",
    description:
      "Link a repository record to an Opportunity and mirror contract status back to the CRM without manual entry.",
  },
  {
    name: "HubSpot",
    category: "CRM / Business systems",
    status: "planned",
    description:
      "Associate contracts with HubSpot Deals and keep both systems in sync as a deal progresses.",
  },

  // AI providers
  {
    name: "Local model providers",
    category: "Local AI providers",
    status: "planned",
    description:
      "Future self-hosted/local model configuration only. Planned / Not connected in this MVP; no live provider toggle is exposed.",
  },
  // Storage
  {
    name: "Google Drive",
    category: "Storage",
    status: "planned",
    description:
      "Import executed contracts from a Drive folder and keep a mirrored archive alongside your Whereas repository.",
  },
  {
    name: "SharePoint / OneDrive",
    category: "Storage",
    status: "planned",
    description:
      "Sync contracts with a SharePoint document library or OneDrive folder for teams that manage files there.",
  },
];

const CATEGORIES = Array.from(new Set(INTEGRATIONS.map((i) => i.category)));

function StatusPill({ status }: { status: IntegrationStatus }) {
  if (status === "available") {
    return (
      <Pill tone="success" variant="soft" data-testid="integration-status-available">
        Available
      </Pill>
    );
  }
  return (
    <Pill tone="neutral" variant="soft" data-testid="integration-status-planned">
      Planned
    </Pill>
  );
}

function IntegrationCard({ integration }: { integration: Integration }) {
  const slug = integration.name.toLowerCase().replace(/[\s/]+/g, "-");
  return (
    <article
      className="rounded-lg border border-rule bg-canvas p-4"
      data-testid={`integration-card-${slug}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{integration.name}</h3>
          <p className="mt-0.5 text-xs text-ink-muted">{integration.category}</p>
        </div>
        <StatusPill status={integration.status} />
      </div>
      <p className="mt-2 text-xs text-ink-muted">{integration.description}</p>
      <div className="mt-3">
        {integration.status === "available" ? (
          <a
            href="/demo/settings"
            className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium bg-accent text-canvas hover:bg-accent/90 transition-colors"
            data-testid={`integration-cta-${slug}`}
          >
            Open settings
          </a>
        ) : (
          <div className="space-y-1">
            <button
              disabled
              className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium border border-rule text-ink-muted cursor-not-allowed opacity-60"
              data-testid={`integration-cta-${slug}`}
            >
              Planned
            </button>
            <p className="text-xs text-ink-muted" data-testid={`integration-caveat-${slug}`}>
              Roadmap item. Planned / Not connected in this MVP.
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

export default function IntegrationsPage() {
  return (
    <div data-testid="integrations-page">
      <header className="mb-6">
        <h1 className="font-serif text-xl text-ink sm:text-2xl">Integrations</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Integrations are explicit, optional, and admin-controlled. "Available"
          means the current shipped integration flow is present in this MVP
          (for example, DocuSeal in the self-hosted setup). "Planned" means
          the connector is listed for roadmap visibility and is not connected yet.
        </p>
      </header>

      <div className="space-y-8" data-testid="integrations-categories">
        {CATEGORIES.map((category) => {
          const items = INTEGRATIONS.filter((i) => i.category === category);
          const categorySlug = category.toLowerCase().replace(/[\s/]+/g, "-");
          return (
            <section key={category} data-testid={`integration-category-${categorySlug}`}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {category}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {items.map((integration) => (
                  <IntegrationCard key={integration.name} integration={integration} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
