import { useMemo, useState } from "react";

import Pill, { type PillTone } from "./ui/Pill";
import { formatDateTime } from "../lib/format";
import type {
  DocumentVersion,
  VersionSource,
} from "../types/demoExtras";

const SOURCE_TONE: Record<VersionSource, PillTone> = {
  upload: "info",
  generated: "accent",
  docuseal_signed: "success",
  counterparty: "warning",
};

const SOURCE_LABEL: Record<VersionSource, string> = {
  upload: "Upload",
  generated: "Generated",
  docuseal_signed: "Signed",
  counterparty: "Counterparty",
};

export interface HistoryTabProps {
  versions: DocumentVersion[];
  /**
   * The parent owns the diff overlay over the document pane; we just
   * tell it which pair of versions to compare.
   */
  onCompare: (base: DocumentVersion, against: DocumentVersion) => void;
}

export default function HistoryTab({ versions, onCompare }: HistoryTabProps) {
  // Newest first for display.
  const ordered = useMemo(
    () =>
      [...versions].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)),
    [versions],
  );

  const [compareTargets, setCompareTargets] = useState<Record<string, string>>(
    () => {
      // Default each version's "compare against" to the next-newer version.
      const m: Record<string, string> = {};
      for (let i = 0; i < ordered.length; i += 1) {
        const next = ordered[i + 1];
        if (next) m[ordered[i].id] = next.id;
      }
      return m;
    },
  );

  if (versions.length === 0) {
    return (
      <div
        className="rounded-lg border border-rule bg-canvas p-5 text-sm text-ink-muted"
        data-testid="history-tab-empty"
      >
        No version history captured for this contract yet.
      </div>
    );
  }

  return (
    <section data-testid="history-tab">
      <p className="mb-3 text-xs text-ink-subtle">
        Document versions captured for this contract. Click Compare to
        open a side-by-side diff in the document pane.
      </p>
      <ol className="relative ml-4 border-l-2 border-rule">
        {ordered.map((v) => {
          const targetId = compareTargets[v.id];
          const target = ordered.find((x) => x.id === targetId);
          return (
            <li
              key={v.id}
              className="relative -ml-[7px] mb-4 pl-5"
              data-testid={`history-tab-version-${v.id}`}
            >
              <span
                aria-hidden
                className="absolute -left-[6px] top-2 inline-block h-3 w-3 rounded-full border-2 border-rule bg-canvas"
              />
              <div className="rounded-lg border border-rule bg-canvas p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-ink">{v.version_label}</p>
                  <Pill tone={SOURCE_TONE[v.source]} variant="soft">
                    {SOURCE_LABEL[v.source]}
                  </Pill>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-subtle">
                  {formatDateTime(v.uploaded_at)} ·{" "}
                  {v.uploaded_by_display_name}
                </p>
                <p className="mt-1 text-xs text-ink-muted">{v.summary}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {target ? (
                    <button
                      type="button"
                      onClick={() => onCompare(target, v)}
                      className="rounded border border-rule bg-canvas px-2 py-1 text-ink hover:border-rule-strong"
                      data-testid={`history-tab-compare-${v.id}`}
                    >
                      Compare to {target.version_label}
                    </button>
                  ) : (
                    <span className="text-ink-subtle">
                      Oldest version — no earlier version to compare.
                    </span>
                  )}
                  {ordered.length > 1 && (
                    <label className="flex items-center gap-1 text-[11px] text-ink-subtle">
                      against
                      <select
                        value={targetId ?? ""}
                        onChange={(e) =>
                          setCompareTargets((prev) => ({
                            ...prev,
                            [v.id]: e.target.value,
                          }))
                        }
                        className="rounded border border-rule bg-canvas px-1.5 py-0.5 text-ink focus:border-accent-ring focus:outline-none"
                        data-testid={`history-tab-compare-target-${v.id}`}
                      >
                        {ordered
                          .filter((x) => x.id !== v.id)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.version_label}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
