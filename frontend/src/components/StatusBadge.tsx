import type { ContractStatus } from "../types/contracts";

interface StatusBadgeProps {
  status: ContractStatus | string;
}

interface StatusStyle {
  label: string;
  classes: string;
}

const STYLES: Record<string, StatusStyle> = {
  ready: {
    label: "Ready",
    classes: "bg-success-soft text-success border-success-ring",
  },
  uploaded: {
    label: "Uploaded",
    classes: "bg-info-soft text-info border-info-ring",
  },
  extracting: {
    label: "Extracting",
    classes: "bg-info-soft text-info border-info-ring",
  },
  failed: {
    label: "Extraction failed",
    classes: "bg-danger-soft text-danger border-danger-ring",
  },
  sent_for_signature: {
    label: "Sent for signature",
    classes: "bg-canvas-muted text-ink-muted border-rule",
  },
  executed: {
    label: "Executed",
    classes: "bg-success-soft text-success border-success-ring",
  },
};

const FALLBACK: StatusStyle = {
  label: "Unknown",
  classes: "bg-canvas-muted text-ink-muted border-rule",
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const style = STYLES[status] ?? { ...FALLBACK, label: status || "Unknown" };
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        style.classes,
      ].join(" ")}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {style.label}
    </span>
  );
}
