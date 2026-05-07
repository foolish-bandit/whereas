import ConfidenceBadge from "./ConfidenceBadge";
import { fieldHasValidSpan, fieldKey } from "../lib/fields";
import { humanizeFieldName, renderExtractedValue } from "../lib/format";
import type { ExtractedField } from "../types/contracts";

interface MetadataPanelProps {
  fields: ExtractedField[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}

export default function MetadataPanel({
  fields,
  selectedKey,
  onSelect,
}: MetadataPanelProps) {
  if (fields.length === 0) {
    return (
      <div className="rounded-lg border border-rule bg-canvas p-5">
        <h2 className="text-sm font-medium text-ink">Extracted metadata</h2>
        <p className="mt-2 text-sm text-ink-muted">
          No metadata has been extracted for this contract yet.
        </p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Extracted metadata</h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Machine-generated. Click a field to view its citation in the document.
          Review before relying on any value.
        </p>
      </div>
      <ul className="divide-y divide-rule">
        {fields.map((f) => {
          const key = fieldKey(f);
          const isSelected = key === selectedKey;
          const hasSpan = fieldHasValidSpan(f);
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onSelect(isSelected ? null : key)}
                className={[
                  "flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors",
                  isSelected
                    ? "bg-info-soft"
                    : "hover:bg-canvas-subtle",
                ].join(" ")}
                aria-pressed={isSelected}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
                    {humanizeFieldName(f.field_name)}
                  </span>
                  <ConfidenceBadge confidence={f.confidence} />
                </div>
                <div className="text-sm text-ink">
                  {renderExtractedValue(f.value_json)}
                </div>
                <div className="text-xs text-ink-muted">
                  {hasSpan && f.span_text ? (
                    <p className="line-clamp-3 italic">“{f.span_text.trim()}”</p>
                  ) : (
                    <p className="text-warning">Citation unavailable</p>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-ink-subtle">
                  <span className="font-mono">{f.model_name}</span>
                  <span aria-hidden>·</span>
                  <span>prompt {f.prompt_version}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
