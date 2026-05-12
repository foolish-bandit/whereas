import { useCallback, useState } from "react";

import MetadataRow, { type FieldOverride } from "./MetadataRow";
import { fieldKey } from "../lib/fields";
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
  // Human overrides are local to this session for now — the backend
  // mutation lands with the broader extraction-edit story. Wiring
  // here keeps the UI honest about the "Manually set" state today.
  const [overrides, setOverrides] = useState<Record<string, FieldOverride>>({});

  const onSaveOverride = useCallback((key: string, value: string) => {
    setOverrides((prev) => ({ ...prev, [key]: { value } }));
  }, []);

  const onClearOverride = useCallback((key: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

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
          Machine-generated. Use the source-jump button on a row to view
          its citation in the document. Review before relying on any value.
        </p>
      </div>
      <ul className="divide-y divide-rule">
        {fields.map((f) => {
          const key = fieldKey(f);
          const isSelected = key === selectedKey;
          return (
            <MetadataRow
              key={key}
              field={f}
              isSelected={isSelected}
              onJumpToSource={(k) => onSelect(isSelected ? null : k)}
              override={overrides[key] ?? null}
              onSaveOverride={onSaveOverride}
              onClearOverride={onClearOverride}
            />
          );
        })}
      </ul>
    </div>
  );
}
