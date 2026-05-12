import type { HTMLAttributes, ReactNode } from "react";

export type PillTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

export type PillVariant = "soft" | "solid" | "outline";

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  variant?: PillVariant;
  children: ReactNode;
}

const BASE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap";

const SOFT: Record<PillTone, string> = {
  neutral: "bg-canvas-muted text-ink-muted border border-rule",
  info: "bg-info-soft text-info border border-info-ring",
  success: "bg-success-soft text-success border border-success-ring",
  warning: "bg-warning-soft text-warning border border-warning-ring",
  danger: "bg-danger-soft text-danger border border-danger-ring",
  accent: "bg-canvas-muted text-accent border border-rule-strong",
};

const SOLID: Record<PillTone, string> = {
  neutral: "bg-ink text-canvas",
  info: "bg-info text-canvas",
  success: "bg-success text-canvas",
  warning: "bg-warning text-canvas",
  danger: "bg-danger text-canvas",
  accent: "bg-accent text-canvas",
};

const OUTLINE: Record<PillTone, string> = {
  neutral: "border border-rule text-ink-muted",
  info: "border border-info-ring text-info",
  success: "border border-success-ring text-success",
  warning: "border border-warning-ring text-warning",
  danger: "border border-danger-ring text-danger",
  accent: "border border-accent-ring text-accent",
};

const VARIANTS = { soft: SOFT, solid: SOLID, outline: OUTLINE };

export default function Pill({
  tone = "neutral",
  variant = "soft",
  className,
  children,
  ...rest
}: PillProps) {
  const cls = VARIANTS[variant][tone];
  return (
    <span
      {...rest}
      className={[BASE, cls, className].filter(Boolean).join(" ")}
    >
      {children}
    </span>
  );
}
