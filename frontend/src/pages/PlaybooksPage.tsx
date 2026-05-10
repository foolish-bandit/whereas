import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import {
  ApiError,
  MissingDevUserError,
  PlaybookValidationError,
  createPlaybook,
  getPlaybooks,
  validatePlaybook,
} from "../lib/api";
import { formatDate } from "../lib/format";
import type {
  PlaybookSummary,
  PlaybookValidateResponse,
} from "../types/playbooks";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; playbooks: PlaybookSummary[] }
  | { kind: "error"; title: string; description: string };

const STARTER_YAML = `name: "Example NDA Playbook"
description: "Starter rules — edit to taste."
version: "1.0"
jurisdiction: "California"
contract_type: "mutual_nda"

rules:
  - id: "confidentiality-required"
    title: "Confidentiality clause should be present"
    clause_type: "confidentiality"
    severity: "high"
    rule_type: "required_clause"
  - id: "governing-law-california"
    title: "Governing law should be California"
    clause_type: "governing_law"
    severity: "medium"
    rule_type: "preferred_value"
    expected_value: "California"
`;

export default function PlaybooksPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeInactive, setIncludeInactive] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [authorOpen, setAuthorOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    getPlaybooks({ signal: controller.signal, includeInactive })
      .then((playbooks) => setState({ kind: "loaded", playbooks }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setState({
            kind: "error",
            title: "No development user ID configured",
            description:
              "Set a development user ID in Settings before listing playbooks.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setState({
            kind: "error",
            title: "Could not load playbooks",
            description: err.message,
          });
          return;
        }
        setState({
          kind: "error",
          title: "Could not load playbooks",
          description: "An unexpected error occurred.",
        });
      });
    return () => controller.abort();
  }, [includeInactive]);

  const filtered = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const q = search.trim().toLowerCase();
    if (!q) return state.playbooks;
    return state.playbooks.filter((p) => {
      const hay = `${p.name} ${p.description ?? ""} ${p.contract_type ?? ""} ${
        p.jurisdiction ?? ""
      }`.toLowerCase();
      return hay.includes(q);
    });
  }, [state, search]);

  function onCreated(summary: PlaybookSummary) {
    setState((prev) =>
      prev.kind === "loaded"
        ? { kind: "loaded", playbooks: [summary, ...prev.playbooks] }
        : prev,
    );
    setAuthorOpen(false);
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-xl text-ink sm:text-2xl">Playbooks</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Review standards, fallback positions, and deviation rules for
            contract review. Open an agreement from the Repository and use
            the Review tab to run a playbook against its segmented clauses.
            Whereas surfaces information about agreements; it does not
            provide legal advice.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAuthorOpen((v) => !v)}
          className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
          aria-expanded={authorOpen}
        >
          {authorOpen ? "Close editor" : "New playbook"}
        </button>
      </div>

      {authorOpen && (
        <PlaybookAuthor
          onCreated={onCreated}
          onCancel={() => setAuthorOpen(false)}
        />
      )}

      {state.kind === "loaded" && state.playbooks.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, description, jurisdiction…"
            aria-label="Search playbooks"
            className="flex-1 min-w-[240px] rounded border border-rule bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
          />
          <label className="inline-flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            Show deactivated
          </label>
        </div>
      )}

      {state.kind === "loading" && <LoadingSkeleton rows={4} />}

      {state.kind === "error" && (
        <ErrorState
          title={state.title}
          description={state.description}
          action={
            <Link
              to="/demo/settings"
              className="inline-flex items-center rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong"
            >
              Open settings
            </Link>
          }
        />
      )}

      {state.kind === "loaded" && state.playbooks.length === 0 && (
        <EmptyState
          title={
            includeInactive
              ? "No playbooks have been defined yet."
              : "No active playbooks."
          }
          description={
            includeInactive
              ? "Playbooks are YAML files that capture your firm's review positions. Authoring tools land in a follow-up release."
              : "Toggle 'Show deactivated' to include archived playbooks, or create a new one once authoring tools land."
          }
        />
      )}

      {state.kind === "loaded" && state.playbooks.length > 0 && (
        <>
          <PlaybookTable playbooks={filtered} />
          <p className="mt-3 text-xs text-ink-subtle">
            {filtered.length} of {state.playbooks.length} playbooks shown.
          </p>
          {filtered.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">
              No playbooks match the current filters.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PlaybookTable({ playbooks }: { playbooks: PlaybookSummary[] }) {
  if (playbooks.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      {/* Card layout on small screens. */}
      <ul className="divide-y divide-rule sm:hidden">
        {playbooks.map((p) => (
          <li key={p.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link
                to={`/demo/playbooks/${p.id}`}
                className="font-medium text-ink hover:text-accent-ring"
              >
                {p.name}
              </Link>
              <StatusPill active={p.is_active} />
            </div>
            {p.description && (
              <p className="mt-1 line-clamp-3 text-xs text-ink-muted">
                {p.description}
              </p>
            )}
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-muted">
              <div>
                <dt className="text-ink-subtle">Contract type</dt>
                <dd>{p.contract_type ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-ink-subtle">Jurisdiction</dt>
                <dd>{p.jurisdiction ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-ink-subtle">Rules</dt>
                <dd className="font-mono">{p.rule_count}</dd>
              </div>
              <div>
                <dt className="text-ink-subtle">Updated</dt>
                <dd>{formatDate(p.updated_at)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="min-w-full divide-y divide-rule text-sm">
          <thead className="bg-canvas-subtle text-xs uppercase tracking-wide text-ink-subtle">
            <tr>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Name
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Contract type
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Jurisdiction
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Rules
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Updated
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {playbooks.map((p) => (
              <tr key={p.id} className="hover:bg-canvas-subtle">
                <td className="px-4 py-3">
                  <Link
                    to={`/demo/playbooks/${p.id}`}
                    className="font-medium text-ink hover:text-accent-ring"
                  >
                    {p.name}
                  </Link>
                  {p.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
                      {p.description}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-muted">
                  {p.contract_type ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-muted">
                  {p.jurisdiction ?? "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                  {p.rule_count}
                </td>
                <td className="px-4 py-3">
                  <StatusPill active={p.is_active} />
                </td>
                <td className="px-4 py-3 text-xs text-ink-muted">
                  {formatDate(p.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex items-center rounded-full border border-rule bg-canvas-subtle px-2 py-0.5 text-[11px] font-medium text-ink-muted">
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-rule bg-canvas-muted px-2 py-0.5 text-[11px] font-medium text-ink-subtle">
      Deactivated
    </span>
  );
}

interface PlaybookAuthorProps {
  onCreated: (summary: PlaybookSummary) => void;
  onCancel: () => void;
}

type AuthorState =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "validated"; preview: PlaybookValidateResponse }
  | { kind: "creating" }
  | { kind: "error"; message: string; issues?: string[] };

function PlaybookAuthor({ onCreated, onCancel }: PlaybookAuthorProps) {
  const [yaml, setYaml] = useState(STARTER_YAML);
  const [state, setState] = useState<AuthorState>({ kind: "idle" });

  function handleError(err: unknown): AuthorState {
    if (err instanceof PlaybookValidationError) {
      return {
        kind: "error",
        message: "Validation failed.",
        issues: err.issues.map((i) =>
          i.path ? `${i.path}: ${i.message}` : i.message,
        ),
      };
    }
    if (err instanceof MissingDevUserError) {
      return {
        kind: "error",
        message:
          "Set a development user ID in Settings before creating a playbook.",
      };
    }
    if (err instanceof ApiError) {
      return { kind: "error", message: err.message };
    }
    return { kind: "error", message: "An unexpected error occurred." };
  }

  async function onValidate() {
    setState({ kind: "validating" });
    try {
      const preview = await validatePlaybook(yaml);
      setState({ kind: "validated", preview });
    } catch (err) {
      setState(handleError(err));
    }
  }

  async function onCreate() {
    setState({ kind: "creating" });
    try {
      const detail = await createPlaybook(yaml);
      onCreated({
        id: detail.id,
        name: detail.name,
        description: detail.description,
        jurisdiction: detail.jurisdiction,
        contract_type: detail.contract_type,
        version: detail.version,
        is_active: detail.is_active,
        rule_count: detail.rule_count,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
      });
    } catch (err) {
      setState(handleError(err));
    }
  }

  return (
    <section
      aria-label="New playbook"
      className="mb-6 rounded-lg border border-rule bg-canvas p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">New playbook</h2>
        <p className="text-xs text-ink-subtle">
          Paste or edit YAML below. Validate first to preview the parsed rules.
        </p>
      </header>
      <textarea
        value={yaml}
        onChange={(e) => {
          setYaml(e.target.value);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        spellCheck={false}
        rows={14}
        aria-label="Playbook YAML"
        className="mt-3 block w-full resize-y rounded border border-rule bg-canvas-subtle px-3 py-2 font-mono text-xs leading-relaxed text-ink"
      />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <button
          type="button"
          onClick={onValidate}
          disabled={state.kind === "validating" || state.kind === "creating"}
          className="inline-flex w-full items-center justify-center rounded border border-rule bg-canvas px-3 py-2 text-sm font-medium text-ink hover:border-rule-strong disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
        >
          {state.kind === "validating" ? "Validating…" : "Validate"}
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={state.kind === "creating" || state.kind === "validating"}
          className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
        >
          {state.kind === "creating" ? "Creating…" : "Create playbook"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex w-full items-center justify-center rounded border border-rule bg-canvas px-3 py-2 text-sm font-medium text-ink-muted hover:text-ink sm:w-auto sm:py-1.5"
        >
          Cancel
        </button>
      </div>

      {state.kind === "validated" && (
        <div
          className="mt-3 rounded border border-success-ring bg-success-soft px-3 py-2 text-xs text-ink-muted"
          role="status"
        >
          <p className="font-medium text-success">
            Validated · {state.preview.rule_count} rule
            {state.preview.rule_count === 1 ? "" : "s"}
          </p>
          <p className="mt-0.5 text-ink-muted">
            <span className="font-medium text-ink">{state.preview.name}</span>
            {state.preview.contract_type
              ? ` · ${state.preview.contract_type}`
              : ""}
            {state.preview.jurisdiction
              ? ` · ${state.preview.jurisdiction}`
              : ""}
          </p>
        </div>
      )}

      {state.kind === "error" && (
        <div
          className="mt-3 rounded border border-danger-ring bg-danger-soft px-3 py-2 text-xs text-danger"
          role="alert"
        >
          <p className="font-medium">{state.message}</p>
          {state.issues && state.issues.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {state.issues.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
