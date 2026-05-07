/**
 * Sample data for demo mode. Everything here is fictional and labelled as
 * such in the UI. No real contract text, no PII, no real party names.
 *
 * Span offsets are precomputed against `MUTUAL_NDA_TEXT` and validated by
 * `mockApi.test.ts`. If you edit the text, regenerate the offsets.
 */
import type {
  ContractDetail,
  ContractListItem,
  ExtractedField,
} from "../types/contracts";

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const MOCK_NDA_ID = "00000000-0000-4000-8000-000000000001";
export const MOCK_MSA_ID = "00000000-0000-4000-8000-000000000002";
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
    title: "Mutual NDA — Acme & Globex (sample)",
    status: "ready",
    mime_type: PDF_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000001",
    page_count: 2,
    created_at: "2026-01-15T10:30:00Z",
    updated_at: "2026-01-15T10:32:14Z",
  },
  {
    id: MOCK_MSA_ID,
    title: "Master Services Agreement — Initech (sample)",
    status: "extracting",
    mime_type: DOCX_MIME,
    file_hash_sha256:
      "0000000000000000000000000000000000000000000000000000000000000002",
    page_count: 14,
    created_at: "2026-02-03T08:14:51Z",
    updated_at: "2026-02-03T08:15:02Z",
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
  },
];

export const MOCK_DETAIL_BY_ID: Record<string, ContractDetail> = {
  [MOCK_NDA_ID]: {
    ...MOCK_LIST[0],
    full_text: MUTUAL_NDA_TEXT,
    extracted_fields: NDA_FIELDS,
  },
  [MOCK_MSA_ID]: {
    ...MOCK_LIST[1],
    full_text:
      "Master Services Agreement (sample). Extraction is still in progress in this demo; metadata fields will appear here once it completes.",
    extracted_fields: [],
  },
  [MOCK_FAILED_ID]: {
    ...MOCK_LIST[2],
    full_text:
      "Vendor SOW (sample). Extraction failed in this demo to illustrate the UI for that state. The original file would still be downloadable.",
    extracted_fields: [],
  },
};

export const MOCK_NDA_FULL_TEXT = MUTUAL_NDA_TEXT;
