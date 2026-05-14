import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import ErrorState from "./ErrorState";
import { ApiError, createDevSetup, getSetupStatus } from "../lib/api";
import { setDevUserId } from "../lib/devUser";
import { demoPath } from "../lib/routes";
import type { SetupStatus } from "../types/setup";

type StatusState =
  | { kind: "loading" }
  | { kind: "ready"; status: SetupStatus }
  | { kind: "error"; title: string; description: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; title: string; description: string };

interface FirstRunSetupCardProps {
  hasDevUser: boolean;
  onCompleted: () => void;
}

export default function FirstRunSetupCard({
  hasDevUser,
  onCompleted,
}: FirstRunSetupCardProps) {
  const [statusState, setStatusState] = useState<StatusState>({
    kind: "loading",
  });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [orgName, setOrgName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");
  const [completed, setCompleted] = useState<{
    organization_name: string;
    user_email: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatusState({ kind: "loading" });
    getSetupStatus({ signal: controller.signal })
      .then((status) => setStatusState({ kind: "ready", status }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError) {
          setStatusState({
            kind: "error",
            title: "Could not check setup status",
            description: err.message,
          });
          return;
        }
        setStatusState({
          kind: "error",
          title: "Could not check setup status",
          description: "An unexpected error occurred.",
        });
      });
    return () => controller.abort();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitState({ kind: "submitting" });
    try {
      const payload = {
        organization_name: orgName.trim() || undefined,
        user_email: userEmail.trim() || undefined,
        user_name: userName.trim() || undefined,
      };
      const result = await createDevSetup(payload);
      setDevUserId(result.dev_user_id);
      window.dispatchEvent(new CustomEvent("whereas:devUserChanged"));
      setCompleted({
        organization_name: result.organization_name,
        user_email: result.user_email,
        message: result.message,
      });
      setSubmitState({ kind: "idle" });
      onCompleted();
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitState({
          kind: "error",
          title: "Setup failed",
          description: err.message,
        });
        return;
      }
      setSubmitState({
        kind: "error",
        title: "Setup failed",
        description: "An unexpected error occurred.",
      });
    }
  }

  if (statusState.kind === "loading") {
    return (
      <div className="rounded-lg border border-rule bg-canvas p-5">
        <h2 className="text-sm font-medium text-ink">Set up this workspace</h2>
        <p className="mt-2 text-sm text-ink-muted">Checking workspace...</p>
      </div>
    );
  }

  if (statusState.kind === "error") {
    return (
      <ErrorState
        title={statusState.title}
        description={statusState.description}
      />
    );
  }

  if (completed) {
    return (
      <div className="rounded-lg border border-success-ring bg-success-soft p-5">
        <p className="font-medium text-success">{completed.message}</p>
        <p className="mt-1 text-sm text-ink-muted">
          <span className="font-medium text-ink">
            {completed.organization_name}
          </span>{" "}
          -{" "}
          <span className="font-mono text-xs">{completed.user_email}</span>
        </p>
        <p className="mt-2 text-xs text-ink-muted">
          This browser is now connected to the local workspace.
        </p>
        <div className="mt-4">
          <Link
            to={demoPath("/dashboard")}
            className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
          >
            Open dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!statusState.status.setup_required && hasDevUser) {
    return null;
  }

  return (
    <div className="rounded-lg border border-rule bg-canvas p-5">
      <h2 className="text-sm font-medium text-ink">Set up this workspace</h2>
      <p className="mt-1 text-xs text-ink-muted">
        {statusState.status.setup_required
          ? "Create a local workspace and save a local user in this browser. You only need to do this once per browser."
          : "A workspace already exists on this backend. Use this form to connect this browser to it."}
      </p>

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <div>
          <label
            htmlFor="setup-org-name"
            className="block text-xs font-medium text-ink-muted"
          >
            Workspace name (optional)
          </label>
          <input
            id="setup-org-name"
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Local Workspace"
            disabled={submitState.kind === "submitting"}
            className="mt-1 w-full rounded border border-rule bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
            maxLength={255}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="setup-user-email"
              className="block text-xs font-medium text-ink-muted"
            >
              Email (optional)
            </label>
            <input
              id="setup-user-email"
              type="email"
              value={userEmail}
              onChange={(e) => setUserEmail(e.target.value)}
              placeholder="dev@whereas.local"
              disabled={submitState.kind === "submitting"}
              className="mt-1 w-full rounded border border-rule bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
              maxLength={255}
              autoComplete="off"
            />
          </div>
          <div>
            <label
              htmlFor="setup-user-name"
              className="block text-xs font-medium text-ink-muted"
            >
              Name (optional)
            </label>
            <input
              id="setup-user-name"
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Local Developer"
              disabled={submitState.kind === "submitting"}
              className="mt-1 w-full rounded border border-rule bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
              maxLength={255}
            />
          </div>
        </div>

        {submitState.kind === "error" && (
          <ErrorState
            title={submitState.title}
            description={submitState.description}
          />
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={submitState.kind === "submitting"}
            className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
          >
            {submitState.kind === "submitting"
              ? "Setting up..."
              : statusState.status.setup_required
                ? "Create workspace"
                : "Connect this browser"}
          </button>
        </div>
      </form>
    </div>
  );
}
