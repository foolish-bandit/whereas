export type ReviewFindingSource =
  | "deterministic_rule"
  | "embedding_match"
  | "small_model_explanation"
  | "manual";

export type ReviewFindingSeverity = "low" | "medium" | "high" | "critical";

export type ReviewFindingHumanStatus =
  | "unreviewed"
  | "accepted"
  | "rejected"
  | "needs_revision";

export interface ReviewFinding {
  id: string;
  source: ReviewFindingSource;
  severity: ReviewFindingSeverity;
  title: string;
  explanation: string;
  source_span_start?: number;
  source_span_end?: number;
  source_excerpt?: string;
  playbook_rule_id?: string;
  playbook_basis?: string;
  clause_id?: string;
  clause_type?: string;
  clause_manager_entry_id?: string;
  fallback_language?: string;
  confidence?: number;
  human_status: ReviewFindingHumanStatus;
  created_at?: string;
}

const GROUNDED_SOURCES: ReadonlySet<ReviewFindingSource> = new Set([
  "deterministic_rule",
  "embedding_match",
  "small_model_explanation",
]);

const SENSITIVE_TOKEN_PATTERNS = [
  /api[_-]?key/i,
  /authorization:/i,
  /bearer\s+[a-z0-9._-]+/i,
  /password/i,
  /secret/i,
  /token/i,
];

function hasSourceEvidence(finding: ReviewFinding): boolean {
  return (
    typeof finding.source_excerpt === "string" && finding.source_excerpt.trim().length > 0
  );
}

function hasSpanEvidence(finding: ReviewFinding): boolean {
  return (
    Number.isInteger(finding.source_span_start) &&
    Number.isInteger(finding.source_span_end) &&
    (finding.source_span_start as number) >= 0 &&
    (finding.source_span_end as number) >= (finding.source_span_start as number)
  );
}

function hasPolicyEvidence(finding: ReviewFinding): boolean {
  return (
    Boolean(finding.playbook_rule_id?.trim()) ||
    Boolean(finding.playbook_basis?.trim()) ||
    Boolean(finding.clause_id?.trim()) ||
    Boolean(finding.clause_type?.trim()) ||
    Boolean(finding.clause_manager_entry_id?.trim()) ||
    Boolean(finding.fallback_language?.trim())
  );
}

export function findingHasGrounding(finding: ReviewFinding): boolean {
  if (finding.source === "manual") {
    return true;
  }

  if (!GROUNDED_SOURCES.has(finding.source)) {
    return false;
  }

  const hasContractTextEvidence = hasSourceEvidence(finding) || hasSpanEvidence(finding);
  return hasContractTextEvidence && hasPolicyEvidence(finding);
}

export function findingRequiresHumanReview(finding: ReviewFinding): boolean {
  return finding.human_status === "unreviewed" || finding.human_status === "needs_revision";
}

function redactSensitiveTokens(text: string): string {
  let redacted = text;
  for (const pattern of SENSITIVE_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

export function safeFindingSummary(finding: ReviewFinding): string {
  const basis = finding.playbook_rule_id?.trim() || finding.clause_type?.trim() || "unspecified_basis";
  const grounded = findingHasGrounding(finding) ? "grounded" : "ungrounded";
  const human = finding.human_status;
  const message = `${finding.severity.toUpperCase()}: ${finding.title} (${grounded}, ${human}, basis=${basis})`;
  return redactSensitiveTokens(message);
}
