import type { HTMLAttributes, ReactNode } from "react";

export type Severity = "low" | "medium" | "high" | "blocker" | "overdue";

export interface SeverityTagProps extends HTMLAttributes<HTMLSpanElement> {
  level: Severity;
  children?: ReactNode;
}

const BASE =
  "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] uppercase tracking-wider font-semibold whitespace-nowrap";

const STYLES: Record<Severity, string> = {
  low: "bg-info-soft text-info",
  medium: "bg-warning-soft text-warning",
  high: "bg-warning text-canvas",
  blocker: "bg-danger-soft text-danger",
  overdue: "bg-danger-soft text-danger border border-danger/40",
};

export default function SeverityTag({
  level,
  children,
  className,
  ...rest
}: SeverityTagProps) {
  return (
    <span
      {...rest}
      className={[BASE, STYLES[level], className].filter(Boolean).join(" ")}
    >
      {children ?? level.toUpperCase()}
    </span>
  );
}
