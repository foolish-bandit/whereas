import { useState, type ReactNode } from "react";
import { useLocation, Navigate } from "react-router-dom";

import EmptyTabState from "../components/EmptyTabState";
import FindingCard from "../components/FindingCard";
import KpiTile from "../components/dashboard/KpiTile";
import MetadataRow from "../components/MetadataRow";
import Pill, { type PillTone, type PillVariant } from "../components/ui/Pill";
import SeverityTag, { type Severity } from "../components/ui/SeverityTag";
import StatusBadge from "../components/StatusBadge";
import TrendIndicator from "../components/dashboard/TrendIndicator";
import type { ExtractedField } from "../types/contracts";
import type { PlaybookFinding } from "../types/demoExtras";

/**
 * `/dev/components` — a single source of truth for every shared
 * component's variants. Useful for catching pill / tag drift before
 * it lands in the workspace. The route is intentionally hidden:
 *
 *   - import.meta.env.DEV → always available locally.
 *   - ?dev=1 → available in production builds for one-off audits.
 *
 * Production deploys *without* ?dev=1 redirect to the dashboard.
 */
export default function DevComponentsPage() {
  const { search } = useLocation();
  const isDev = import.meta.env.DEV;
  const hasFlag = new URLSearchParams(search).get("dev") === "1";
  if (!isDev && !hasFlag) {
    return <Navigate to="/demo/dashboard" replace />;
  }
  return (
    <div data-testid="dev-components-page">
      <header className="mb-8">
        <h1 className="font-serif text-xl text-ink sm:text-2xl">
          Components playground
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-muted">
          Every shared component rendered in every variant. Use this
          page to catch pill / tag drift before it lands in the
          workspace. Hidden from production unless{" "}
          <code className="font-mono text-xs">?dev=1</code> is set.
        </p>
      </header>

      <Section
        id="pill"
        title="<Pill>"
        description="Status pill. Six tones × three variants."
      >
        <PillMatrix />
      </Section>

      <Section
        id="severity-tag"
        title="<SeverityTag>"
        description="Severity tag. Defaults to the uppercased level."
      >
        <div className="flex flex-wrap items-center gap-2">
          {(["low", "medium", "high", "blocker", "overdue"] as Severity[]).map(
            (level) => (
              <CopyableExample
                key={level}
                code={`<SeverityTag level="${level}" />`}
              >
                <SeverityTag level={level} />
              </CopyableExample>
            ),
          )}
        </div>
      </Section>

      <Section
        id="status-badge"
        title="<StatusBadge>"
        description="Contract status pill. Delegates to <Pill> via statusToPill()."
      >
        <div className="flex flex-wrap items-center gap-2">
          {[
            "uploaded",
            "extracting",
            "ready",
            "failed",
            "sent_for_signature",
            "executed",
          ].map((s) => (
            <CopyableExample key={s} code={`<StatusBadge status="${s}" />`}>
              <StatusBadge status={s} />
            </CopyableExample>
          ))}
        </div>
      </Section>

      <Section
        id="kpi-tile"
        title="<KpiTile>"
        description="Dashboard tile. Optional danger flag + trend indicator."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile label="Open requests" value={42} description="Status open" />
          <KpiTile
            label="Open requests"
            value={42}
            description="Status open"
            trend={{ pct: 12 }}
          />
          <KpiTile
            label="Overdue approvals"
            value={3}
            description="Past due"
            danger
            trend={{ pct: -3, invert: true }}
          />
        </div>
      </Section>

      <Section
        id="trend-indicator"
        title="<TrendIndicator>"
        description="Small ↑/↓ + pct + caption."
      >
        <div className="flex flex-wrap items-center gap-3">
          <TrendIndicator delta={{ pct: 12 }} />
          <TrendIndicator delta={{ pct: -7 }} />
          <TrendIndicator delta={{ pct: -3, invert: true }} />
          <TrendIndicator
            delta={{ pct: 5, caption: "vs. last quarter" }}
          />
        </div>
      </Section>

      <Section
        id="metadata-row"
        title="<MetadataRow>"
        description="Extracted-field row with confidence pill + jump-to-source."
      >
        <ul className="divide-y divide-rule rounded-lg border border-rule bg-canvas">
          <MetadataRow
            field={demoField("governing_law", "New York", 0.96)}
            isSelected={false}
            onJumpToSource={() => {}}
          />
          <MetadataRow
            field={demoField("term", "24 months", 0.74)}
            isSelected={false}
            onJumpToSource={() => {}}
          />
          <MetadataRow
            field={demoField("contract_value", "$480,000 USD", 0.42)}
            isSelected={false}
            onJumpToSource={() => {}}
          />
          <MetadataRow
            field={demoField("counterparty", "Acme Corporation", 0.9, false)}
            isSelected={false}
            onJumpToSource={() => {}}
            override={{ value: "Acme Corp" }}
            onClearOverride={() => {}}
          />
        </ul>
      </Section>

      <Section
        id="finding-card"
        title="<FindingCard>"
        description="Playbook finding (Prompt 6)."
      >
        <ul className="space-y-2">
          {demoFindings.map((f) => (
            <li key={f.id}>
              <FindingCard
                finding={f}
                onChangeStatus={() => {}}
                onJumpToCitation={() => {}}
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="empty-tab-state"
        title="<EmptyTabState>"
        description="Placeholder card for unimplemented rail tabs."
      >
        <EmptyTabState
          label="Clauses"
          message="Clause extraction has not run for this document yet."
        />
      </Section>
    </div>
  );
}

interface SectionProps {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}

function Section({ id, title, description, children }: SectionProps) {
  return (
    <section
      id={id}
      className="mb-10"
      data-testid={`dev-components-section-${id}`}
    >
      <h2 className="font-mono text-sm font-medium text-ink">{title}</h2>
      <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

interface CopyableExampleProps {
  code: string;
  children: ReactNode;
}

function CopyableExample({ code, children }: CopyableExampleProps) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (no permission, http context);
      // swallow — the user still sees the rendered example.
    }
  }
  return (
    <span className="group relative inline-flex items-center gap-1.5">
      {children}
      <button
        type="button"
        onClick={onCopy}
        className="invisible rounded border border-rule px-1 text-[10px] text-ink-subtle hover:text-ink group-hover:visible"
        title={code}
        data-testid="dev-components-copy"
      >
        {copied ? "✓" : "copy"}
      </button>
    </span>
  );
}

function PillMatrix() {
  const tones: PillTone[] = [
    "neutral",
    "info",
    "success",
    "warning",
    "danger",
    "accent",
  ];
  const variants: PillVariant[] = ["soft", "solid", "outline"];
  return (
    <div className="overflow-hidden rounded-lg border border-rule">
      <table className="min-w-full divide-y divide-rule text-sm">
        <thead className="bg-canvas-subtle text-[11px] uppercase tracking-wider text-ink-subtle">
          <tr>
            <th className="px-3 py-2 text-left">tone \ variant</th>
            {variants.map((v) => (
              <th key={v} className="px-3 py-2 text-left">
                {v}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {tones.map((tone) => (
            <tr key={tone}>
              <td className="px-3 py-2 font-mono text-xs text-ink-muted">
                {tone}
              </td>
              {variants.map((variant) => (
                <td key={variant} className="px-3 py-2">
                  <CopyableExample
                    code={`<Pill tone="${tone}" variant="${variant}">Sample</Pill>`}
                  >
                    <Pill tone={tone} variant={variant}>
                      Sample
                    </Pill>
                  </CopyableExample>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function demoField(
  name: string,
  value: string,
  confidence: number,
  withSpan = true,
): ExtractedField {
  return {
    field_name: name,
    value_json: value,
    span_start: withSpan ? 0 : null,
    span_end: withSpan ? 10 : null,
    span_text: withSpan ? value : null,
    confidence,
    model_name: "demo",
    prompt_version: "v0",
    extracted_at: "2026-01-01T00:00:00Z",
  };
}

const demoFindings: PlaybookFinding[] = [
  {
    id: "dev-f-1",
    playbook_rule_id: "rule.demo.blocker",
    rule_label: "Limitation of liability uncapped",
    severity: "blocker",
    status: "open",
    finding_text:
      "No express cap on liability. Playbook requires a cap equal to fees paid in the prior 12 months.",
    standard_position:
      "Each party's aggregate liability is limited to fees paid in the prior 12 months.",
    suggested_redline: "Notwithstanding any provision to the contrary…",
    citation: { text_preview_start: 0, text_preview_end: 10 },
  },
  {
    id: "dev-f-2",
    playbook_rule_id: "rule.demo.accepted",
    rule_label: "Governing law as-expected",
    severity: "low",
    status: "accepted",
    finding_text: "California governing law matches the playbook preference.",
    standard_position: "Provider-paper MSAs are governed by California law.",
    suggested_redline: "(no change required)",
    citation: { text_preview_start: 0, text_preview_end: 10 },
  },
];
