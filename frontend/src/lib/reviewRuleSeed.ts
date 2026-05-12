import type { ReviewRule } from "../types/reviewRules";

/**
 * PR #118 — seed review-rule rows for the Playbooks grid foundation.
 *
 * Fictional and short by design — no copyrighted contract language,
 * and short enough to render readably in a grid cell. These exist so
 * the empty state isn't the default first-run experience; users can
 * see the concept at a glance.
 */
export const SEED_REVIEW_RULES: ReviewRule[] = [
  {
    id: "rr-nda-confidentiality-scope",
    issue: "Confidentiality scope too broad",
    contract_type: "NDA",
    severity: "high",
    standard_position:
      "Mutual confidentiality limited to information marked or identified as confidential at the time of disclosure.",
    fallback_position:
      "Unilateral confidentiality is acceptable only when the counterparty is the sole discloser (e.g. vendor briefings).",
    canned_response:
      "Please narrow the confidentiality obligation to information that is marked or identified as confidential at the time of disclosure.",
    example_clause:
      "\"Confidential Information\" means non-public information marked or identified as confidential at the time of disclosure.",
    status: "active",
    updated_at: "2026-04-12T10:00:00Z",
  },
  {
    id: "rr-msa-liability-cap",
    issue: "Limitation of liability uncapped",
    contract_type: "MSA",
    severity: "blocker",
    standard_position:
      "Total aggregate liability capped at fees paid in the prior 12 months. Carve-outs limited to indemnity, confidentiality breach, and gross negligence.",
    fallback_position:
      "2x fees paid in the prior 12 months acceptable for strategic counterparties only.",
    canned_response:
      "We cannot accept uncapped liability. Please cap aggregate liability at fees paid in the prior 12 months, with narrow carve-outs.",
    example_clause:
      "Each party's total aggregate liability under this Agreement shall not exceed the fees paid by Customer in the 12 months preceding the claim.",
    status: "active",
    updated_at: "2026-04-15T10:00:00Z",
  },
  {
    id: "rr-vendor-auto-renewal",
    issue: "Auto-renewal without notice",
    contract_type: "Vendor agreement",
    severity: "medium",
    standard_position:
      "No auto-renewal, or auto-renewal only with at least 60 days' written notice of non-renewal.",
    fallback_position:
      "30 days' notice acceptable for low-spend renewals (under $25k annual).",
    canned_response:
      "Please remove auto-renewal or provide at least 60 days' notice of non-renewal.",
    example_clause:
      "This Agreement will not auto-renew. Either party may renew by written agreement before the end of the then-current term.",
    status: "active",
    updated_at: "2026-04-18T10:00:00Z",
  },
  {
    id: "rr-employment-non-compete",
    issue: "Non-compete included",
    contract_type: "Employment agreement",
    severity: "high",
    standard_position:
      "No non-compete clauses. Use a narrowly-scoped non-solicit limited to direct customers and direct reports for 12 months post-termination.",
    fallback_position:
      "If a non-compete is legally required, limit geography, scope, and duration to what's enforceable in the employee's jurisdiction.",
    canned_response:
      "We do not include non-compete clauses. Please replace with a non-solicit limited to direct customers and direct reports for 12 months.",
    example_clause:
      "Employee agrees not to directly solicit any customer or employee with whom Employee had material contact during the 12 months preceding termination.",
    status: "active",
    updated_at: "2026-04-22T10:00:00Z",
  },
  {
    id: "rr-msa-ip-assignment",
    issue: "IP assignment too broad",
    contract_type: "MSA",
    severity: "medium",
    standard_position:
      "Customer owns deliverables specifically created for it. Service provider retains pre-existing IP and reusable methodologies.",
    fallback_position:
      "Joint ownership of deliverables acceptable only with a perpetual royalty-free license back to the service provider.",
    canned_response:
      "Please carve out our pre-existing IP and reusable methodologies from the assignment, with a license to Customer to use them in deliverables.",
    example_clause:
      "Service Provider retains all right, title, and interest in pre-existing IP and reusable methodologies. Customer receives a non-exclusive license to use them as embedded in the Deliverables.",
    status: "active",
    updated_at: "2026-04-25T10:00:00Z",
  },
  {
    id: "rr-dpa-subprocessor-notice",
    issue: "Subprocessor changes without notice",
    contract_type: "DPA",
    severity: "high",
    standard_position:
      "Provider must give 30 days' written notice before adding or replacing a subprocessor, with a right to object.",
    fallback_position:
      "14 days' notice acceptable when a subprocessor change is required for security reasons.",
    canned_response:
      "Please add a 30-day notice requirement before subprocessor changes, with our right to object on reasonable grounds.",
    example_clause:
      "Provider shall notify Customer at least 30 days before adding or replacing any Subprocessor. Customer may object on reasonable grounds within the notice period.",
    status: "active",
    updated_at: "2026-04-28T10:00:00Z",
  },
];
