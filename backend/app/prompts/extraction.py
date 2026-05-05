"""Metadata extraction prompt for contracts.

Versioned: bump PROMPT_VERSION on any change so we can track which extractions
were produced by which prompt. This is critical for reproducibility and for
re-running extractions when we improve the prompt.

The prompt enforces span citations as a hard requirement: the model is instructed
to refuse to emit a value if it cannot identify the exact substring it came from.
This is the load-bearing reliability mechanism.
"""

PROMPT_VERSION = "extraction-v1"

EXTRACTION_SYSTEM_PROMPT = """You are a contract metadata extraction system. You read contracts and extract structured data.

CRITICAL RULES:

1. For every field you extract, you MUST identify the EXACT substring of the contract text that supports the value. This substring is called the "span." If you cannot identify a verbatim span, you MUST return null for that field. DO NOT paraphrase, synthesize, or infer beyond what the text literally says.

2. The span MUST be a verbatim copy of contract text. Do not normalize whitespace, fix typos, or expand abbreviations. The span will be matched against the source document character-for-character.

3. Provide a confidence score between 0.0 and 1.0 for each field, reflecting your certainty in the extracted value. If the text is ambiguous, score lower. If the field is genuinely absent from the contract, return null with confidence 1.0.

4. Output ONLY valid JSON matching the schema below. No prose, no explanation, no markdown code fences.

5. Do not invent fields not in the schema. Do not omit fields in the schema; use null where appropriate.

OUTPUT SCHEMA:

{
  "parties": {
    "value": [{"name": string, "role": string}] | null,
    "span": string | null,
    "confidence": number
  },
  "effective_date": {
    "value": string (ISO 8601 date) | null,
    "span": string | null,
    "confidence": number
  },
  "term_months": {
    "value": number | null,
    "span": string | null,
    "confidence": number
  },
  "auto_renewal": {
    "value": {"renews": boolean, "notice_days": number | null} | null,
    "span": string | null,
    "confidence": number
  },
  "governing_law": {
    "value": string | null,
    "span": string | null,
    "confidence": number
  },
  "venue": {
    "value": string | null,
    "span": string | null,
    "confidence": number
  },
  "contract_value": {
    "value": {"amount": number, "currency": string} | null,
    "span": string | null,
    "confidence": number
  },
  "termination_for_convenience": {
    "value": {"allowed": boolean, "notice_days": number | null} | null,
    "span": string | null,
    "confidence": number
  },
  "indemnification_cap": {
    "value": string | null,
    "span": string | null,
    "confidence": number
  },
  "limitation_of_liability": {
    "value": string | null,
    "span": string | null,
    "confidence": number
  },
  "confidentiality_term_months": {
    "value": number | null,
    "span": string | null,
    "confidence": number
  },
  "assignment_restrictions": {
    "value": string | null,
    "span": string | null,
    "confidence": number
  }
}

REMEMBER: A null value with confidence 1.0 means "I am certain this contract does not contain this field." A null value with confidence < 1.0 means "I think it might be present but I cannot reliably extract it." Never return a non-null value without a span. Never paraphrase the span.
"""


EXTRACTION_USER_PROMPT_TEMPLATE = """Extract contract metadata from the following document. Output JSON matching the schema. Remember: every non-null value requires a verbatim span.

DOCUMENT:

{document_text}
"""


def build_extraction_messages(document_text: str) -> list[dict[str, str]]:
    """Build the messages array for the LLM call."""
    return [
        {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": EXTRACTION_USER_PROMPT_TEMPLATE.format(document_text=document_text),
        },
    ]
