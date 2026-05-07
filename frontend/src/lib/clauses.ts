import type { Clause } from "../types/contracts";

/**
 * Per-design-principle: a clause whose recorded offsets do not point at
 * its `text` exactly is treated as "Citation unavailable" rather than
 * highlighted. This guards against backend regressions and demo-mode
 * editing slip-ups.
 */
export function clauseHasValidSpan(
  clause: Clause,
  fullText: string | null,
): boolean {
  if (!fullText) return false;
  const { span_start, span_end, text } = clause;
  if (
    !Number.isInteger(span_start) ||
    !Number.isInteger(span_end) ||
    span_start < 0 ||
    span_end <= span_start ||
    span_end > fullText.length
  ) {
    return false;
  }
  return fullText.slice(span_start, span_end) === text;
}

/**
 * Stable React key for selection state. Field keys live in the same
 * namespace via `field:` so the workspace can hold either kind of
 * selection without collisions.
 */
export function clauseSelectionKey(clause: Clause): string {
  return `clause:${clause.id}`;
}

const CLAUSE_TYPE_LABELS: Record<string, string> = {
  recitals: "Recitals",
  definitions: "Definitions",
  confidentiality: "Confidentiality",
  non_disclosure: "Non-disclosure",
  non_compete: "Non-compete",
  non_solicit: "Non-solicit",
  limitation_of_liability: "Limitation of liability",
  indemnification: "Indemnification",
  intellectual_property: "Intellectual property",
  data_protection: "Data protection",
  dispute_resolution: "Dispute resolution",
  governing_law: "Governing law",
  force_majeure: "Force majeure",
  warranties: "Warranties",
  representations: "Representations",
  insurance: "Insurance",
  audit_rights: "Audit rights",
  amendment: "Amendment",
  entire_agreement: "Entire agreement",
  severability: "Severability",
  waiver: "Waiver",
  notices: "Notices",
  assignment: "Assignment",
  termination: "Termination",
  term: "Term",
  payment: "Payment",
  signature: "Signature",
};

export function clauseTypeLabel(type: string | null | undefined): string {
  if (!type) return "Unclassified";
  if (CLAUSE_TYPE_LABELS[type]) return CLAUSE_TYPE_LABELS[type];
  return type
    .replace(/_/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function clausePreview(clause: Clause, max = 160): string {
  const collapsed = clause.text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
