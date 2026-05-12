import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import EmptyState from "../components/EmptyState";
import { chartPalette, chartSeverityColor } from "../lib/chartPalette";

/* ---------------------------------------------------------------------- */
/* Time-range picker                                                      */
/* ---------------------------------------------------------------------- */

type RangeId = "7d" | "30d" | "90d" | "ytd" | "all";
const RANGES: { id: RangeId; label: string; days: number | null }[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "ytd", label: "This year", days: null },
  { id: "all", label: "All time", days: null },
];

function rangeStart(id: RangeId, now: Date): Date {
  const r = RANGES.find((x) => x.id === id) ?? RANGES[1];
  if (r.id === "all") return new Date(0);
  if (r.id === "ytd") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const days = r.days ?? 30;
  const t = now.getTime() - days * 86_400_000;
  return new Date(t);
}

/* ---------------------------------------------------------------------- */
/* Demo data — generated once with a deterministic shape so the charts    */
/* always have something to show. A real deployment would replace this    */
/* with /api/analytics queries gated on org-scoped permissions.           */
/* ---------------------------------------------------------------------- */

interface ContractEvent {
  date: string; // YYYY-MM-DD
  type: "created" | "executed";
  contract_type: string;
  cycle_days?: number;
}

interface DeviationCount {
  rule_label: string;
  severity: "blocker" | "high" | "medium" | "low";
  count: number;
}

interface ApprovalBottleneck {
  step_label: string;
  avg_hours: number;
  workflow_count: number;
}

const TODAY = new Date("2026-05-12T00:00:00Z");
const CONTRACT_TYPES = ["NDA", "MSA", "DPA", "SOW", "Order Form"];

function seededInt(seed: number, mod: number): number {
  // tiny LCG so the demo charts don't reshuffle on each render
  const v = (seed * 9301 + 49297) % 233280;
  return Math.abs(Math.floor((v / 233280) * mod));
}

function generateEvents(): ContractEvent[] {
  const events: ContractEvent[] = [];
  for (let dayOffset = 365; dayOffset >= 0; dayOffset -= 1) {
    const d = new Date(TODAY.getTime() - dayOffset * 86_400_000);
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    // Weekends get fewer events
    const baseCreated = dow === 0 || dow === 6 ? 0 : 1 + seededInt(dayOffset, 4);
    const baseExecuted = dow === 0 || dow === 6 ? 0 : seededInt(dayOffset + 17, 3);
    for (let i = 0; i < baseCreated; i += 1) {
      const ct = CONTRACT_TYPES[seededInt(dayOffset + i, CONTRACT_TYPES.length)];
      events.push({ date: dateStr, type: "created", contract_type: ct });
    }
    for (let i = 0; i < baseExecuted; i += 1) {
      const ct = CONTRACT_TYPES[seededInt(dayOffset * 3 + i, CONTRACT_TYPES.length)];
      const cycle = 5 + seededInt(dayOffset + i + 11, 25);
      events.push({
        date: dateStr,
        type: "executed",
        contract_type: ct,
        cycle_days: cycle,
      });
    }
  }
  return events;
}

const ALL_EVENTS = generateEvents();

const DEVIATIONS: DeviationCount[] = [
  { rule_label: "Term exceeds playbook cap", severity: "high", count: 38 },
  { rule_label: "Limitation of liability uncapped", severity: "blocker", count: 27 },
  { rule_label: "Non-preferred governing law", severity: "medium", count: 22 },
  { rule_label: "Auto-renew window too tight", severity: "high", count: 18 },
  { rule_label: "Survival period too long", severity: "low", count: 14 },
  { rule_label: "Termination notice longer than standard", severity: "medium", count: 12 },
  { rule_label: "Indemnity carve-outs missing", severity: "blocker", count: 9 },
  { rule_label: "Confidentiality scope too broad", severity: "low", count: 7 },
  { rule_label: "IP assignment ambiguous", severity: "high", count: 5 },
  { rule_label: "MFN clause present", severity: "medium", count: 4 },
];

const BOTTLENECKS: ApprovalBottleneck[] = [
  { step_label: "Legal — second review", avg_hours: 73, workflow_count: 14 },
  { step_label: "CFO sign-off (>$250k)", avg_hours: 52, workflow_count: 8 },
  { step_label: "Security review (DPA)", avg_hours: 41, workflow_count: 11 },
  { step_label: "Procurement intake", avg_hours: 28, workflow_count: 22 },
  { step_label: "Legal — first review", avg_hours: 16, workflow_count: 31 },
];

/* ---------------------------------------------------------------------- */
/* Page                                                                   */
/* ---------------------------------------------------------------------- */

const RANGE_PARAM = "range";

export default function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = (searchParams.get(RANGE_PARAM) as RangeId) ?? "30d";
  const [range, setRange] = useState<RangeId>(
    RANGES.some((r) => r.id === initial) ? initial : "30d",
  );

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (range === "30d") next.delete(RANGE_PARAM);
    else next.set(RANGE_PARAM, range);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const start = useMemo(() => rangeStart(range, TODAY), [range]);
  const inRange = useMemo(
    () => ALL_EVENTS.filter((e) => new Date(e.date) >= start),
    [start],
  );
  const isEmpty = inRange.length < 4;

  // Throughput series: per-day created / executed counts.
  const throughputSeries = useMemo(() => {
    const byDate = new Map<string, { date: string; created: number; executed: number }>();
    for (const e of inRange) {
      const cell =
        byDate.get(e.date) ?? { date: e.date, created: 0, executed: 0 };
      if (e.type === "created") cell.created += 1;
      else cell.executed += 1;
      byDate.set(e.date, cell);
    }
    return Array.from(byDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }, [inRange]);

  // Cycle time by contract type: average cycle_days across executed events.
  const cycleByType = useMemo(() => {
    const acc = new Map<string, { sum: number; count: number }>();
    for (const e of inRange) {
      if (e.type !== "executed" || e.cycle_days == null) continue;
      const cur = acc.get(e.contract_type) ?? { sum: 0, count: 0 };
      cur.sum += e.cycle_days;
      cur.count += 1;
      acc.set(e.contract_type, cur);
    }
    return Array.from(acc.entries()).map(([type, v]) => ({
      type,
      avg_days: v.count === 0 ? 0 : Math.round(v.sum / v.count),
      sample: v.count,
    }));
  }, [inRange]);

  // Type distribution: count of created events per contract_type.
  const typeBreakdown = useMemo(() => {
    const acc = new Map<string, number>();
    for (const e of inRange) {
      if (e.type !== "created") continue;
      acc.set(e.contract_type, (acc.get(e.contract_type) ?? 0) + 1);
    }
    return Array.from(acc.entries()).map(([type, count]) => ({ type, count }));
  }, [inRange]);

  return (
    <div data-testid="analytics-page">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-xl text-ink sm:text-2xl">Analytics</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Aggregate views over contract throughput, cycle time, playbook
            deviations, and approval bottlenecks. Visibility only — not a
            BI engine.
          </p>
        </div>
        <div
          role="group"
          aria-label="Time range"
          className="inline-flex flex-wrap gap-1"
          data-testid="analytics-range"
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              aria-pressed={range === r.id}
              className={`rounded border px-2 py-1 text-xs ${
                range === r.id
                  ? "border-info-ring bg-info-soft text-info"
                  : "border-rule bg-canvas text-ink-muted hover:text-ink"
              }`}
              data-testid={`analytics-range-${r.id}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {isEmpty ? (
        <EmptyState
          title="Not enough data in this range"
          description="Try a wider window — older contracts and approvals are still here, just outside the current range."
          action={
            <button
              type="button"
              onClick={() => setRange("all")}
              className="inline-flex items-center rounded border border-ink bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:bg-accent-ring"
              data-testid="analytics-empty-all-time"
            >
              Switch to All time
            </button>
          }
        />
      ) : (
        <div className="space-y-6">
          <Section
            title="Throughput"
            subtitle="Contracts created vs. contracts executed, per day."
            testId="analytics-throughput"
          >
            <div className="h-72 w-full">
              <ResponsiveContainer>
                <LineChart data={throughputSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    className="tabular-nums"
                    allowDecimals={false}
                  />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="created"
                    stroke={chartPalette[1]}
                    dot={false}
                    strokeWidth={2}
                  />
                  <Line
                    type="monotone"
                    dataKey="executed"
                    stroke={chartPalette[2]}
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <Section
            title="Cycle time"
            subtitle="Average days from request created to contract executed, by type."
            testId="analytics-cycle-time"
          >
            <div className="h-72 w-full">
              <ResponsiveContainer>
                <BarChart data={cycleByType}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="type" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    className="tabular-nums"
                    label={{
                      value: "avg days",
                      angle: -90,
                      position: "insideLeft",
                      fontSize: 11,
                    }}
                  />
                  <Tooltip />
                  <Bar dataKey="avg_days" fill={chartPalette[0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <Section
            title="Top playbook deviations"
            subtitle="Most-frequently-triggered playbook rules, color-coded by severity."
            testId="analytics-deviations"
          >
            <div className="h-80 w-full">
              <ResponsiveContainer>
                <BarChart data={DEVIATIONS} layout="vertical" margin={{ left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11 }}
                    className="tabular-nums"
                  />
                  <YAxis
                    type="category"
                    dataKey="rule_label"
                    width={250}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip />
                  <Bar dataKey="count">
                    {DEVIATIONS.map((d, i) => (
                      <Cell
                        key={i}
                        fill={chartSeverityColor[d.severity] ?? chartPalette[5]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <Section
            title="Contract type breakdown"
            subtitle="Distribution of contracts created in the selected range."
            testId="analytics-type-breakdown"
          >
            <div className="h-72 w-full">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={typeBreakdown}
                    dataKey="count"
                    nameKey="type"
                    innerRadius={60}
                    outerRadius={100}
                    label
                  >
                    {typeBreakdown.map((_, i) => (
                      <Cell
                        key={i}
                        fill={chartPalette[i % chartPalette.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <Section
            title="Approval bottlenecks"
            subtitle="Approval steps ranked by average time-to-decision."
            testId="analytics-bottlenecks"
          >
            <div className="overflow-hidden rounded border border-rule">
              <table className="min-w-full divide-y divide-rule text-sm">
                <thead className="bg-canvas-subtle text-[11px] uppercase tracking-wider text-ink-subtle">
                  <tr>
                    <th className="px-4 py-2 text-left">Step</th>
                    <th className="px-4 py-2 text-right tabular-nums">
                      Avg hours
                    </th>
                    <th className="px-4 py-2 text-right tabular-nums">
                      Workflows
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {[...BOTTLENECKS]
                    .sort((a, b) => b.avg_hours - a.avg_hours)
                    .map((b) => (
                      <tr key={b.step_label}>
                        <td className="px-4 py-2 text-ink">{b.step_label}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink">
                          {b.avg_hours}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                          {b.workflow_count}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      )}

      <p className="mt-6 text-xs text-ink-subtle">
        Analytics is a visibility-only surface — see{" "}
        <Link to="/demo/playbooks" className="underline hover:text-ink">
          Playbooks
        </Link>{" "}
        to act on the deviations above.
      </p>
    </div>
  );
}

interface SectionProps {
  title: string;
  subtitle: string;
  testId: string;
  children: React.ReactNode;
}

function Section({ title, subtitle, testId, children }: SectionProps) {
  return (
    <section data-testid={testId}>
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      <p className="mb-2 mt-0.5 text-xs text-ink-subtle">{subtitle}</p>
      {children}
    </section>
  );
}
