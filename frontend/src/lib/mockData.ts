/**
 * Sample data for demo mode. Everything here is fictional and labelled as
 * such in the UI. No real contract text, no PII, no real party names.
 *
 * Span offsets are precomputed against `MUTUAL_NDA_TEXT` and validated by
 * `mockApi.test.ts`. If you edit the text, regenerate the offsets.
 */
import type {
  Clause,
  ContractDetail,
  ContractListItem,
  ContractMarkdownSnapshot,
  ExtractedField,
} from "../types/contracts";
import type {
  PlaybookDetail,
  PlaybookRuleSummary,
  PlaybookSummary,
} from "../types/playbooks";
import type { PlaybookReviewResult } from "../types/review";
import type { InboxItem } from "../types/inboxItems";
import type { ContractRequest } from "../types/requests";

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const MOCK_NDA_ID = "00000000-0000-4000-8000-000000000001";
export const MOCK_MSA_ID = "00000000-0000-4000-8000-000000000002";
export const MOCK_SIGNATURE_OUT_ID = "00000000-0000-4000-8000-000000000004";
export const MOCK_EXECUTED_ID = "00000000-0000-4000-8000-000000000005";
export const MOCK_MERGED_ID = "00000000-0000-4000-8000-000000000006";
export const MOCK_REDLINE_ID = "00000000-0000-4000-8000-000000000007";
export const MOCK_FAILED_ID = "00000000-0000-4000-8000-000000000003";

const MUTUAL_NDA_TEXT = `MUTUAL NON-DISCLOSURE AGREEMENT

This Mutual Non-Disclosure Agreement (the "Agreement") is entered into as of January 15, 2026 (the "Effective Date") by and between Acme Corporation, a Delaware corporation with its principal place of business at 100 Example Street, Wilmington, Delaware ("Acme"), and Globex Industries, Inc., a Nevada corporation with its principal place of business at 200 Sample Avenue, Reno, Nevada ("Globex"). Acme and Globex are sometimes referred to herein individually as a "Party" and collectively as the "Parties".

1. Purpose. The Parties wish to explore a potential business relationship and, in connection with such discussions, may exchange certain non-public information ("Confidential Information") that each Party desires to protect from unauthorized use or disclosure.

2. Term. This Agreement shall remain in effect for a period of twenty-four (24) months from the Effective Date, unless earlier terminated as provided herein. The obligations of confidentiality set forth in Section 3 shall survive any expiration or termination of this Agreement for an additional period of three (3) years.

3. Confidentiality Obligations. Each Party agrees to (a) hold the other Party's Confidential Information in strict confidence, (b) use such Confidential Information solely for the Purpose, and (c) not disclose such Confidential Information to any third party without the prior written consent of the disclosing Party.

4. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles. Any disputes arising under this Agreement shall be resolved in the state or federal courts located in Wilmington, Delaware.

5. Termination. Either Party may terminate this Agreement at any time upon thirty (30) days' prior written notice to the other Party. Upon termination, each Party shall promptly return or destroy all Confidential Information received from the other Party.

IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.`;

function span(text: string, needle: string): { start: number; end: number } {
  const start = text.indexOf(needle);
  if (start < 0) {
    throw new Error(`mockData: substring not found: ${needle}`);
  }
  return { start, end: start + needle.length };
}

const partiesSpan = span(MUTUAL_NDA_TEXT, "Acme Corporation");
const effectiveDateSpan = span(MUTUAL_NDA_TEXT, "January 15, 2026");
const termSpan = span(MUTUAL_NDA_TEXT, "twenty-four (24) months");
const governingLawSpan = span(MUTUAL_NDA_TEXT, "State of Delaware");
const terminationSpan = span(
  MUTUAL_NDA_TEXT,
  "Either Party may terminate this Agreement at any time upon thirty (30) days' prior written notice",
);
const survivalSpan = span(MUTUAL_NDA_TEXT, "additional period of three (3) years");

const NDA_FIELDS: ExtractedField[] = [
  {
    field_name: "parties",
    value_json: ["Acme Corporation", "Globex Industries, Inc."],
    span_start: partiesSpan.start,
    span_end: partiesSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(partiesSpan.start, partiesSpan.end),
    confidence: 0.94,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: "2026-01-15T10:30:00Z",
  },
  {
    field_name: "effective_date",
    value_json: "2026-01-15",
    span_start: effectiveDateSpan.start,
    span_end: effectiveDateSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(
      effectiveDateSpan.start,
      effectiveDateSpan.end,
    ),
    confidence: 0.98,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: "2026-01-15T10:30:00Z",
  },
  {
    field_name: "term_months",
    value_json: 24,
    span_start: termSpan.start,
    span_end: termSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(termSpan.start, termSpan.end),
    confidence: 0.86,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: "2026-01-15T10:30:00Z",
  },
  {
    field_name: "governing_law",
    value_json: "Delaware",
    span_start: governingLawSpan.start,
    span_end: governingLawSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(
      governingLawSpan.start,
      governingLawSpan.end,
    ),
    confidence: 0.91,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: "2026-01-15T10:30:00Z",
  },
  {
    field_name: "termination_provisions",
    value_json: "Either party may terminate on 30 days' written notice.",
    span_start: terminationSpan.start,
    span_end: terminationSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(terminationSpan.start, terminationSpan.end),
    confidence: 0.72,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: "2026-01-15T10:30:00Z",
  },
  {
    field_name: "confidentiality_survival",
    value_json: "3 years post-termination",
    span_start: survivalSpan.start,
    span_end: survivalSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(survivalSpan.start, survivalSpan.end),
    confidence: 0.45,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: "2026-01-15T10:30:00Z",
  },
];

export const MOCK_LIST: ContractListItem[] = [
  {
    id: MOCK_NDA_ID,
    title: "Mutual NDA generated agreement — Acme & Globex (sample)",
    status: "ready",
    mime_type: PDF_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000001",
    page_count: 2,
    created_at: "2026-01-15T10:30:00Z",
    updated_at: "2026-01-15T10:32:14Z",
    counterparty: "Globex Corporation",
    effective_date: "2026-01-15",
    renewal_date: "2027-01-15",
    auto_renew: true,
    owner_user_id: "user-rachel",
    owner_display_name: "Rachel Vega",
  },
  {
    id: MOCK_MSA_ID,
    title: "Mutual NDA draft source — Acme (sample)",
    status: "uploaded",
    mime_type: DOCX_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000002",
    page_count: 14,
    created_at: "2026-02-03T08:14:51Z",
    updated_at: "2026-02-03T08:15:02Z",
    counterparty: null,
    effective_date: null,
    renewal_date: null,
    auto_renew: null,
    owner_user_id: "user-rachel",
    owner_display_name: "Rachel Vega",
  },
  {
    id: MOCK_SIGNATURE_OUT_ID,
    title: "Mutual NDA — out for signature (sample)",
    status: "sent_for_signature",
    mime_type: PDF_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000004",
    page_count: 3,
    created_at: "2026-02-15T09:00:00Z",
    updated_at: "2026-02-16T12:20:00Z",
    counterparty: "Initech LLC",
    effective_date: "2026-03-01",
    renewal_date: "2026-06-01",
    auto_renew: false,
    owner_user_id: "user-priya",
    owner_display_name: "Priya Shah",
  },
  {
    id: MOCK_EXECUTED_ID,
    title: "Mutual NDA — executed with signed PDF (sample)",
    status: "executed",
    mime_type: PDF_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000005",
    page_count: 3,
    created_at: "2026-02-01T09:30:00Z",
    updated_at: "2026-02-20T18:45:00Z",
    counterparty: "Stark Industries",
    effective_date: "2026-02-20",
    renewal_date: "2026-08-01",
    auto_renew: true,
    owner_user_id: "user-mateo",
    owner_display_name: "Mateo Ruiz",
  },
  {
    id: MOCK_MERGED_ID,
    title: "NDA — Acme duplicate scan (merged sample)",
    status: "ready",
    mime_type: PDF_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000006",
    page_count: 2,
    created_at: "2026-01-20T11:11:00Z",
    updated_at: "2026-01-22T11:11:00Z",
    merged_into_contract_id: MOCK_NDA_ID,
    merged_at: "2026-01-22T11:11:00Z",
    counterparty: "Globex Corporation",
    effective_date: "2026-01-15",
    renewal_date: "2027-01-15",
    auto_renew: true,
    owner_user_id: "user-rachel",
    owner_display_name: "Rachel Vega",
  },
  {
    id: MOCK_REDLINE_ID,
    title: "Mutual NDA negotiation draft — redline history (sample)",
    status: "ready",
    mime_type: DOCX_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000007",
    page_count: 4,
    created_at: "2026-02-05T10:00:00Z",
    updated_at: "2026-02-06T10:00:00Z",
    counterparty: "Wayne Enterprises",
    effective_date: "2026-04-01",
    renewal_date: null,
    auto_renew: null,
    owner_user_id: "user-priya",
    owner_display_name: "Priya Shah",
  },
  {
    id: MOCK_FAILED_ID,
    title: "Vendor SOW — Hooli (sample, extraction failed)",
    status: "failed",
    mime_type: PDF_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000003",
    page_count: 5,
    created_at: "2026-02-10T17:02:33Z",
    updated_at: "2026-02-10T17:02:55Z",
    counterparty: null,
    effective_date: null,
    renewal_date: null,
    auto_renew: null,
    owner_user_id: null,
    owner_display_name: null,
  },
];

/**
 * Sample clauses for the NDA mock contract. Each entry's `text` is a
 * verbatim slice of `MUTUAL_NDA_TEXT` — never paraphrased — so the
 * highlight pipeline can find them. `mockApi.test.ts` re-asserts this.
 */
const NDA_CLAUSES: Clause[] = (() => {
  const ndaContractId = MOCK_NDA_ID;
  type ClauseSeed = {
    heading: string;
    spanText: string;
    clause_type: string | null;
  };
  const seeds: ClauseSeed[] = [
    {
      heading: "Title and Recitals",
      spanText:
        'MUTUAL NON-DISCLOSURE AGREEMENT\n\nThis Mutual Non-Disclosure Agreement (the "Agreement") is entered into as of January 15, 2026 (the "Effective Date") by and between Acme Corporation, a Delaware corporation with its principal place of business at 100 Example Street, Wilmington, Delaware ("Acme"), and Globex Industries, Inc., a Nevada corporation with its principal place of business at 200 Sample Avenue, Reno, Nevada ("Globex"). Acme and Globex are sometimes referred to herein individually as a "Party" and collectively as the "Parties".',
      clause_type: "recitals",
    },
    {
      heading: "1. Purpose",
      spanText:
        '1. Purpose. The Parties wish to explore a potential business relationship and, in connection with such discussions, may exchange certain non-public information ("Confidential Information") that each Party desires to protect from unauthorized use or disclosure.',
      clause_type: "confidentiality",
    },
    {
      heading: "2. Term",
      spanText:
        "2. Term. This Agreement shall remain in effect for a period of twenty-four (24) months from the Effective Date, unless earlier terminated as provided herein. The obligations of confidentiality set forth in Section 3 shall survive any expiration or termination of this Agreement for an additional period of three (3) years.",
      clause_type: "term",
    },
    {
      heading: "3. Confidentiality Obligations",
      spanText:
        "3. Confidentiality Obligations. Each Party agrees to (a) hold the other Party's Confidential Information in strict confidence, (b) use such Confidential Information solely for the Purpose, and (c) not disclose such Confidential Information to any third party without the prior written consent of the disclosing Party.",
      clause_type: "confidentiality",
    },
    {
      heading: "4. Governing Law",
      spanText:
        "4. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles. Any disputes arising under this Agreement shall be resolved in the state or federal courts located in Wilmington, Delaware.",
      clause_type: "governing_law",
    },
    {
      heading: "5. Termination",
      spanText:
        "5. Termination. Either Party may terminate this Agreement at any time upon thirty (30) days' prior written notice to the other Party. Upon termination, each Party shall promptly return or destroy all Confidential Information received from the other Party.",
      clause_type: "termination",
    },
    {
      heading: "Signature block",
      spanText:
        "IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.",
      clause_type: "signature",
    },
  ];
  return seeds.map((seed, index) => {
    const offset = MUTUAL_NDA_TEXT.indexOf(seed.spanText);
    if (offset < 0) {
      throw new Error(`mockData: clause span not found for "${seed.heading}"`);
    }
    return {
      id: `00000000-0000-4000-8000-0000000010${String(index).padStart(2, "0")}`,
      contract_id: ndaContractId,
      ordinal: index,
      heading: seed.heading,
      clause_type: seed.clause_type,
      clause_type_source: seed.clause_type ? "heuristic" : null,
      text: seed.spanText,
      span_start: offset,
      span_end: offset + seed.spanText.length,
      confidence: null,
      segmentation_method: "heuristic_v1",
      model_name: null,
      prompt_version: null,
    } satisfies Clause;
  });
})();

export const MOCK_DETAIL_BY_ID: Record<string, ContractDetail> = {
  [MOCK_NDA_ID]: {
    ...MOCK_LIST[0],
    full_text: MUTUAL_NDA_TEXT,
    extracted_fields: NDA_FIELDS,
    clauses: NDA_CLAUSES,
  },
  [MOCK_MSA_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_MSA_ID)!,
    full_text:
      "Master Services Agreement (sample). Extraction is still in progress in this demo; metadata fields will appear here once it completes.",
    extracted_fields: [],
    clauses: [],
  },
    [MOCK_SIGNATURE_OUT_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_SIGNATURE_OUT_ID)!,
    full_text:
      "NDA signature packet sent to both parties. Awaiting counterparty signature in this demo record.",
    extracted_fields: [],
    clauses: [],
  },
  [MOCK_EXECUTED_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_EXECUTED_ID)!,
    full_text:
      "Executed NDA with signed PDF finalized. This demo record represents post-signature storage.",
    extracted_fields: [],
    clauses: [],
  },
  [MOCK_MERGED_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_MERGED_ID)!,
    full_text:
      "Duplicate NDA copy merged into canonical record. Hidden by default unless Show merged is enabled.",
    extracted_fields: [],
    clauses: [],
  },
  [MOCK_REDLINE_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_REDLINE_ID)!,
    full_text:
      "NDA negotiation draft with redline history entries available in Document History.",
    extracted_fields: [],
    clauses: [],
  },
[MOCK_FAILED_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_FAILED_ID)!,
    full_text:
      "Vendor SOW (sample). Extraction failed in this demo to illustrate the UI for that state. The original file would still be downloadable.",
    extracted_fields: [],
    clauses: [],
  },
};

export const MOCK_NDA_FULL_TEXT = MUTUAL_NDA_TEXT;
export const MOCK_NDA_CLAUSES = NDA_CLAUSES;

// --------------------------------------------------------------------------
// Markdown working snapshots (demo mode)
//
// PR #32 added the snapshot pipeline server-side. PR #33 surfaces them
// in the contract workspace as the default fast preview. The NDA gets
// a hand-authored Markdown rendering; the MSA shows the warning path
// where conversion fell back to plain text; the failed-upload demo
// case has no snapshot at all so the empty state is exercised.
// --------------------------------------------------------------------------

const MOCK_NDA_MARKDOWN = `# Mutual Non-Disclosure Agreement

**Parties:** Acme Corporation ("Acme") and Globex Industries, Inc. ("Globex").
**Effective Date:** January 15, 2026.

## 1. Purpose

The Parties wish to explore a potential business relationship and, in
connection with such discussions, may exchange certain non-public
information ("Confidential Information") that each Party desires to
protect from unauthorized use or disclosure.

## 2. Term

This Agreement shall remain in effect for a period of **twenty-four
(24) months** from the Effective Date, unless earlier terminated as
provided herein. The obligations of confidentiality survive for an
additional **three (3) years**.

## 3. Confidentiality Obligations

Each Party agrees to:

- hold the other Party's Confidential Information in strict confidence;
- use such Confidential Information solely for the Purpose;
- not disclose such Confidential Information to any third party
  without the prior written consent of the disclosing Party.

## 4. Governing Law

This Agreement shall be governed by and construed in accordance with
the laws of the **State of Delaware**.

---

*This is a demo text preview. The original PDF remains the official
source file.*
`;

export const MOCK_MARKDOWN_BY_CONTRACT_ID: Record<
  string,
  ContractMarkdownSnapshot | null
> = {
  [MOCK_NDA_ID]: {
    id: "00000000-0000-4000-8000-0000000020a1",
    contract_id: MOCK_NDA_ID,
    markdown_text: MOCK_NDA_MARKDOWN,
    source_kind: "original_upload",
    converter_name: "markitdown",
    converter_version: "0.0.1-demo",
    conversion_status: "ready",
    conversion_warnings: null,
    created_at: "2026-01-15T10:31:42Z",
  },
  [MOCK_MSA_ID]: {
    id: "00000000-0000-4000-8000-0000000020a2",
    contract_id: MOCK_MSA_ID,
    markdown_text:
      "Master Services Agreement (sample). Extraction is still in progress in this demo; metadata fields will appear here once it completes.\n",
    source_kind: "original_upload",
    converter_name: "fallback_plain_text",
    converter_version: null,
    conversion_status: "ready",
    conversion_warnings: ["markitdown_empty_output"],
    created_at: "2026-02-03T08:14:55Z",
  },
  // Failed-upload demo intentionally has no snapshot so the empty
  // state is exercised when the user opens it.
  [MOCK_FAILED_ID]: null,
};

// --------------------------------------------------------------------------
// Playbooks (demo mode)
//
// One published example playbook plus a deactivated one, so the UI can
// exercise both states. The YAML matches the v1 schema in
// `backend/app/services/playbook_loader.py`. These are fictional review
// rules for demonstration only — not legal advice.
// --------------------------------------------------------------------------

export const MOCK_NDA_PLAYBOOK_ID = "00000000-0000-4000-8000-000000000101";
export const MOCK_DEACTIVATED_PLAYBOOK_ID =
  "00000000-0000-4000-8000-000000000102";

const MUTUAL_NDA_PREFERRED_GOVERNING_LAW = `This Agreement shall be governed by and construed in accordance with the laws of the State of California, without regard to its conflict of laws principles. Any disputes arising under this Agreement shall be resolved in the state or federal courts located in San Francisco, California.`;

const MUTUAL_NDA_PLAYBOOK_YAML = `name: "Mutual NDA Review Playbook (sample)"
description: "Baseline review rules for mutual NDAs. Example only — not legal advice."
version: "1.0"
jurisdiction: "California"
contract_type: "mutual_nda"

rules:
  - id: "confidentiality-definition-required"
    title: "Confidential Information definition should be present"
    clause_type: "confidentiality"
    severity: "high"
    rule_type: "required_clause"
    description: "The agreement should define confidential information."
    guidance: "Look for a clause defining what information is protected."
  - id: "governing-law-california"
    title: "Governing law should be California"
    clause_type: "governing_law"
    severity: "medium"
    rule_type: "preferred_value"
    expected_value: "California"
    guidance: "We require California governing law for mutual NDAs originating in our California office. Substitute the firm-preferred clause below verbatim."
    preferred_language: |
      ${MUTUAL_NDA_PREFERRED_GOVERNING_LAW}
  - id: "assignment-consent-required"
    title: "Assignment should require consent"
    clause_type: "assignment"
    severity: "medium"
    rule_type: "text_contains"
    required_terms:
      - "consent"
      - "prior written consent"
    guidance: "Assignment without prior written consent is unacceptable. If the contract is silent on assignment, request the firm-preferred clause."
`;

const MUTUAL_NDA_RULES: PlaybookRuleSummary[] = [
  {
    id: "confidentiality-definition-required",
    title: "Confidential Information definition should be present",
    rule_type: "required_clause",
    clause_type: "confidentiality",
    severity: "high",
  },
  {
    id: "governing-law-california",
    title: "Governing law should be California",
    rule_type: "preferred_value",
    clause_type: "governing_law",
    severity: "medium",
  },
  {
    id: "assignment-consent-required",
    title: "Assignment should require consent",
    rule_type: "text_contains",
    clause_type: "assignment",
    severity: "medium",
  },
];

const MUTUAL_NDA_GOVERNING_LAW_GUIDANCE =
  "We require California governing law for mutual NDAs originating in our California office. Substitute the firm-preferred clause below verbatim.";

const MUTUAL_NDA_ASSIGNMENT_GUIDANCE =
  "Assignment without prior written consent is unacceptable. If the contract is silent on assignment, request the firm-preferred clause.";

const MUTUAL_NDA_PARSED_RULES: Record<string, unknown> = {
  name: "Mutual NDA Review Playbook (sample)",
  description:
    "Baseline review rules for mutual NDAs. Example only — not legal advice.",
  version: "1.0",
  jurisdiction: "California",
  contract_type: "mutual_nda",
  rules: [
    {
      id: "confidentiality-definition-required",
      title: "Confidential Information definition should be present",
      clause_type: "confidentiality",
      severity: "high",
      rule_type: "required_clause",
      description: "The agreement should define confidential information.",
      guidance: "Look for a clause defining what information is protected.",
      preferred_language: null,
    },
    {
      id: "governing-law-california",
      title: "Governing law should be California",
      clause_type: "governing_law",
      severity: "medium",
      rule_type: "preferred_value",
      expected_value: "California",
      description: null,
      guidance: MUTUAL_NDA_GOVERNING_LAW_GUIDANCE,
      preferred_language: MUTUAL_NDA_PREFERRED_GOVERNING_LAW,
    },
    {
      id: "assignment-consent-required",
      title: "Assignment should require consent",
      clause_type: "assignment",
      severity: "medium",
      rule_type: "text_contains",
      required_terms: ["consent", "prior written consent"],
      description: null,
      guidance: MUTUAL_NDA_ASSIGNMENT_GUIDANCE,
      preferred_language: null,
    },
  ],
};

const MUTUAL_NDA_PLAYBOOK_DETAIL: PlaybookDetail = {
  id: MOCK_NDA_PLAYBOOK_ID,
  name: "Mutual NDA Review Playbook (sample)",
  description:
    "Baseline review rules for mutual NDAs. Example only — not legal advice.",
  jurisdiction: "California",
  contract_type: "mutual_nda",
  version: "1.0",
  is_active: true,
  rule_count: MUTUAL_NDA_RULES.length,
  created_at: "2026-01-15T10:30:00Z",
  updated_at: "2026-01-15T10:30:00Z",
  yaml_source: MUTUAL_NDA_PLAYBOOK_YAML,
  parsed_rules: MUTUAL_NDA_PARSED_RULES,
  rules: MUTUAL_NDA_RULES,
};

const DEACTIVATED_PLAYBOOK_DETAIL: PlaybookDetail = {
  id: MOCK_DEACTIVATED_PLAYBOOK_ID,
  name: "Vendor MSA Playbook (sample, deactivated)",
  description: "An older revision of the vendor MSA playbook.",
  jurisdiction: null,
  contract_type: "vendor_msa",
  version: "0.9",
  is_active: false,
  rule_count: 0,
  created_at: "2025-12-01T09:00:00Z",
  updated_at: "2026-01-10T17:00:00Z",
  yaml_source: 'name: "Vendor MSA Playbook (sample, deactivated)"\nrules: []\n',
  parsed_rules: {
    name: "Vendor MSA Playbook (sample, deactivated)",
    rules: [],
  },
  rules: [],
};

export const MOCK_PLAYBOOK_LIST: PlaybookSummary[] = [
  {
    id: MUTUAL_NDA_PLAYBOOK_DETAIL.id,
    name: MUTUAL_NDA_PLAYBOOK_DETAIL.name,
    description: MUTUAL_NDA_PLAYBOOK_DETAIL.description,
    jurisdiction: MUTUAL_NDA_PLAYBOOK_DETAIL.jurisdiction,
    contract_type: MUTUAL_NDA_PLAYBOOK_DETAIL.contract_type,
    version: MUTUAL_NDA_PLAYBOOK_DETAIL.version,
    is_active: MUTUAL_NDA_PLAYBOOK_DETAIL.is_active,
    rule_count: MUTUAL_NDA_PLAYBOOK_DETAIL.rule_count,
    created_at: MUTUAL_NDA_PLAYBOOK_DETAIL.created_at,
    updated_at: MUTUAL_NDA_PLAYBOOK_DETAIL.updated_at,
  },
  {
    id: DEACTIVATED_PLAYBOOK_DETAIL.id,
    name: DEACTIVATED_PLAYBOOK_DETAIL.name,
    description: DEACTIVATED_PLAYBOOK_DETAIL.description,
    jurisdiction: DEACTIVATED_PLAYBOOK_DETAIL.jurisdiction,
    contract_type: DEACTIVATED_PLAYBOOK_DETAIL.contract_type,
    version: DEACTIVATED_PLAYBOOK_DETAIL.version,
    is_active: DEACTIVATED_PLAYBOOK_DETAIL.is_active,
    rule_count: DEACTIVATED_PLAYBOOK_DETAIL.rule_count,
    created_at: DEACTIVATED_PLAYBOOK_DETAIL.created_at,
    updated_at: DEACTIVATED_PLAYBOOK_DETAIL.updated_at,
  },
];

export const MOCK_PLAYBOOK_DETAIL_BY_ID: Record<string, PlaybookDetail> = {
  [MOCK_NDA_PLAYBOOK_ID]: MUTUAL_NDA_PLAYBOOK_DETAIL,
  [MOCK_DEACTIVATED_PLAYBOOK_ID]: DEACTIVATED_PLAYBOOK_DETAIL,
};

// --------------------------------------------------------------------------
// Playbook review (demo mode)
//
// Hardcoded review of the sample NDA against the sample mutual-NDA
// playbook. The intent is to exercise both pass and fail rendering and
// the evidence-highlight wiring. Computed manually so the result stays
// deterministic and obvious; real backends recompute this every call.
// --------------------------------------------------------------------------

const _confidentialityEvidence = NDA_CLAUSES.find(
  (c) => c.heading === "1. Purpose",
);
const _governingLawEvidence = NDA_CLAUSES.find(
  (c) => c.heading === "4. Governing Law",
);

if (!_confidentialityEvidence || !_governingLawEvidence) {
  throw new Error("mockData: expected sample clauses missing for review");
}

const NDA_VS_NDA_PLAYBOOK_REVIEW: PlaybookReviewResult = {
  playbook_id: MOCK_NDA_PLAYBOOK_ID,
  playbook_name: MUTUAL_NDA_PLAYBOOK_DETAIL.name,
  contract_id: MOCK_NDA_ID,
  rules_checked: 3,
  passed_count: 1,
  failed_count: 2,
  results: [
    {
      rule_id: "confidentiality-definition-required",
      title: "Confidential Information definition should be present",
      rule_type: "required_clause",
      clause_type: "confidentiality",
      severity: "high",
      status: "pass",
      message: `A 'confidentiality' clause is present (clause #${
        _confidentialityEvidence.ordinal + 1
      }).`,
      clause_id: _confidentialityEvidence.id,
      clause_ordinal: _confidentialityEvidence.ordinal,
      clause_heading: _confidentialityEvidence.heading,
      evidence_text: _confidentialityEvidence.text,
      span_start: _confidentialityEvidence.span_start,
      span_end: _confidentialityEvidence.span_end,
      matched_terms: [],
      expected_value: null,
      description: "The agreement should define confidential information.",
      guidance: "Look for a clause defining what information is protected.",
      preferred_language: null,
    },
    {
      rule_id: "governing-law-california",
      title: "Governing law should be California",
      rule_type: "preferred_value",
      clause_type: "governing_law",
      severity: "medium",
      status: "fail",
      message:
        "Preferred value 'California' not found in any 'governing_law' clause.",
      clause_id: _governingLawEvidence.id,
      clause_ordinal: _governingLawEvidence.ordinal,
      clause_heading: _governingLawEvidence.heading,
      evidence_text: _governingLawEvidence.text,
      span_start: _governingLawEvidence.span_start,
      span_end: _governingLawEvidence.span_end,
      matched_terms: [],
      expected_value: "California",
      description: null,
      guidance: MUTUAL_NDA_GOVERNING_LAW_GUIDANCE,
      preferred_language: MUTUAL_NDA_PREFERRED_GOVERNING_LAW,
    },
    {
      rule_id: "assignment-consent-required",
      title: "Assignment should require consent",
      rule_type: "text_contains",
      clause_type: "assignment",
      severity: "medium",
      status: "fail",
      message:
        "No clause of type 'assignment' was found in the contract; cannot evaluate required terms.",
      clause_id: null,
      clause_ordinal: null,
      clause_heading: null,
      evidence_text: null,
      span_start: null,
      span_end: null,
      matched_terms: [],
      expected_value: null,
      description: null,
      guidance: MUTUAL_NDA_ASSIGNMENT_GUIDANCE,
      preferred_language: null,
    },
  ],
};

export const MOCK_REVIEW_BY_KEY: Record<string, PlaybookReviewResult> = {
  [`${MOCK_NDA_ID}|${MOCK_NDA_PLAYBOOK_ID}`]: NDA_VS_NDA_PLAYBOOK_REVIEW,
};

// ---------------------------------------------------------------------------
// Requests + Inbox (PR #47 — demo seed)
//
// Hand-rolled sample data so empty / filter / dismissed-state behavior can
// be exercised in demo mode without making the user create their own.
// All counterparties are fictional.
// ---------------------------------------------------------------------------

export const MOCK_DEMO_ORG_ID = "00000000-0000-4000-8000-000000000010";

export const MOCK_REQUEST_OPEN_ID = "00000000-0000-4000-8000-0000000000a1";
export const MOCK_REQUEST_LINKED_ID = "00000000-0000-4000-8000-0000000000a2";
export const MOCK_REQUEST_BLOCKED_ID = "00000000-0000-4000-8000-0000000000a3";

// Pinned for the demo so the request -> contract conversion flow
// has a wired-up template to point at. Mirrors the NDA template id in
// `mockApi.ts`. The seed kept zero linked-templates before PR #48; the
// open NDA is the natural place to hook the conversion form.
const MOCK_DEMO_NDA_TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

export const MOCK_REQUESTS: ContractRequest[] = [
  {
    id: MOCK_REQUEST_OPEN_ID,
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Open NDA intake — Acme expansion",
    description:
      "Initial request intake. Start from the NDA template before sharing roadmap materials.",
    request_type: "new_contract",
    contract_type: "NDA",
    status: "open",
    priority: "normal",
    requester_name: "Devon Reyes",
    requester_email: "devon@example.com",
    counterparty_name: "Acme Corp",
    due_date: "2026-05-20",
    assigned_to: null,
    linked_contract_id: null,
    linked_template_id: MOCK_DEMO_NDA_TEMPLATE_ID,
    created_at: "2026-05-08T16:00:00Z",
    updated_at: "2026-05-08T16:00:00Z",
    created_by: null,
    metadata_json: null,
  },
  {
    id: MOCK_REQUEST_LINKED_ID,
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Generated NDA linked to Repository",
    description:
      "Agreement was generated from the NDA template and is now tracked in the Repository.",
    request_type: "new_contract",
    contract_type: "NDA",
    status: "in_progress",
    priority: "high",
    requester_name: "Procurement",
    requester_email: null,
    counterparty_name: "Globex Industries",
    due_date: "2026-05-16",
    assigned_to: null,
    linked_contract_id: MOCK_NDA_ID,
    linked_template_id: MOCK_DEMO_NDA_TEMPLATE_ID,
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-08T11:30:00Z",
    created_by: null,
    metadata_json: null,
  },
  {
    id: MOCK_REQUEST_BLOCKED_ID,
    organization_id: MOCK_DEMO_ORG_ID,
    title: "NDA blocked pending approval",
    description:
      "Generated agreement is waiting on legal and finance approval before signature can proceed.",
    request_type: "new_contract",
    contract_type: "NDA",
    status: "blocked",
    priority: "high",
    requester_name: "Privacy team",
    requester_email: null,
    counterparty_name: "Acme Corp",
    due_date: "2026-05-14",
    assigned_to: null,
    linked_contract_id: MOCK_SIGNATURE_OUT_ID,
    linked_template_id: MOCK_DEMO_NDA_TEMPLATE_ID,
    created_at: "2026-05-02T09:00:00Z",
    updated_at: "2026-05-09T14:00:00Z",
    created_by: null,
    metadata_json: null,
  },
];

export const MOCK_INBOX_ITEMS: InboxItem[] = [
  {
    id: "00000000-0000-4000-8000-0000000000b1",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Review request: Open NDA intake — Acme expansion",
    description: null,
    item_type: "request_review",
    status: "open",
    priority: "normal",
    assigned_to: null,
    due_date: "2026-05-20",
    request_id: MOCK_REQUEST_OPEN_ID,
    contract_id: null,
    template_id: null,
    created_at: "2026-05-08T16:00:00Z",
    updated_at: "2026-05-08T16:00:00Z",
    created_by: null,
    metadata_json: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000b2",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Follow up on Acme signature packet",
    description:
      "Packet is out for signature. Follow up with the counterparty if it stalls again.",
    item_type: "signature_followup",
    status: "open",
    priority: "high",
    assigned_to: null,
    due_date: "2026-05-15",
    request_id: null,
    contract_id: MOCK_SIGNATURE_OUT_ID,
    template_id: null,
    created_at: "2026-05-05T12:00:00Z",
    updated_at: "2026-05-05T12:00:00Z",
    created_by: null,
    metadata_json: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000b3",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Triage Q2 NDA backlog",
    description: null,
    item_type: "general",
    status: "blocked",
    priority: "low",
    assigned_to: null,
    due_date: null,
    request_id: null,
    contract_id: null,
    template_id: null,
    created_at: "2026-04-20T09:00:00Z",
    updated_at: "2026-04-25T16:00:00Z",
    created_by: null,
    metadata_json: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000b4",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Confirm counterparty entity name",
    description:
      "Dismissed: counterparty resolved by paralegal in offline thread.",
    item_type: "metadata_cleanup",
    status: "dismissed",
    priority: null,
    assigned_to: null,
    due_date: null,
    request_id: null,
    contract_id: null,
    template_id: null,
    created_at: "2026-04-15T09:00:00Z",
    updated_at: "2026-04-16T09:00:00Z",
    created_by: null,
    metadata_json: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000b7",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "New upload intake: Vendor MSA draft",
    description:
      "New file arrived in intake and is ready to classify in Repository settings.",
    item_type: "contract_review",
    status: "open",
    priority: "normal",
    assigned_to: null,
    due_date: "2026-05-18",
    request_id: null,
    contract_id: null,
    template_id: null,
    created_at: "2026-05-10T09:30:00Z",
    updated_at: "2026-05-10T09:30:00Z",
    created_by: null,
    metadata_json: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000b8",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Send for review: Security addendum intake",
    description:
      "Route this intake item into Requests so legal can collect supporting information.",
    item_type: "general",
    status: "open",
    priority: "normal",
    assigned_to: null,
    due_date: "2026-05-19",
    request_id: null,
    contract_id: null,
    template_id: null,
    created_at: "2026-05-10T11:00:00Z",
    updated_at: "2026-05-10T11:00:00Z",
    created_by: null,
    metadata_json: null,
  },
  // PR #79 — Seeded approval inbox items so the Approval Tasks view has
  // realistic content in demo mode. Mirror the demo workflow runs in
  // `_buildDemoApprovalRuns()` (see mockApi.ts).
  {
    id: "00000000-0000-4000-8000-0000000000b5",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Legal review — NDA blocked pending approval",
    description: "Current approval step for the blocked NDA request.",
    item_type: "approval",
    status: "open",
    priority: "high",
    assigned_to: "demo-user-alice",
    due_date: "2026-05-07",
    request_id: MOCK_REQUEST_BLOCKED_ID,
    contract_id: MOCK_SIGNATURE_OUT_ID,
    template_id: null,
    created_at: "2026-05-08T12:00:00Z",
    updated_at: "2026-05-08T12:00:00Z",
    created_by: null,
    metadata_json: {
      workflow_run_id: "demo-run-active",
      approval_step_id: "demo-step-active-1",
    },
  },
  {
    id: "00000000-0000-4000-8000-0000000000b6",
    organization_id: MOCK_DEMO_ORG_ID,
    title: "Finance sign-off — generated NDA",
    description: "Completed approval task from the earlier generated NDA workflow.",
    item_type: "approval",
    status: "completed",
    priority: "normal",
    assigned_to: "demo-user-bob",
    due_date: "2026-05-06",
    request_id: MOCK_REQUEST_LINKED_ID,
    contract_id: MOCK_NDA_ID,
    template_id: null,
    created_at: "2026-05-05T08:00:00Z",
    updated_at: "2026-05-06T08:30:00Z",
    created_by: null,
    metadata_json: {
      workflow_run_id: "demo-run-completed",
      approval_step_id: "demo-step-completed-2",
    },
  },
];

export const MOCK_APPROVAL_POLICIES = [
  {
    id: "apol-nda-legal-review",
    organization_id: MOCK_DEMO_ORG_ID,
    name: "NDA Legal Review policy",
    description: "Route NDA requests to legal workflow.",
    status: "active",
    workflow_template_id: "wftpl-legal-review",
    request_type: "new_agreement",
    contract_type: "nda",
    priority: null,
    agreement_template_id: null,
    auto_attach: true,
    applies_to_generated_contracts: true,
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
    metadata_json: null,
  },
  {
    id: "apol-high-priority-exec",
    organization_id: MOCK_DEMO_ORG_ID,
    name: "High Priority Executive Approval policy",
    description: "Require executive review for high-priority requests.",
    status: "active",
    workflow_template_id: "wftpl-exec-approval",
    request_type: null,
    contract_type: null,
    priority: "high",
    agreement_template_id: null,
    auto_attach: true,
    applies_to_generated_contracts: true,
    created_at: "2026-04-02T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
    metadata_json: null,
  },
  {
    id: "apol-archived-sample",
    organization_id: MOCK_DEMO_ORG_ID,
    name: "Archived Sample Policy",
    description: "Archived demo policy",
    status: "archived",
    workflow_template_id: "wftpl-legacy",
    request_type: null,
    contract_type: null,
    priority: null,
    agreement_template_id: null,
    auto_attach: true,
    applies_to_generated_contracts: true,
    created_at: "2026-03-01T10:00:00Z",
    updated_at: "2026-03-15T10:00:00Z",
    metadata_json: null,
  },
];
