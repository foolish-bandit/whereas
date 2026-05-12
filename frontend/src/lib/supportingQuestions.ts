/**
 * Supporting question configuration for the Request intake flow.
 *
 * Whereas treats Requests as the guided intake step in the
 *   Inbox → classify → review request → playbook-guided review →
 *   repository record → signing/history/audit
 * lifecycle. PR #126 adds short, contract-type-aware prompts that
 * help requesters give legal enough context up front. Answers are
 * **optional** — the goal is reviewer guidance, not a compliance
 * interrogation.
 *
 * The backend Request model doesn't have a structured answers field,
 * so on submit we summarise the answers into the existing
 * `description` (or `supportingInfo`) free-text field. No new
 * schema, no new endpoint.
 */

export interface SupportingQuestion {
  /** Stable key used in tests and as the form field id. */
  id: string;
  /** Short human-readable label rendered next to the input. */
  label: string;
  /** Either a single-line short answer or a longer free-text area. */
  kind: "short" | "long";
  /** Optional placeholder hint shown inside the input. */
  placeholder?: string;
}

export interface SupportingQuestionSet {
  /** Group key used in `data-supporting-question-group` for tests. */
  key: string;
  /** Display heading inside the panel. */
  heading: string;
  questions: SupportingQuestion[];
}

const NDA_SET: SupportingQuestionSet = {
  key: "nda",
  heading: "NDA review",
  questions: [
    {
      id: "nda_direction",
      label: "Is this mutual or one-way?",
      kind: "short",
      placeholder: "Mutual / one-way",
    },
    {
      id: "nda_discloser",
      label: "Who is disclosing confidential information?",
      kind: "short",
      placeholder: "Us, them, or both",
    },
    {
      id: "nda_term",
      label: "Preferred confidentiality term?",
      kind: "short",
      placeholder: "e.g. 3 years",
    },
    {
      id: "nda_unusual",
      label: "Unusual disclosure restrictions to flag?",
      kind: "long",
    },
  ],
};

const VENDOR_SET: SupportingQuestionSet = {
  key: "vendor",
  heading: "Vendor agreement",
  questions: [
    {
      id: "vendor_product",
      label: "What product or service is being purchased?",
      kind: "short",
    },
    {
      id: "vendor_renewal",
      label: "New vendor or renewal?",
      kind: "short",
      placeholder: "New / renewal",
    },
    {
      id: "vendor_data_access",
      label: "Will the vendor access company or customer data?",
      kind: "short",
      placeholder: "Yes / no — what kind",
    },
    {
      id: "vendor_security_review",
      label: "Is a security review required?",
      kind: "short",
      placeholder: "Yes / no — status",
    },
    {
      id: "vendor_value",
      label: "Estimated contract value?",
      kind: "short",
      placeholder: "Annual or total",
    },
  ],
};

const MSA_SET: SupportingQuestionSet = {
  key: "msa",
  heading: "MSA review",
  questions: [
    {
      id: "msa_paper",
      label: "Customer paper or company paper?",
      kind: "short",
      placeholder: "Customer / us",
    },
    {
      id: "msa_attached",
      label: "Any attached order forms or SOWs?",
      kind: "short",
    },
    {
      id: "msa_liability",
      label: "Are liability caps negotiable?",
      kind: "short",
      placeholder: "Yes / no — target",
    },
    {
      id: "msa_payment_or_termination",
      label: "Non-standard payment or termination terms?",
      kind: "long",
    },
  ],
};

const EMPLOYMENT_SET: SupportingQuestionSet = {
  key: "employment",
  heading: "Employment agreement",
  questions: [
    {
      id: "employment_role",
      label: "Employee, contractor, advisor, or consultant?",
      kind: "short",
    },
    {
      id: "employment_compensation",
      label: "Is equity, bonus, or commission compensation involved?",
      kind: "short",
    },
    {
      id: "employment_covenants",
      label: "Restrictive covenants expected?",
      kind: "short",
      placeholder: "Non-compete / non-solicit / none",
    },
    {
      id: "employment_jurisdiction",
      label: "Jurisdiction / state that applies?",
      kind: "short",
    },
  ],
};

const DPA_SET: SupportingQuestionSet = {
  key: "dpa",
  heading: "DPA / privacy review",
  questions: [
    {
      id: "dpa_personal_data",
      label: "What personal data is involved?",
      kind: "long",
    },
    {
      id: "dpa_sensitive",
      label: "Sensitive personal information involved?",
      kind: "short",
      placeholder: "Yes / no — what",
    },
    {
      id: "dpa_cross_border",
      label: "Cross-border transfer expected?",
      kind: "short",
      placeholder: "Regions involved",
    },
    {
      id: "dpa_role",
      label: "Counterparty role?",
      kind: "short",
      placeholder: "Processor / vendor / customer",
    },
    {
      id: "dpa_security_addendum",
      label: "Security addendum required?",
      kind: "short",
      placeholder: "Yes / no",
    },
  ],
};

const OTHER_SET: SupportingQuestionSet = {
  key: "other",
  heading: "General context",
  questions: [
    {
      id: "other_summary",
      label: "Briefly describe the deal or request.",
      kind: "long",
    },
    {
      id: "other_deadline",
      label: "Business deadline?",
      kind: "short",
    },
    {
      id: "other_focus",
      label: "Main issue legal should focus on?",
      kind: "long",
    },
  ],
};

/**
 * Match a request_type / contract_type combination to a question set.
 *
 * - request_type is the strongest signal when present (e.g.
 *   `nda_review`, `vendor_agreement`).
 * - contract_type is checked as a fallback for free-text values like
 *   "NDA" or slugs like `mutual_nda`.
 * - Returns OTHER_SET if nothing matches, so the user always sees
 *   *some* useful prompts after picking a type.
 */
export function getQuestionSetFor(
  requestType: string | null | undefined,
  contractType: string | null | undefined,
): SupportingQuestionSet | null {
  const rt = (requestType ?? "").toLowerCase();
  const ct = (contractType ?? "").toLowerCase();
  if (!rt && !ct) return null;

  if (rt === "nda_review" || ct.includes("nda")) return NDA_SET;
  if (rt === "vendor_agreement" || ct.includes("vendor")) return VENDOR_SET;
  if (rt === "employment_agreement" || ct.includes("employment")) {
    return EMPLOYMENT_SET;
  }
  if (ct.includes("dpa") || ct.includes("data processing")) return DPA_SET;
  if (ct === "msa" || ct.includes("master service")) return MSA_SET;
  if (rt === "other") return OTHER_SET;

  // No specific match yet (e.g. user picked `new_contract` without a
  // contract type). Fall back to the general prompts so the panel is
  // still useful instead of going blank.
  return OTHER_SET;
}

export type SupportingAnswers = Record<string, string>;

export interface ParsedSupportingBlock {
  label: string;
  rows: Array<{ question: string; answer: string }>;
  remainingDescription: string;
}

function splitBulletContent(content: string): { question: string; answer: string } {
  const qIdx = content.indexOf("?");
  if (qIdx !== -1 && qIdx < content.length - 1) {
    const answer = content.slice(qIdx + 1).trim();
    if (answer) return { question: content.slice(0, qIdx + 1).trim(), answer };
  }
  const dotIdx = content.indexOf(".");
  if (dotIdx !== -1 && dotIdx < content.length - 1) {
    const answer = content.slice(dotIdx + 1).trim();
    if (answer) return { question: content.slice(0, dotIdx + 1).trim(), answer };
  }
  return { question: content.trim(), answer: "" };
}

/**
 * Parses the stable supporting-questions summary block written by
 * summarizeAnswers / composeDescription at Request submit time.
 *
 * Returns null if the description doesn't start with the expected header,
 * if no bullet rows are found, or if an unexpected non-bullet line appears
 * inside the block — all of which signal the caller to fall back to
 * showing the raw description as plain text.
 */
export function parseSupportingQuestionsBlock(
  description: string | null | undefined,
): ParsedSupportingBlock | null {
  if (!description) return null;
  const text = description.trim();
  const firstNl = text.indexOf("\n");
  const headerLine = (firstNl === -1 ? text : text.slice(0, firstNl)).trim();
  const m = headerLine.match(/^Supporting questions \((.+)\):$/);
  if (!m) return null;
  const label = m[1];
  if (firstNl === -1) return null;
  const bodyLines = text.slice(firstNl + 1).split("\n");
  const rows: Array<{ question: string; answer: string }> = [];
  let blockEnd = bodyLines.length;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.trim() === "") {
      blockEnd = i;
      break;
    }
    if (line.startsWith("• ")) {
      const content = line.slice(2).trim();
      if (content) rows.push(splitBulletContent(content));
    } else {
      return null;
    }
  }
  if (rows.length === 0) return null;
  const remaining = bodyLines.slice(blockEnd).join("\n").trim();
  return { label, rows, remainingDescription: remaining };
}

/**
 * Render the structured answers as a human-readable supporting-info
 * block that we tack onto the existing free-text `description` /
 * `supportingInfo` field at submit time. Empty answers are dropped.
 *
 * The summary is intentionally Markdown-light (no headers, just
 * labelled lines) so it reads cleanly inside the existing
 * description textarea on the Request detail page.
 */
export function summarizeAnswers(
  set: SupportingQuestionSet | null,
  answers: SupportingAnswers,
): string {
  if (!set) return "";
  const lines: string[] = [];
  for (const q of set.questions) {
    const raw = answers[q.id];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    lines.push(`• ${q.label} ${trimmed}`);
  }
  if (lines.length === 0) return "";
  return [`Supporting questions (${set.heading}):`, ...lines].join("\n");
}

/**
 * Compose the final free-text payload sent to the server. The
 * structured summary leads (so reviewers see the guided answers
 * first), then any user-typed free-text follows. Returns an empty
 * string when neither side has content so the caller can convert it
 * to `null` for the API payload.
 */
export function composeDescription(
  summary: string,
  freeText: string,
): string {
  const a = summary.trim();
  const b = freeText.trim();
  if (a && b) return `${a}\n\n${b}`;
  return a || b;
}
