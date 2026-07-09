import { useCallback, useEffect, useMemo, useState } from "react";

import ErrorState from "../components/ErrorState";
import FolderPicker from "../components/FolderPicker";
import LoadingSkeleton from "../components/LoadingSkeleton";
import Pill from "../components/ui/Pill";
import {
  ApiError,
  createIntegrationConnectSession,
  deleteIntegrationConnection,
  listIntegrationConnections,
  listIntegrationProviders,
  triggerIntegrationSync,
  updateIntegrationConnection,
  upsertIntegrationConnection,
} from "../lib/api";
import { openNangoConnect } from "../lib/nangoConnect";
import {
  FOLDER_PICKER_PROVIDERS,
  type IntegrationConnection,
  type IntegrationIngestMode,
  type IntegrationProvider,
} from "../types/integrations";

// ---------------------------------------------------------------------------
// Roadmap-only cards (no live backend wiring yet).
// ---------------------------------------------------------------------------

interface RoadmapIntegration {
  name: string;
  category: string;
  description: string;
}

interface InspirationProject {
  name: string;
  pattern: string;
  whereasBet: string;
}

const ROADMAP_INTEGRATIONS: RoadmapIntegration[] = [
  {
    name: "Microsoft Word",
    category: "Document editing",
    description:
      "Round-trip contract drafts between Whereas and Word. Import .docx files and push redlines back without leaving your editor.",
  },
  {
    name: "Google Docs",
    category: "Document editing",
    description:
      "Edit contracts in Google Docs and sync versions back to the Whereas repository automatically.",
  },
  {
    name: "Slack",
    category: "Communication",
    description:
      "Notify on approval-step assignment, gate blocks, and signature completion. Mentions route back to the contract record.",
  },
  {
    name: "Microsoft Teams",
    category: "Communication",
    description:
      "Post contract status updates and approval requests as adaptive cards in Teams channels.",
  },
  {
    name: "Salesforce",
    category: "CRM / Business systems",
    description:
      "Link a repository record to an Opportunity and mirror contract status back to the CRM without manual entry.",
  },
  {
    name: "HubSpot",
    category: "CRM / Business systems",
    description:
      "Associate contracts with HubSpot Deals and keep both systems in sync as a deal progresses.",
  },
  {
    name: "Local model providers",
    category: "Local AI providers",
    description:
      "Future self-hosted/local model configuration only. Planned / Not connected in this MVP; no live provider toggle is exposed.",
  },
];

const ROADMAP_CATEGORIES = Array.from(
  new Set(ROADMAP_INTEGRATIONS.map((i) => i.category)),
);

const INSPIRATION_PROJECTS: InspirationProject[] = [
  {
    name: "Accord Project",
    pattern: "Executable templates with structured variables",
    whereasBet: "Template readiness checks and fallback clause previews",
  },
  {
    name: "Contract Playbook AI",
    pattern: "Playbook-guided findings and redline actions",
    whereasBet: "Turn review findings into reviewer tasks and clause swaps",
  },
  {
    name: "OpenContracts",
    pattern: "Legal documents as a relationship graph",
    whereasBet: "Connect parties, clauses, approvals, requests, and records",
  },
  {
    name: "DocuSeal / Documenso",
    pattern: "Self-hosted signing packets, links, webhooks, and audit trails",
    whereasBet: "Signature readiness checklist before handoff",
  },
  {
    name: "Twenty CRM",
    pattern: "Custom objects, saved views, workflows, and extensibility",
    whereasBet: "Configurable repository views without abandoning CLM defaults",
  },
  {
    name: "n8n / Activepieces",
    pattern: "Self-hostable trigger/action automation",
    whereasBet: "Auditable recipes for intake, approval, renewal, and signature events",
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded" }
  | { kind: "error"; message: string };

export default function IntegrationsPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [providers, setProviders] = useState<IntegrationProvider[]>([]);
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [actionBanner, setActionBanner] = useState<
    | { kind: "info" | "error"; message: string }
    | null
  >(null);
  // Per-connection pending state, keyed by connection id. Lifted to the
  // page so the parent's state updates after an async action don't race
  // a child's local loading flag (which produced "update was not wrapped
  // in act(...)" warnings in tests).
  const [pendingByConnection, setPendingByConnection] = useState<
    Record<string, "syncing" | "disconnecting" | undefined>
  >({});
  // When set, render the folder picker modal for this connection.
  const [pickerForConnectionId, setPickerForConnectionId] = useState<
    string | null
  >(null);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    Promise.all([listIntegrationProviders(), listIntegrationConnections()])
      .then(([ps, cs]) => {
        setProviders(ps);
        setConnections(cs);
        setState({ kind: "loaded" });
      })
      .catch((err) =>
        setState({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Could not load integrations.",
        }),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connectionsByProvider = useMemo(() => {
    const map = new Map<string, IntegrationConnection>();
    for (const c of connections) {
      map.set(c.provider, c);
    }
    return map;
  }, [connections]);

  async function handleConnect(provider: IntegrationProvider) {
    setActionBanner(null);
    try {
      const session = await createIntegrationConnectSession({
        provider: provider.key,
      });
      const result = await openNangoConnect({ sessionToken: session.token });
      if (result.kind === "cancelled") {
        setActionBanner({
          kind: "info",
          message: `Cancelled connecting ${provider.label}.`,
        });
        return;
      }
      const connection = await upsertIntegrationConnection({
        provider: provider.key,
        nango_connection_id: result.connectionId,
      });
      setConnections((prev) => {
        const without = prev.filter((c) => c.provider !== connection.provider);
        return [...without, connection];
      });
      setActionBanner({
        kind: "info",
        message: `${provider.label} connected.`,
      });
      // Prompt the admin to scope ingest to a folder right after
      // Connect. Skip for providers that don't have a folder concept
      // (Gmail, Outlook).
      if (FOLDER_PICKER_PROVIDERS.has(provider.key)) {
        setPickerForConnectionId(connection.id);
      }
    } catch (err) {
      setActionBanner({
        kind: "error",
        message: errorMessage(err, `Could not connect ${provider.label}.`),
      });
    }
  }

  async function handleSaveFolder(
    connection: IntegrationConnection,
    folder: { id: string; name: string },
  ) {
    const updated = await updateIntegrationConnection(connection.id, {
      root_folder_id: folder.id,
      root_folder_name: folder.name,
    });
    setConnections((prev) =>
      prev.map((c) => (c.id === updated.id ? updated : c)),
    );
    setActionBanner({
      kind: "info",
      message: `Folder set to ${folder.name}.`,
    });
    setPickerForConnectionId(null);
  }

  async function handleClearFolder(connection: IntegrationConnection) {
    const updated = await updateIntegrationConnection(connection.id, {
      root_folder_id: "",
    });
    setConnections((prev) =>
      prev.map((c) => (c.id === updated.id ? updated : c)),
    );
    setActionBanner({
      kind: "info",
      message: "Folder cleared — sync covers the whole drive.",
    });
    setPickerForConnectionId(null);
  }

  function markPending(
    connectionId: string,
    state: "syncing" | "disconnecting" | undefined,
  ) {
    setPendingByConnection((prev) => {
      if (state === undefined) {
        const { [connectionId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [connectionId]: state };
    });
  }

  async function handleSync(connection: IntegrationConnection, label: string) {
    setActionBanner(null);
    markPending(connection.id, "syncing");
    try {
      const result = await triggerIntegrationSync(connection.id);
      setConnections((prev) =>
        prev.map((c) =>
          c.id === connection.id
            ? {
                ...c,
                last_synced_at: new Date().toISOString(),
                last_sync_error: null,
                status: "active",
              }
            : c,
        ),
      );
      setActionBanner({
        kind: "info",
        message: `${label} synced — ${result.contracts_created} new, ${result.skipped} skipped.`,
      });
    } catch (err) {
      setConnections((prev) =>
        prev.map((c) =>
          c.id === connection.id
            ? { ...c, status: "error", last_sync_error: errorMessage(err) }
            : c,
        ),
      );
      setActionBanner({
        kind: "error",
        message: errorMessage(err, `Could not sync ${label}.`),
      });
    } finally {
      markPending(connection.id, undefined);
    }
  }

  async function handleDisconnect(
    connection: IntegrationConnection,
    label: string,
  ) {
    setActionBanner(null);
    if (
      !window.confirm(
        `Disconnect ${label}? Already-imported contracts stay, but new files will stop flowing in.`,
      )
    ) {
      return;
    }
    markPending(connection.id, "disconnecting");
    try {
      await deleteIntegrationConnection(connection.id);
      setConnections((prev) => prev.filter((c) => c.id !== connection.id));
      setActionBanner({ kind: "info", message: `${label} disconnected.` });
    } catch (err) {
      setActionBanner({
        kind: "error",
        message: errorMessage(err, `Could not disconnect ${label}.`),
      });
    } finally {
      markPending(connection.id, undefined);
    }
  }

  async function handleIngestModeChange(
    connection: IntegrationConnection,
    nextMode: IntegrationIngestMode,
  ) {
    setActionBanner(null);
    try {
      const updated = await updateIntegrationConnection(connection.id, {
        ingest_mode: nextMode,
      });
      setConnections((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
    } catch (err) {
      setActionBanner({
        kind: "error",
        message: errorMessage(err, "Could not update ingest mode."),
      });
    }
  }

  return (
    <div data-testid="integrations-page">
      <header className="mb-6">
        <h1 className="font-serif text-xl text-ink sm:text-2xl">Integrations</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Integrations are explicit, optional, and admin-controlled. Live
          integrations route through the self-hosted Nango bridge that runs
          alongside Whereas; tokens stay in Nango. Roadmap items are listed
          for visibility and are not connected yet.
        </p>
      </header>

      {actionBanner && (
        <div
          role={actionBanner.kind === "error" ? "alert" : "status"}
          className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            actionBanner.kind === "error"
              ? "border-danger-ring bg-danger-soft text-danger"
              : "border-info-ring bg-info-soft text-info"
          }`}
          data-testid="integrations-banner"
        >
          {actionBanner.message}
        </div>
      )}

      <section
        className="space-y-6"
        data-testid="integrations-live-section"
        aria-labelledby="integrations-live-heading"
      >
        <h2
          id="integrations-live-heading"
          className="text-xs font-semibold uppercase tracking-wider text-ink-muted"
        >
          Active integrations
        </h2>

        <DocuSealCard />

        {state.kind === "loading" && <LoadingSkeleton rows={2} />}
        {state.kind === "error" && (
          <ErrorState
            title="Could not load integrations"
            description={state.message}
            action={
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium border border-rule text-ink hover:bg-canvas-muted transition-colors"
                data-testid="integrations-retry"
              >
                Retry
              </button>
            }
          />
        )}
        {state.kind === "loaded" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {providers.map((provider) => {
              const connection =
                connectionsByProvider.get(provider.key) ?? null;
              return (
                <ProviderCard
                  key={provider.key}
                  provider={provider}
                  connection={connection}
                  pending={
                    connection
                      ? pendingByConnection[connection.id] ?? "idle"
                      : "idle"
                  }
                  showsFolderPicker={FOLDER_PICKER_PROVIDERS.has(provider.key)}
                  onConnect={() => handleConnect(provider)}
                  onSync={(conn) => handleSync(conn, provider.label)}
                  onDisconnect={(conn) =>
                    handleDisconnect(conn, provider.label)
                  }
                  onIngestModeChange={handleIngestModeChange}
                  onEditFolder={(conn) => setPickerForConnectionId(conn.id)}
                />
              );
            })}
          </div>
        )}
      </section>

      <section
        className="mt-10 space-y-6"
        data-testid="integrations-roadmap-section"
        aria-labelledby="integrations-roadmap-heading"
      >
        <h2
          id="integrations-roadmap-heading"
          className="text-xs font-semibold uppercase tracking-wider text-ink-muted"
        >
          Roadmap
        </h2>
        <p className="text-xs text-ink-muted">
          Planned / Not connected in this MVP. Listed so operators know what
          is on deck.
        </p>
        {ROADMAP_CATEGORIES.map((category) => {
          const items = ROADMAP_INTEGRATIONS.filter(
            (i) => i.category === category,
          );
          const categorySlug = slugify(category);
          return (
            <div
              key={category}
              data-testid={`integration-category-${categorySlug}`}
            >
              <h3 className="mb-2 text-xs font-medium text-ink">{category}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {items.map((integration) => (
                  <RoadmapCard
                    key={integration.name}
                    integration={integration}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>


      <section
        className="mt-10 space-y-4"
        data-testid="integrations-inspiration-section"
        aria-labelledby="integrations-inspiration-heading"
      >
        <div>
          <h2
            id="integrations-inspiration-heading"
            className="text-xs font-semibold uppercase tracking-wider text-ink-muted"
          >
            Open-source inspiration radar
          </h2>
          <p className="mt-2 max-w-3xl text-xs text-ink-muted">
            Research-backed product bets from open-source legal, signing, CRM,
            and automation projects. These are not active connectors; they help
            evaluators understand where Whereas should integrate, borrow
            patterns, or deliberately stay focused.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {INSPIRATION_PROJECTS.map((project) => (
            <InspirationCard key={project.name} project={project} />
          ))}
        </div>
      </section>

      {pickerForConnectionId &&
        (() => {
          const connection = connections.find(
            (c) => c.id === pickerForConnectionId,
          );
          if (!connection) return null;
          const provider = providers.find((p) => p.key === connection.provider);
          return (
            <FolderPicker
              connectionId={connection.id}
              providerLabel={provider?.label ?? connection.provider}
              initialFolderId={connection.root_folder_id}
              initialFolderName={connection.root_folder_name}
              onCancel={() => setPickerForConnectionId(null)}
              onPick={(folder) => handleSaveFolder(connection, folder)}
              onClear={() => handleClearFolder(connection)}
            />
          );
        })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  provider: IntegrationProvider;
  connection: IntegrationConnection | null;
  pending: "idle" | "syncing" | "disconnecting";
  showsFolderPicker: boolean;
  onConnect: () => void;
  onSync: (connection: IntegrationConnection) => void;
  onDisconnect: (connection: IntegrationConnection) => void;
  onIngestModeChange: (
    connection: IntegrationConnection,
    mode: IntegrationIngestMode,
  ) => void;
  onEditFolder: (connection: IntegrationConnection) => void;
}

function ProviderCard({
  provider,
  connection,
  pending,
  showsFolderPicker,
  onConnect,
  onSync,
  onDisconnect,
  onIngestModeChange,
  onEditFolder,
}: ProviderCardProps) {
  const slug = slugify(provider.key);
  return (
    <article
      className="rounded-lg border border-rule bg-canvas p-4"
      data-testid={`integration-card-${slug}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{provider.label}</h3>
          {connection?.display_name && (
            <p className="mt-0.5 text-xs text-ink-muted">
              {connection.display_name}
            </p>
          )}
        </div>
        <ConnectionStatusPill
          connection={connection}
          providerAvailable={provider.available}
          slug={slug}
        />
      </div>

      <p className="mt-2 text-xs text-ink-muted">{provider.description}</p>

      {connection ? (
        <ConnectionDetails
          connection={connection}
          slug={slug}
          pending={pending}
          showsFolderPicker={showsFolderPicker}
          onSync={() => onSync(connection)}
          onDisconnect={() => onDisconnect(connection)}
          onIngestModeChange={(mode) => onIngestModeChange(connection, mode)}
          onEditFolder={() => onEditFolder(connection)}
        />
      ) : (
        <DisconnectedActions
          provider={provider}
          slug={slug}
          onConnect={onConnect}
        />
      )}
    </article>
  );
}

function ConnectionStatusPill({
  connection,
  providerAvailable,
  slug,
}: {
  connection: IntegrationConnection | null;
  providerAvailable: boolean;
  slug: string;
}) {
  if (!connection) {
    if (!providerAvailable) {
      return (
        <Pill
          tone="neutral"
          variant="soft"
          data-testid={`integration-status-${slug}`}
        >
          Not configured
        </Pill>
      );
    }
    return (
      <Pill
        tone="neutral"
        variant="soft"
        data-testid={`integration-status-${slug}`}
      >
        Not connected
      </Pill>
    );
  }
  if (connection.status === "error") {
    return (
      <Pill
        tone="danger"
        variant="soft"
        data-testid={`integration-status-${slug}`}
      >
        Error
      </Pill>
    );
  }
  if (connection.status === "disconnected") {
    return (
      <Pill
        tone="warning"
        variant="soft"
        data-testid={`integration-status-${slug}`}
      >
        Disconnected
      </Pill>
    );
  }
  return (
    <Pill
      tone="success"
      variant="soft"
      data-testid={`integration-status-${slug}`}
    >
      Connected
    </Pill>
  );
}

function DisconnectedActions({
  provider,
  slug,
  onConnect,
}: {
  provider: IntegrationProvider;
  slug: string;
  onConnect: () => void;
}) {
  if (!provider.available) {
    return (
      <div className="mt-3 space-y-1">
        <button
          type="button"
          disabled
          className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium border border-rule text-ink-muted cursor-not-allowed opacity-60"
          data-testid={`integration-cta-${slug}`}
        >
          Configure Nango to enable
        </button>
        <p
          className="text-xs text-ink-muted"
          data-testid={`integration-caveat-${slug}`}
        >
          Set up OAuth credentials for {provider.label} in the Nango
          dashboard, then add the provider key to{" "}
          <code>NANGO_ENABLED_PROVIDERS</code>.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={onConnect}
        className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium bg-accent text-canvas hover:bg-accent/90 transition-colors"
        data-testid={`integration-cta-${slug}`}
      >
        Connect
      </button>
    </div>
  );
}

function ConnectionDetails({
  connection,
  slug,
  pending,
  showsFolderPicker,
  onSync,
  onDisconnect,
  onIngestModeChange,
  onEditFolder,
}: {
  connection: IntegrationConnection;
  slug: string;
  pending: "idle" | "syncing" | "disconnecting";
  showsFolderPicker: boolean;
  onSync: () => void;
  onDisconnect: () => void;
  onIngestModeChange: (mode: IntegrationIngestMode) => void;
  onEditFolder: () => void;
}) {
  return (
    <div className="mt-3 space-y-2">
      {connection.last_synced_at && (
        <p
          className="text-xs text-ink-muted"
          data-testid={`integration-last-sync-${slug}`}
        >
          Last synced {formatRelative(connection.last_synced_at)}
        </p>
      )}
      {connection.last_sync_error && (
        <p
          className="text-xs text-danger"
          data-testid={`integration-last-error-${slug}`}
        >
          Last sync failed: {connection.last_sync_error}
        </p>
      )}
      {showsFolderPicker && (
        <div
          className="flex flex-wrap items-baseline gap-x-2 text-xs"
          data-testid={`integration-folder-${slug}`}
        >
          <span className="text-ink-muted">Folder:</span>
          <span
            className="text-ink"
            data-testid={`integration-folder-name-${slug}`}
          >
            {connection.root_folder_name ?? "Whole drive"}
          </span>
          <button
            type="button"
            onClick={onEditFolder}
            className="text-accent underline-offset-2 hover:underline"
            data-testid={`integration-folder-edit-${slug}`}
          >
            Change
          </button>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-ink">
        <span className="text-ink-muted">Ingest mode</span>
        <select
          value={connection.ingest_mode}
          onChange={(e) =>
            onIngestModeChange(e.target.value as IntegrationIngestMode)
          }
          className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink"
          data-testid={`integration-ingest-mode-${slug}`}
        >
          <option value="inbox_review">Inbox review</option>
          <option value="direct">Direct ingest</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          disabled={pending !== "idle"}
          onClick={onSync}
          className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium bg-accent text-canvas hover:bg-accent/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          data-testid={`integration-sync-${slug}`}
        >
          {pending === "syncing" ? "Syncing…" : "Sync now"}
        </button>
        <button
          type="button"
          disabled={pending !== "idle"}
          onClick={onDisconnect}
          className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium border border-rule text-ink hover:bg-canvas-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          data-testid={`integration-disconnect-${slug}`}
        >
          {pending === "disconnecting" ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    </div>
  );
}

function DocuSealCard() {
  const docusealUrl =
    (import.meta.env.VITE_DOCUSEAL_BASE_URL ?? "").trim() ||
    "http://localhost:8081";
  return (
    <article
      className="rounded-lg border border-rule bg-canvas p-4"
      data-testid="integration-card-docuseal"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">DocuSeal</h3>
          <p className="mt-0.5 text-xs text-ink-muted">E-signature</p>
        </div>
        <Pill
          tone="success"
          variant="soft"
          data-testid="integration-status-docuseal"
        >
          Configured
        </Pill>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Self-hostable e-signature engine bundled into the Whereas Docker
        Compose. Configured at deploy time via{" "}
        <code>DOCUSEAL_BASE_URL</code> and{" "}
        <code>DOCUSEAL_AUTH_BRIDGE_SECRET</code>; no runtime Connect flow.
      </p>
      <div className="mt-3">
        <a
          href={docusealUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium bg-accent text-canvas hover:bg-accent/90 transition-colors"
          data-testid="integration-cta-docuseal"
        >
          Open DocuSeal
        </a>
      </div>
    </article>
  );
}

function InspirationCard({ project }: { project: InspirationProject }) {
  const slug = slugify(project.name);
  return (
    <article
      className="rounded-lg border border-rule bg-canvas p-4"
      data-testid={`inspiration-card-${slug}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{project.name}</h3>
          <p className="mt-0.5 text-xs text-ink-muted">{project.pattern}</p>
        </div>
        <Pill tone="info" variant="soft">
          Idea
        </Pill>
      </div>
      <p className="mt-2 text-xs text-ink">{project.whereasBet}</p>
    </article>
  );
}

function RoadmapCard({ integration }: { integration: RoadmapIntegration }) {
  const slug = slugify(integration.name);
  return (
    <article
      className="rounded-lg border border-rule bg-canvas p-4"
      data-testid={`integration-card-${slug}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{integration.name}</h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            {integration.category}
          </p>
        </div>
        <Pill
          tone="neutral"
          variant="soft"
          data-testid={`integration-status-${slug}`}
        >
          Planned
        </Pill>
      </div>
      <p className="mt-2 text-xs text-ink-muted">{integration.description}</p>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value.toLowerCase().replace(/[\s/]+/g, "-");
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const deltaSec = Math.round((Date.now() - ts) / 1000);
  if (deltaSec < 60) return "moments ago";
  if (deltaSec < 3600) {
    const m = Math.round(deltaSec / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (deltaSec < 86400) {
    const h = Math.round(deltaSec / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.round(deltaSec / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
