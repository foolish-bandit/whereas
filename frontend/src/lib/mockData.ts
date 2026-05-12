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

/**
 * Build a hand-tagged ExtractedField for a demo contract. The needle
 * is anchored against `text` at runtime so we never ship stale offsets.
 */
function tag(
  text: string,
  spec: {
    field_name: string;
    value_json: unknown;
    needle: string;
    confidence: number;
    extracted_at: string;
  },
): ExtractedField {
  const s = span(text, spec.needle);
  return {
    field_name: spec.field_name,
    value_json: spec.value_json,
    span_start: s.start,
    span_end: s.end,
    span_text: text.slice(s.start, s.end),
    confidence: spec.confidence,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: spec.extracted_at,
  };
}

const partiesSpan = span(
  MUTUAL_NDA_TEXT,
  "Acme Corporation, a Delaware corporation",
);
const counterpartyNdaSpan = span(MUTUAL_NDA_TEXT, "Globex Industries, Inc.");
const effectiveDateSpan = span(MUTUAL_NDA_TEXT, "January 15, 2026");
const termSpan = span(MUTUAL_NDA_TEXT, "twenty-four (24) months");
const governingLawSpan = span(MUTUAL_NDA_TEXT, "State of Delaware");
const terminationNoticeNdaSpan = span(
  MUTUAL_NDA_TEXT,
  "thirty (30) days' prior written notice",
);
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
    field_name: "counterparty",
    value_json: "Globex Industries, Inc.",
    span_start: counterpartyNdaSpan.start,
    span_end: counterpartyNdaSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(
      counterpartyNdaSpan.start,
      counterpartyNdaSpan.end,
    ),
    confidence: 0.92,
    model_name: "demo-extractor",
    prompt_version: "v0.demo",
    extracted_at: "2026-01-15T10:30:00Z",
  },
  {
    field_name: "termination_notice_period",
    value_json: "30 days",
    span_start: terminationNoticeNdaSpan.start,
    span_end: terminationNoticeNdaSpan.end,
    span_text: MUTUAL_NDA_TEXT.slice(
      terminationNoticeNdaSpan.start,
      terminationNoticeNdaSpan.end,
    ),
    confidence: 0.88,
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

// --------------------------------------------------------------------------
// Hand-tagged demo content for the other five Repository samples. The
// Failed contract intentionally keeps an empty fields list — its
// reason-for-being in the demo is to illustrate the "extraction
// failed" UI state.
// --------------------------------------------------------------------------

const MSA_TEXT = `MASTER SERVICES AGREEMENT

This Master Services Agreement (the "Agreement") is entered into as of February 3, 2026 (the "Effective Date") by and between Acme Corporation ("Customer") and Initech LLC, a Texas limited liability company ("Provider").

1. Services. Provider shall perform the services described in one or more statements of work (each, an "SOW") executed by the parties under this Agreement.

2. Term. The initial term of this Agreement is three (3) years from the Effective Date. This Agreement will automatically renew for successive one (1) year periods unless either party gives written notice of non-renewal at least sixty (60) days before the end of the then-current term.

3. Fees. Customer shall pay Provider the fees set forth in each SOW. The minimum annual commitment under this Agreement is $480,000 USD.

4. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of California, without regard to its conflict of laws principles.

5. Termination. Either party may terminate this Agreement for material breach upon sixty (60) days' written notice if the breaching party fails to cure during such period.`;

const MSA_FIELDS: ExtractedField[] = [
  tag(MSA_TEXT, {
    field_name: "parties",
    value_json: ["Acme Corporation", "Initech LLC"],
    needle: 'Acme Corporation ("Customer") and Initech LLC',
    confidence: 0.95,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
  tag(MSA_TEXT, {
    field_name: "counterparty",
    value_json: "Initech LLC",
    needle: "Initech LLC, a Texas limited liability company",
    confidence: 0.93,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
  tag(MSA_TEXT, {
    field_name: "effective_date",
    value_json: "2026-02-03",
    needle: "February 3, 2026",
    confidence: 0.97,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
  tag(MSA_TEXT, {
    field_name: "term",
    value_json: "3 years, auto-renewing 1 year",
    needle:
      "three (3) years from the Effective Date. This Agreement will automatically renew for successive one (1) year periods",
    confidence: 0.84,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
  tag(MSA_TEXT, {
    field_name: "renewal_date",
    value_json: "2029-02-03",
    needle: "automatically renew for successive one (1) year periods",
    confidence: 0.78,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
  tag(MSA_TEXT, {
    field_name: "contract_value",
    value_json: { amount: 480000, currency: "USD" },
    needle: "$480,000 USD",
    confidence: 0.9,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
  tag(MSA_TEXT, {
    field_name: "governing_law",
    value_json: "California",
    needle: "State of California",
    confidence: 0.92,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
  tag(MSA_TEXT, {
    field_name: "termination_notice_period",
    value_json: "60 days",
    needle: "sixty (60) days' written notice",
    confidence: 0.81,
    extracted_at: "2026-02-03T08:14:51Z",
  }),
];

const SIGNATURE_TEXT = `MUTUAL NON-DISCLOSURE AGREEMENT — OUT FOR SIGNATURE

Between Acme Corporation ("Acme") and Initech LLC, a Texas limited liability company ("Counterparty"). Effective as of March 1, 2026.

1. Term. This Agreement remains in effect for twelve (12) months from the Effective Date and renews automatically for successive twelve (12) month periods unless either party gives written notice at least forty-five (45) days prior to renewal.

2. Governing Law. This Agreement is governed by the laws of the State of New York.

3. Termination. Either party may terminate this Agreement for any reason upon forty-five (45) days' prior written notice to the other party.

This packet has been sent to both parties for signature via DocuSeal.`;

const SIGNATURE_FIELDS: ExtractedField[] = [
  tag(SIGNATURE_TEXT, {
    field_name: "parties",
    value_json: ["Acme Corporation", "Initech LLC"],
    needle: 'Acme Corporation ("Acme") and Initech LLC',
    confidence: 0.94,
    extracted_at: "2026-02-15T09:00:00Z",
  }),
  tag(SIGNATURE_TEXT, {
    field_name: "counterparty",
    value_json: "Initech LLC",
    needle: "Initech LLC, a Texas limited liability company",
    confidence: 0.92,
    extracted_at: "2026-02-15T09:00:00Z",
  }),
  tag(SIGNATURE_TEXT, {
    field_name: "effective_date",
    value_json: "2026-03-01",
    needle: "March 1, 2026",
    confidence: 0.96,
    extracted_at: "2026-02-15T09:00:00Z",
  }),
  tag(SIGNATURE_TEXT, {
    field_name: "term",
    value_json: "12 months, auto-renewing",
    needle: "twelve (12) months from the Effective Date",
    confidence: 0.86,
    extracted_at: "2026-02-15T09:00:00Z",
  }),
  tag(SIGNATURE_TEXT, {
    field_name: "renewal_date",
    value_json: "2026-06-01",
    needle: "renews automatically for successive twelve (12) month periods",
    confidence: 0.71,
    extracted_at: "2026-02-15T09:00:00Z",
  }),
  tag(SIGNATURE_TEXT, {
    field_name: "governing_law",
    value_json: "New York",
    needle: "State of New York",
    confidence: 0.95,
    extracted_at: "2026-02-15T09:00:00Z",
  }),
  tag(SIGNATURE_TEXT, {
    field_name: "termination_notice_period",
    value_json: "45 days",
    needle: "forty-five (45) days' prior written notice",
    confidence: 0.83,
    extracted_at: "2026-02-15T09:00:00Z",
  }),
];

const EXECUTED_TEXT = `MUTUAL NON-DISCLOSURE AGREEMENT — EXECUTED

Between Acme Corporation ("Acme") and Stark Industries, a Delaware corporation ("Counterparty"). Effective as of February 20, 2026.

1. Term. This Agreement remains in effect for twenty-four (24) months from the Effective Date and may be extended by mutual written agreement of the parties.

2. Governing Law. This Agreement shall be governed by the laws of the State of Delaware.

3. Termination. Either party may terminate this Agreement for cause upon thirty (30) days' prior written notice to the other party, with an opportunity to cure during such period.

Executed by both parties via DocuSeal on February 20, 2026.`;

const EXECUTED_FIELDS: ExtractedField[] = [
  tag(EXECUTED_TEXT, {
    field_name: "parties",
    value_json: ["Acme Corporation", "Stark Industries"],
    needle: 'Acme Corporation ("Acme") and Stark Industries',
    confidence: 0.96,
    extracted_at: "2026-02-20T18:45:00Z",
  }),
  tag(EXECUTED_TEXT, {
    field_name: "counterparty",
    value_json: "Stark Industries",
    needle: "Stark Industries, a Delaware corporation",
    confidence: 0.94,
    extracted_at: "2026-02-20T18:45:00Z",
  }),
  tag(EXECUTED_TEXT, {
    field_name: "effective_date",
    value_json: "2026-02-20",
    needle: "February 20, 2026",
    confidence: 0.97,
    extracted_at: "2026-02-20T18:45:00Z",
  }),
  tag(EXECUTED_TEXT, {
    field_name: "term",
    value_json: "24 months",
    needle: "twenty-four (24) months from the Effective Date",
    confidence: 0.9,
    extracted_at: "2026-02-20T18:45:00Z",
  }),
  tag(EXECUTED_TEXT, {
    field_name: "renewal_date",
    value_json: "2028-02-20",
    needle: "may be extended by mutual written agreement",
    confidence: 0.62,
    extracted_at: "2026-02-20T18:45:00Z",
  }),
  tag(EXECUTED_TEXT, {
    field_name: "governing_law",
    value_json: "Delaware",
    needle: "State of Delaware",
    confidence: 0.96,
    extracted_at: "2026-02-20T18:45:00Z",
  }),
  tag(EXECUTED_TEXT, {
    field_name: "termination_notice_period",
    value_json: "30 days",
    needle: "thirty (30) days' prior written notice",
    confidence: 0.89,
    extracted_at: "2026-02-20T18:45:00Z",
  }),
];

const REDLINE_TEXT = `MUTUAL NON-DISCLOSURE AGREEMENT — NEGOTIATION DRAFT

Between Acme Corporation ("Acme") and Wayne Enterprises, a Delaware corporation ("Counterparty"). Effective as of April 1, 2026.

1. Term. This Agreement remains in effect for thirty-six (36) months from the Effective Date. The parties have not yet agreed on an auto-renewal mechanic; both options are tracked in Document History.

2. Governing Law. This Agreement is governed by the laws of the State of New York. (Acme's playbook prefers Delaware; redlined in v2.)

3. Termination. Either party may terminate this Agreement upon ninety (90) days' prior written notice to the other party.`;

const REDLINE_FIELDS: ExtractedField[] = [
  tag(REDLINE_TEXT, {
    field_name: "parties",
    value_json: ["Acme Corporation", "Wayne Enterprises"],
    needle: 'Acme Corporation ("Acme") and Wayne Enterprises',
    confidence: 0.93,
    extracted_at: "2026-02-06T10:00:00Z",
  }),
  tag(REDLINE_TEXT, {
    field_name: "counterparty",
    value_json: "Wayne Enterprises",
    needle: "Wayne Enterprises, a Delaware corporation",
    confidence: 0.91,
    extracted_at: "2026-02-06T10:00:00Z",
  }),
  tag(REDLINE_TEXT, {
    field_name: "effective_date",
    value_json: "2026-04-01",
    needle: "April 1, 2026",
    confidence: 0.95,
    extracted_at: "2026-02-06T10:00:00Z",
  }),
  tag(REDLINE_TEXT, {
    field_name: "term",
    value_json: "36 months",
    needle: "thirty-six (36) months from the Effective Date",
    confidence: 0.88,
    extracted_at: "2026-02-06T10:00:00Z",
  }),
  tag(REDLINE_TEXT, {
    field_name: "governing_law",
    value_json: "New York (contested — playbook prefers Delaware)",
    needle: "State of New York",
    confidence: 0.64,
    extracted_at: "2026-02-06T10:00:00Z",
  }),
  tag(REDLINE_TEXT, {
    field_name: "termination_notice_period",
    value_json: "90 days",
    needle: "ninety (90) days' prior written notice",
    confidence: 0.85,
    extracted_at: "2026-02-06T10:00:00Z",
  }),
];

// Merged is a duplicate scan of the canonical NDA; reuse its text and a
// trimmed field set so the citation flow is identical when a user lands
// on the merged record.
const MERGED_TEXT = MUTUAL_NDA_TEXT;
const MERGED_FIELDS: ExtractedField[] = [
  tag(MERGED_TEXT, {
    field_name: "parties",
    value_json: ["Acme Corporation", "Globex Industries, Inc."],
    needle: "Acme Corporation, a Delaware corporation",
    confidence: 0.93,
    extracted_at: "2026-01-22T11:11:00Z",
  }),
  tag(MERGED_TEXT, {
    field_name: "counterparty",
    value_json: "Globex Industries, Inc.",
    needle: "Globex Industries, Inc.",
    confidence: 0.91,
    extracted_at: "2026-01-22T11:11:00Z",
  }),
  tag(MERGED_TEXT, {
    field_name: "effective_date",
    value_json: "2026-01-15",
    needle: "January 15, 2026",
    confidence: 0.97,
    extracted_at: "2026-01-22T11:11:00Z",
  }),
  tag(MERGED_TEXT, {
    field_name: "governing_law",
    value_json: "Delaware",
    needle: "State of Delaware",
    confidence: 0.9,
    extracted_at: "2026-01-22T11:11:00Z",
  }),
];

export const MOCK_DETAIL_BY_ID: Record<string, ContractDetail> = {
  [MOCK_NDA_ID]: {
    ...MOCK_LIST[0],
    full_text: MUTUAL_NDA_TEXT,
    extracted_fields: NDA_FIELDS,
    clauses: NDA_CLAUSES,
  },
  [MOCK_MSA_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_MSA_ID)!,
    full_text: MSA_TEXT,
    extracted_fields: MSA_FIELDS,
    clauses: [],
  },
  [MOCK_SIGNATURE_OUT_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_SIGNATURE_OUT_ID)!,
    full_text: SIGNATURE_TEXT,
    extracted_fields: SIGNATURE_FIELDS,
    clauses: [],
  },
  [MOCK_EXECUTED_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_EXECUTED_ID)!,
    full_text: EXECUTED_TEXT,
    extracted_fields: EXECUTED_FIELDS,
    clauses: [],
  },
  [MOCK_MERGED_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_MERGED_ID)!,
    full_text: MERGED_TEXT,
    extracted_fields: MERGED_FIELDS,
    clauses: [],
  },
  [MOCK_REDLINE_ID]: {
    ...MOCK_LIST.find((c) => c.id === MOCK_REDLINE_ID)!,
    full_text: REDLINE_TEXT,
    extracted_fields: REDLINE_FIELDS,
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
