import { useState } from "react";

import Pill, { type PillTone } from "./ui/Pill";
import { humanizeFieldName, renderExtractedValue } from "../lib/format";
import { fieldHasValidSpan, fieldKey } from "../lib/fields";
import type { ExtractedField } from "../types/contracts";

export interface FieldOverride {
  /** Manually-set value the user typed. */
  value: string;
}

export interface MetadataRowProps {
  field: ExtractedField;
  isSelected: boolean;
  onJumpToSource: (key: string) => void;
  /** Optional human override; when present, the displayed value is the
   * override and a "Manually set" pill replaces the confidence pill. */
  override?: FieldOverride | null;
  onSaveOverride?: (key: string, value: string) => void;
  onClearOverride?: (key: string) => void;
}

function confidencePill(confidence: number): { tone: PillTone; label: string } {
  if (!Number.isFinite(confidence)) {
    return { tone: "danger", label: "— confidence" };
  }
  const pct = Math.round(confidence * 100);
  if (pct >= 90) return { tone: "success", label: `${pct}% confidence` };
  if (pct >= 70) return { tone: "warning", label: `${pct}% confidence` };
  return { tone: "danger", label: `${pct}% confidence` };
}

export default function MetadataRow({
  field,
  isSelected,
  onJumpToSource,
  override,
  onSaveOverride,
  onClearOverride,
}: MetadataRowProps) {
  const key = fieldKey(field);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(
    override?.value ?? renderExtractedValue(field.value_json),
  );

  const displayValue = override?.value ?? renderExtractedValue(field.value_json);
  const hasSpan = fieldHasValidSpan(field);
  const conf = confidencePill(field.confidence);

  function startEdit() {
    setDraft(displayValue);
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    if (onSaveOverride) onSaveOverride(key, draft);
  }

  function cancel() {
    setDraft(displayValue);
    setEditing(false);
  }

  return (
    <li
      className={[
        "group relative px-4 py-3",
        isSelected ? "bg-info-soft" : "hover:bg-canvas-subtle",
      ].join(" ")}
      data-testid={`metadata-row-${key}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
          {humanizeFieldName(field.field_name)}
        </p>
        {!editing && onSaveOverride && (
          <button
            type="button"
            onClick={startEdit}
            className="invisible inline-flex items-center rounded border border-rule px-1.5 py-0.5 text-[10px] text-ink-muted hover:border-rule-strong hover:text-ink group-hover:visible"
            data-testid={`metadata-row-edit-${key}`}
            aria-label={`Edit ${humanizeFieldName(field.field_name)}`}
            title="Edit value"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-[12rem] flex-1 rounded border border-rule bg-canvas px-2 py-1 text-sm text-ink focus:border-accent-ring focus:outline-none"
            data-testid={`metadata-row-input-${key}`}
            autoFocus
          />
          <button
            type="button"
            onClick={commit}
            className="rounded border border-ink bg-ink px-2 py-1 text-xs text-canvas hover:bg-accent-ring"
            data-testid={`metadata-row-save-${key}`}
          >
            Save
          </button>
          <button
            type="button"
            onClick={cancel}
            className="rounded border border-rule px-2 py-1 text-xs text-ink-muted hover:text-ink"
            data-testid={`metadata-row-cancel-${key}`}
          >
            Cancel
          </button>
        </div>
      ) : (
        <p
          className="mt-1.5 text-sm font-medium text-ink"
          data-testid={`metadata-row-value-${key}`}
        >
          {displayValue}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
        {override ? (
          <>
            <Pill
              tone="accent"
              variant="soft"
              data-testid={`metadata-row-manual-${key}`}
            >
              Manually set
            </Pill>
            {onClearOverride && (
              <button
                type="button"
                onClick={() => onClearOverride(key)}
                className="text-ink-muted underline hover:text-ink"
                data-testid={`metadata-row-revert-${key}`}
              >
                revert to extracted
              </button>
            )}
          </>
        ) : (
          <Pill
            tone={conf.tone}
            variant="soft"
            data-testid={`metadata-row-confidence-${key}`}
          >
            <span aria-hidden>✓</span>
            {conf.label}
          </Pill>
        )}
        {hasSpan ? (
          <span className="group/jump relative inline-block">
            <button
              type="button"
              onClick={() => onJumpToSource(key)}
              className="inline-flex items-center gap-1 rounded border border-rule px-1.5 py-0.5 text-ink-muted hover:border-rule-strong hover:text-ink"
              data-testid={`metadata-row-jump-${key}`}
              aria-label={`Jump to source for ${humanizeFieldName(field.field_name)}`}
              aria-describedby={`metadata-row-tooltip-${key}`}
            >
              <span aria-hidden>↗</span> jump to source
            </button>
            {field.span_text ? (
              <span
                id={`metadata-row-tooltip-${key}`}
                role="tooltip"
                data-testid={`metadata-row-tooltip-${key}`}
                className="pointer-events-none invisible absolute bottom-full left-0 z-10 mb-1 w-64 rounded border border-rule bg-canvas p-2 text-xs italic text-ink-muted opacity-0 shadow-md transition-opacity group-hover/jump:visible group-hover/jump:opacity-100"
              >
                “
                {field.span_text.length > 200
                  ? `${field.span_text.slice(0, 200).trim()}…`
                  : field.span_text.trim()}
                ”
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-warning" title="No citation available">
            Citation unavailable
          </span>
        )}
        <span className="font-mono">{field.model_name}</span>
      </div>
    </li>
  );
}
