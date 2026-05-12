import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import TrendIndicator, { type TrendDelta } from "./TrendIndicator";

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  description?: string;
  to?: string;
  /** When true, render the value in danger-toned text. Used by tiles
   * whose non-zero value is a problem (overdue counts, etc.). */
  danger?: boolean;
  trend?: TrendDelta | null;
  testId?: string;
}

const BASE_CLASSES =
  "block rounded-lg border bg-canvas p-5 shadow-sm transition-colors hover:border-rule-strong";

export default function KpiTile({
  label,
  value,
  description,
  to,
  danger,
  trend,
  testId,
}: KpiTileProps) {
  const borderClass = danger ? "border-danger-ring" : "border-rule";
  const valueClass = `mt-2 text-3xl font-semibold tabular-nums ${
    danger ? "text-danger" : "text-ink"
  }`;
  const inner = (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className={valueClass}>{value}</div>
      {description ? (
        <div className="mt-1 text-xs text-ink-muted">{description}</div>
      ) : null}
      {trend ? <TrendIndicator delta={trend} /> : null}
    </>
  );
  if (to) {
    return (
      <Link
        to={to}
        className={`${BASE_CLASSES} ${borderClass}`}
        data-testid={testId}
      >
        {inner}
      </Link>
    );
  }
  return (
    <div
      className={`${BASE_CLASSES} ${borderClass}`}
      data-testid={testId}
    >
      {inner}
    </div>
  );
}
