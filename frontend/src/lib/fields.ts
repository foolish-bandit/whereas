import type { ExtractedField } from "../types/contracts";

export function fieldKey(f: ExtractedField): string {
  return `${f.field_name}:${f.span_start ?? "null"}:${f.span_end ?? "null"}`;
}

export function fieldHasValidSpan(f: ExtractedField): boolean {
  return (
    typeof f.span_start === "number" &&
    typeof f.span_end === "number" &&
    Number.isInteger(f.span_start) &&
    Number.isInteger(f.span_end) &&
    f.span_start >= 0 &&
    f.span_end > f.span_start
  );
}
