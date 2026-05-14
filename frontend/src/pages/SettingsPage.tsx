import { useState } from "react";
import { Link } from "react-router-dom";

import BrowserCapabilitiesCard from "../components/BrowserCapabilitiesCard";
import FirstRunSetupCard from "../components/FirstRunSetupCard";
import {
  clearDevUserId,
  getDevUserId,
  isValidUuid,
  setDevUserId,
} from "../lib/devUser";
import { isDemoMode } from "../lib/env";

const AI_CAPABILITIES: Array<{ capability: string; status: string }> = [
  { capability: "Embeddings", status: "Planned / Disabled" },
  { capability: "Clause similarity", status: "Planned" },
  { capability: "Entity extraction", status: "Planned" },
  { capability: "Playbook-grounded findings", status: "Planned" },
  { capability: "Small-model explanation writer", status: "Planned" },
  { capability: "Cloud AI providers", status: "Not enabled" },
];

export default function SettingsPage() {
  const demo = isDemoMode();
  const [value, setValue] = useState<string>(() => getDevUserId() ?? "");
  const [stored, setStored] = useState<string | null>(() => getDevUserId());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function notifyChanged() {
    window.dispatchEvent(new CustomEvent("whereas:devUserChanged"));
  }

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!isValidUuid(trimmed)) {
      setError(
        "Enter a valid UUID. The backend rejects anything that is not a UUID.",
      );
      setSaved(false);
      return;
    }
    try {
      setDevUserId(trimmed);
      setStored(trimmed);
      setError(null);
      setSaved(true);
      notifyChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaved(false);
    }
  }

  function onClear() {
    clearDevUserId();
    setValue("");
    setStored(null);
    setError(null);
    setSaved(false);
    notifyChanged();
  }

  return (
    <div data-testid="settings-page">
      <h1 className="font-serif text-2xl text-ink">Settings</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Use this page to connect this browser to your local workspace and
        review technical environment details. Whereas currently identifies
        callers by an{" "}
        <code className="font-mono text-xs">X-Whereas-Dev-User</code> header.
        Full sign-in and user management are planned beyond this MVP - see{" "}
        <Link
          to="/demo/known-limitations#auth"
          className="underline hover:text-ink"
        >
          known limitations
        </Link>
        .
      </p>

      {demo && (
        <div className="mt-4 max-w-2xl rounded-lg border border-info-ring bg-info-soft p-4 text-sm text-info">
          <p>
            This deployment is running in demo mode with mock data. Setup,
            uploads, and authoring flows are simulated in the browser; nothing
            leaves this tab. The development user ID is not used.
          </p>
        </div>
      )}

      <div className="mt-6 max-w-2xl">
        <FirstRunSetupCard
          hasDevUser={stored !== null}
          onCompleted={() => {
            setValue(getDevUserId() ?? "");
            setStored(getDevUserId());
          }}
        />
      </div>

      {!demo && (
        <details className="mt-6 max-w-2xl rounded-lg border border-rule bg-canvas">
          <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium text-ink hover:bg-canvas-subtle">
            Advanced: set local user ID manually
          </summary>
          <div className="border-t border-rule p-5">
            <p className="text-xs text-ink-muted">
              Most users should use the setup card above. Use this only if you
              need to reconnect this browser manually or troubleshoot a local
              environment.
            </p>
            <form onSubmit={onSave} className="mt-4 space-y-3">
              <input
                type="text"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(false);
                  setError(null);
                }}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="w-full rounded border border-rule bg-canvas-subtle px-3 py-1.5 font-mono text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
                spellCheck={false}
                autoComplete="off"
              />
              {error && <p className="text-sm text-danger">{error}</p>}
              {saved && !error && <p className="text-sm text-success">Saved.</p>}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <button
                  type="submit"
                  className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="inline-flex w-full items-center justify-center rounded border border-rule bg-canvas px-3 py-2 text-sm font-medium text-ink hover:border-rule-strong sm:w-auto sm:py-1.5"
                >
                  Clear
                </button>
              </div>
            </form>
            <div className="mt-5 border-t border-rule pt-4 text-xs text-ink-muted">
              <p>
                Currently stored:{" "}
                {stored ? (
                  <span className="font-mono text-ink">{stored}</span>
                ) : (
                  <span className="italic">none</span>
                )}
              </p>
            </div>
          </div>
        </details>
      )}

      <BrowserCapabilitiesCard />

      <div
        className="mt-6 max-w-2xl rounded-lg border border-rule bg-canvas p-5"
        data-testid="settings-ai-local-intelligence"
      >
        <h2 className="text-sm font-medium text-ink">
          AI &amp; local intelligence
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Whereas is designed for small, local/self-hostable models. Default AI
          models must stay at or below 2B parameters. No cloud AI provider is
          enabled by default, and no contract text is sent to cloud AI
          providers by default.
        </p>

        <ul className="mt-4 space-y-2 text-sm text-ink">
          {AI_CAPABILITIES.map(({ capability, status }) => (
            <li
              key={capability}
              data-testid={`settings-ai-capability-${capability.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}
              className="flex items-center justify-between gap-3 rounded border border-rule bg-canvas-subtle px-3 py-2"
            >
              <span>{capability}</span>
              <span className="rounded-full border border-rule bg-canvas px-2 py-0.5 text-xs text-ink-muted">
                {status}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs text-ink-muted">
          Read more in the{" "}
          <a
            href="/docs/AI_SMALL_MODEL_STACK.md"
            className="underline hover:text-ink"
          >
            AI_SMALL_MODEL_STACK
          </a>{" "}
          and see{" "}
          <Link
            to="/demo/known-limitations#review-ai"
            className="underline hover:text-ink"
          >
            known limitations
          </Link>
          .
        </p>
      </div>

      <div className="mt-6 max-w-2xl rounded-lg border border-rule bg-canvas-subtle p-5 text-xs text-ink-muted">
        <h2 className="text-sm font-medium text-ink">A reminder</h2>
        <p className="mt-1">
          Whereas surfaces information about contracts. It does not provide
          legal advice and does not replace human legal review. Extracted
          metadata is machine-generated and must be reviewed before decisions
          are made.
        </p>
      </div>
    </div>
  );
}
