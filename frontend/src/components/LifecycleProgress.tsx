import type { LifecycleStage, LifecycleStageStatus } from "../lib/requestLifecycle";

interface Props {
  stages: LifecycleStage[];
  "data-testid"?: string;
}

export default function LifecycleProgress({
  stages,
  "data-testid": testId,
}: Props) {
  return (
    <nav
      aria-label="Contract lifecycle"
      data-testid={testId ?? "lifecycle-progress"}
    >
      <ol className="flex flex-col gap-1 sm:flex-row sm:gap-0 sm:items-start">
        {stages.map((stage, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === stages.length - 1;
          const prevDone = !isFirst && stages[idx - 1].status === "complete";
          const selfDone = stage.status === "complete";

          return (
            <li
              key={stage.id}
              className="flex flex-1 flex-col"
              aria-current={stage.status === "current" ? "step" : undefined}
              data-testid={`lifecycle-stage-${stage.id}`}
            >
              {/* Mobile layout */}
              <div className="flex items-start gap-3 sm:hidden">
                <div className="flex flex-col items-center">
                  <StageIcon status={stage.status} />
                  {!isLast && (
                    <div
                      className={[
                        "mt-0.5 w-0.5 h-4",
                        selfDone ? "bg-success" : "bg-rule",
                      ].join(" ")}
                      aria-hidden
                    />
                  )}
                </div>
                <div className={isLast ? "" : "pb-1"}>
                  <p className={`text-xs font-medium ${labelColor(stage.status)}`}>
                    {stage.label}
                  </p>
                  {stage.description && (
                    <p className="text-xs text-ink-subtle">{stage.description}</p>
                  )}
                </div>
              </div>

              {/* Desktop layout — horizontal stepper with connector lines */}
              <div className="hidden sm:flex sm:flex-col sm:items-center sm:w-full">
                <div className="flex w-full items-center">
                  {/* Left connector */}
                  <div
                    className={[
                      "h-0.5 flex-1",
                      isFirst ? "invisible" : prevDone ? "bg-success" : "bg-rule",
                    ].join(" ")}
                    aria-hidden
                  />
                  <StageIcon status={stage.status} />
                  {/* Right connector */}
                  <div
                    className={[
                      "h-0.5 flex-1",
                      isLast ? "invisible" : selfDone ? "bg-success" : "bg-rule",
                    ].join(" ")}
                    aria-hidden
                  />
                </div>
                <div className="mt-1.5 px-1 text-center">
                  <p className={`text-xs font-medium ${labelColor(stage.status)}`}>
                    {stage.label}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function labelColor(status: LifecycleStageStatus): string {
  if (status === "blocked") return "text-danger";
  if (status === "not_started") return "text-ink-subtle";
  return "text-ink";
}

function StageIcon({ status }: { status: LifecycleStageStatus }) {
  const base =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full";

  if (status === "complete") {
    return (
      <span
        className={`${base} bg-success text-canvas`}
        aria-label="Complete"
        role="img"
      >
        <svg
          className="h-3 w-3"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
        >
          <path
            d="M2 6l3 3 5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (status === "current") {
    return (
      <span
        className={`${base} border-2 border-ink bg-canvas`}
        aria-label="Current step"
        role="img"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ink" aria-hidden />
      </span>
    );
  }

  if (status === "blocked") {
    return (
      <span
        className={`${base} bg-danger text-canvas`}
        aria-label="Blocked"
        role="img"
      >
        <svg
          className="h-3 w-3"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
        >
          <path
            d="M2 2l8 8M10 2l-8 8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  // not_started
  return (
    <span
      className={`${base} border border-rule-strong bg-canvas`}
      aria-label="Not started"
      role="img"
    >
      <span className="h-1 w-1 rounded-full bg-rule-strong" aria-hidden />
    </span>
  );
}
