import { confidenceTier } from "../lib/format";

interface ConfidenceBadgeProps {
  confidence: number;
}

const TIER_STYLES = {
  high: {
    label: "High",
    classes: "bg-success-soft text-success border-success-ring",
  },
  medium: {
    label: "Medium",
    classes: "bg-warning-soft text-warning border-warning-ring",
  },
  low: {
    label: "Low",
    classes: "bg-danger-soft text-danger border-danger-ring",
  },
} as const;

export default function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  const tier = confidenceTier(confidence);
  const style = TIER_STYLES[tier];
  const numeric = Number.isFinite(confidence)
    ? `${Math.round(confidence * 100)}%`
    : "—";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        style.classes,
      ].join(" ")}
      title={`Model confidence ${numeric}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      <span>{style.label}</span>
      <span className="font-mono text-[11px] opacity-75">{numeric}</span>
    </span>
  );
}
