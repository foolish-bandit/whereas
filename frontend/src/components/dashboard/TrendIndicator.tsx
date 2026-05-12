export interface TrendDelta {
  /** Signed percentage change vs. the comparison window. */
  pct: number;
  /** Caption underneath the indicator. Defaults to "vs. last 30 days". */
  caption?: string;
  /** When true, a positive delta is bad (e.g. overdue counts). Default
   * is "positive is good" (e.g. completed counts). */
  invert?: boolean;
}

export interface TrendIndicatorProps {
  delta: TrendDelta;
}

export default function TrendIndicator({ delta }: TrendIndicatorProps) {
  const positive = delta.pct >= 0;
  // "Positive is good" by default. For tiles where positive movement is
  // bad (e.g. overdue), invert flips the color.
  const isGood = delta.invert ? !positive : positive;
  const arrow = positive ? "↑" : "↓";
  const colorClass = isGood ? "text-success" : "text-danger";
  const caption = delta.caption ?? "vs. last 30 days";
  return (
    <div className="mt-2">
      <span className={`text-xs font-medium tabular-nums ${colorClass}`}>
        <span aria-hidden>{arrow}</span> {Math.abs(delta.pct)}%
      </span>
      <span className="ml-1 text-[10px] text-ink-subtle">{caption}</span>
    </div>
  );
}
