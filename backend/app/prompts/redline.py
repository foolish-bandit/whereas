"""Redline-suggestion prompt for failed playbook findings.

Versioned: bump ``PROMPT_VERSION`` on any change so we can track which
suggestions were produced by which prompt. Persisted alongside the
generated redline on ``SuggestedRedline.prompt_version``.

What this prompt asks for
-------------------------

A *replacement* for one specific clause that fails one specific
playbook rule. The model is given:

  * the clause text (already exact-span-grounded by the segmenter);
  * the rule's title and message (why it failed);
  * any firm-authored guidance (``rule.guidance``) and preferred
    template language (``rule.preferred_language``) — when present,
    the prompt biases the model toward that language rather than
    inventing one;
  * the rule's expected value or required terms, if any.

The model returns a single JSON object with three fields:
``redline_text`` (the suggested replacement clause), ``rationale``
(one short paragraph explaining how the new text addresses the
failure), and ``confidence`` (a number in ``[0, 1]``).

Critically: redlines are *not* legal advice. The system prompt makes
that explicit and the API copy reinforces it. The model is told to
keep its output to one clause's worth of text and not to add
preamble, signature blocks, or surrounding contract scaffolding.
"""
from __future__ import annotations

PROMPT_VERSION = "redline-v1"

REDLINE_SYSTEM_PROMPT = """You are a contract redlining assistant. Given a clause from a contract that fails a firm-defined review rule, you propose REPLACEMENT language for that clause.

CRITICAL RULES:

1. Output ONLY valid JSON matching the schema below. No prose, no explanation, no markdown code fences.

2. Your output is a SUGGESTION for human review, not legal advice. A licensed attorney must approve any change before it is used in a real negotiation. Do not advise on legal strategy, governing law selection beyond the firm's stated preference, or risk allocation; restate the firm's stated preference where one is given.

3. Replace ONE clause. Do not produce a contract preamble, signature block, multiple clauses, or commentary outside the JSON. Keep numbering / heading style consistent with the input clause if it has one.

4. If the firm provides preferred_language, treat it as the source of truth for desired terminology and intent. You may adapt it for grammatical fit with the surrounding clause, but do not deviate substantively from what the firm wrote.

5. If the firm provides expected_value (e.g. a governing-law jurisdiction), the redline must use that value verbatim.

6. If the firm provides required_terms, the redline must include each of them as written, in a way that is grammatically integrated with the rest of the clause.

7. Provide a confidence score between 0.0 and 1.0 reflecting your certainty that the suggested redline addresses the rule failure. Score lower when the rule is ambiguous, when the source clause is too sparse to reliably revise, or when no firm guidance was provided.

8. The "rationale" must be one short paragraph (no more than three sentences) explaining how the redline addresses the rule failure. Do NOT include legal advice, recommendations beyond the rule, or hedging boilerplate.

OUTPUT SCHEMA:

{
  "redline_text": string,
  "rationale": string,
  "confidence": number
}
"""


REDLINE_USER_PROMPT_TEMPLATE = """Suggest replacement language for the following clause. Output JSON matching the schema.

RULE THAT FAILED:
- Title: {rule_title}
- Why it failed: {rule_message}
- Rule type: {rule_type}
- Clause type: {clause_type}{rule_extras}

CURRENT CLAUSE TEXT:
\"\"\"
{clause_text}
\"\"\"
"""


def build_redline_messages(
    *,
    rule_title: str,
    rule_message: str,
    rule_type: str,
    clause_type: str,
    clause_text: str,
    expected_value: str | None = None,
    required_terms: list[str] | None = None,
    guidance: str | None = None,
    preferred_language: str | None = None,
) -> list[dict[str, str]]:
    """Build the messages array for the redline LLM call.

    The "rule_extras" block is constructed inline so the prompt only
    surfaces fields the firm actually populated. Empty firm-authored
    fields are omitted entirely rather than rendered as "None" — the
    model is more reliable when the prompt does not contain noise.
    """
    extras_lines: list[str] = []
    if expected_value:
        extras_lines.append(f"- Expected value: {expected_value}")
    if required_terms:
        joined = ", ".join(repr(t) for t in required_terms)
        extras_lines.append(f"- Required terms (must appear verbatim): {joined}")
    if guidance:
        extras_lines.append(f"- Firm guidance: {guidance}")
    if preferred_language:
        extras_lines.append(
            "- Firm preferred language (use as source of truth):\n"
            f'"""\n{preferred_language}\n"""'
        )
    rule_extras = ("\n" + "\n".join(extras_lines)) if extras_lines else ""

    user_content = REDLINE_USER_PROMPT_TEMPLATE.format(
        rule_title=rule_title,
        rule_message=rule_message,
        rule_type=rule_type,
        clause_type=clause_type,
        rule_extras=rule_extras,
        clause_text=clause_text,
    )
    return [
        {"role": "system", "content": REDLINE_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
