import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import FirstRunSetupCard from "../components/FirstRunSetupCard";
import PageHeader from "../components/ui/PageHeader";
import { isStandaloneDisplayMode } from "../lib/browserCapabilities";
import { getDevUserId } from "../lib/devUser";
import { demoPath } from "../lib/routes";

const START_SURFACES = [
  {
    title: "Dashboard",
    description:
      "See what needs attention across requests, approvals, and the repository.",
    to: demoPath("/dashboard"),
  },
  {
    title: "Intake",
    description:
      "Start a request, upload an agreement, or route new work into the system.",
    to: demoPath("/intake"),
  },
  {
    title: "Repository",
    description: "Browse contracts already stored in the workspace.",
    to: demoPath("/repository"),
  },
];

export default function PwaWelcomePage() {
  const [devUserId, setDevUserIdState] = useState<string | null>(() =>
    getDevUserId(),
  );
  const standalone = isStandaloneDisplayMode();

  useEffect(() => {
    function syncDevUser() {
      setDevUserIdState(getDevUserId());
    }

    function onStorage(e: StorageEvent) {
      if (e.key === "whereas.devUserId" || e.key === null) {
        syncDevUser();
      }
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("whereas:devUserChanged", syncDevUser);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("whereas:devUserChanged", syncDevUser);
    };
  }, []);

  return (
    <div className="space-y-6" data-testid="pwa-welcome-page">
      <PageHeader
        eyebrow={
          <span className="inline-flex rounded-full border border-rule bg-canvas-subtle px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
            {standalone ? "Installed app" : "App workspace"}
          </span>
        }
        title="Welcome to Whereas"
        description="The installable app opens into the product workspace, not the marketing site. Set up this browser once, then use Dashboard, Intake, and Repository as your primary starting points."
      />

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)]">
        <div className="space-y-4">
          <div className="rounded-lg border border-rule bg-canvas p-5">
            <h2 className="text-sm font-medium text-ink">How this app works</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <StepCard
                number="1"
                title="Connect this browser"
                description="Create or attach to the local workspace so this browser can call the API."
              />
              <StepCard
                number="2"
                title="Start from Dashboard"
                description="Use the dashboard for work queues and status. You do not need to return to settings for normal use."
              />
              <StepCard
                number="3"
                title="Use Intake or Repository"
                description="Intake is for new work. Repository is for stored contracts and records."
              />
            </div>
            <p className="mt-4 text-xs text-ink-muted">
              This local build still uses a browser-stored development identity
              instead of full sign-in. That is temporary, but it is enough to
              run the product locally today.
            </p>
          </div>

          <div className="rounded-lg border border-rule bg-canvas p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium text-ink">Where to go next</h2>
                <p className="mt-1 text-xs text-ink-muted">
                  Once setup is complete, these are the main entry points.
                </p>
              </div>
              {devUserId && (
                <span className="rounded-full border border-success-ring bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                  Browser connected
                </span>
              )}
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {START_SURFACES.map((surface) => (
                <Link
                  key={surface.to}
                  to={surface.to}
                  className="rounded-lg border border-rule bg-canvas-subtle p-4 transition-colors hover:border-rule-strong hover:bg-canvas"
                  data-testid={`pwa-welcome-link-${surface.title.toLowerCase()}`}
                >
                  <p className="text-sm font-medium text-ink">{surface.title}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {surface.description}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <FirstRunSetupCard
            hasDevUser={devUserId !== null}
            onCompleted={() => setDevUserIdState(getDevUserId())}
          />
          <div className="rounded-lg border border-rule bg-canvas-subtle p-5 text-xs text-ink-muted">
            <h2 className="text-sm font-medium text-ink">
              Need the technical view?
            </h2>
            <p className="mt-1">
              Settings still includes browser capability checks and the manual
              local user field, but most people should not need either for
              normal app use.
            </p>
            <Link
              to={demoPath("/settings")}
              className="mt-4 inline-flex items-center rounded border border-rule bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:border-rule-strong"
            >
              Open settings
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function StepCard({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-rule bg-canvas-subtle p-4">
      <div className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-rule bg-canvas text-[11px] font-medium text-ink">
        {number}
      </div>
      <p className="mt-3 text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs text-ink-muted">{description}</p>
    </div>
  );
}
