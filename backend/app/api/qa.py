"""Q&A over the contract repository (RAG).

v0.1 scope:
  - Single-turn questions scoped to a single contract or the full corpus.
  - Answers must cite the clauses they're drawn from.
  - Permissioning: only contracts the user can read are candidate retrieval
    targets — enforced in `app.services.retrieval.search_clauses`'s WHERE
    clause, before any ranking or LLM call happens.

Flow:
  1. Authenticate (same dev-user header pattern as other routers).
  2. Best-effort embed the question (see `app.services.embeddings`); if
     that fails or embeddings are disabled, retrieval just runs without
     the vector leg.
  3. `search_clauses` (org-scoped, optionally contract-scoped).
  4. No hits -> a grounded refusal. No LLM call, no hallucinated answer.
  5. Build a numbered context block from the hits, ask the LLM for
     strict JSON with an answer, per-clause citations, and a confidence
     score.
  6. Validate every citation: its quote MUST appear verbatim in the
     cited clause's text (see `app.services.extraction`'s identical
     span-validation discipline). Invalid citations are dropped.
  7. Zero valid citations survive -> a grounded refusal, even if the
     model produced prose. Design principle #2: if we can't cite it, we
     don't surface it.

Post-v0.1: multi-turn conversations, structured queries ("show me all NDAs
expiring in Q3"), cross-contract analytics.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Annotated, Any

import litellm
from fastapi import APIRouter, Header, HTTPException
from tenacity import retry, stop_after_attempt, wait_exponential

from app.api.contracts import DbSession, _current_dev_user, _get_contract_for_org
from app.core.config import get_settings
from app.schemas.qa import AskRequest, AskResponse, CitationResponse
from app.security.llm_hook import (
    LLMCallContext,
    PreLLMHookError,
    is_remote_provider,
    load_hook_from_env,
)
from app.services.embeddings import EmbeddingInput, get_embedding_provider
from app.services.retrieval import ClauseSearchResult, search_clauses

log = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter()

_MAX_CONTEXT_CLAUSES = 10

_REFUSAL_MESSAGE = (
    "I could not find an answer to this question in your contracts. "
    "Whereas only answers from indexed contract text and does not guess "
    "or provide legal advice."
)


class QAError(Exception):
    """Raised when the QA LLM call fails irrecoverably."""


def _unanswerable(model: str | None = None) -> AskResponse:
    return AskResponse(
        answerable=False,
        answer=_REFUSAL_MESSAGE,
        citations=[],
        confidence=0.0,
        model=model,
    )


@router.post("/ask", response_model=AskResponse)
async def ask(
    payload: AskRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AskResponse:
    """Answer a question by retrieving clauses and asking the LLM to cite them."""
    user = await _current_dev_user(session, x_whereas_dev_user)

    if payload.contract_id is not None:
        # 404s the same whether the contract doesn't exist or belongs to
        # another org — same convention as the rest of `app.api.contracts`.
        await _get_contract_for_org(
            session, contract_id=payload.contract_id, organization_id=user.organization_id
        )

    embedding = await _embed_question_best_effort(payload.question, user.organization_id)

    hits = await search_clauses(
        session,
        user.organization_id,
        payload.question,
        limit=_MAX_CONTEXT_CLAUSES,
        embedding=embedding,
        contract_id=payload.contract_id,
    )
    if not hits:
        return _unanswerable()

    try:
        raw_response, model_name = await _call_llm(
            payload.question,
            hits,
            organization_id=user.organization_id,
            contract_id=payload.contract_id,
        )
    except PreLLMHookError as e:
        log.warning("QA LLM call blocked by pre-LLM hook", extra={"error": str(e)})
        raise HTTPException(
            status_code=403, detail="Question answering is blocked by configured policy."
        ) from e
    except Exception:
        log.exception("QA LLM call failed")
        raise HTTPException(
            status_code=503, detail="Question answering is temporarily unavailable."
        ) from None

    parsed = _parse_llm_response(raw_response)
    if parsed is None:
        return _unanswerable(model=model_name)

    citations = _validate_citations(parsed.get("citations"), hits)
    if not citations:
        return _unanswerable(model=model_name)

    answer = parsed.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        return _unanswerable(model=model_name)

    return AskResponse(
        answerable=True,
        answer=answer,
        citations=citations,
        confidence=_clamp_confidence(parsed.get("confidence")),
        model=model_name,
    )


# --------------------------------------------------------------------------
# Embedding the question (best-effort)
# --------------------------------------------------------------------------


async def _embed_question_best_effort(
    question: str, organization_id: uuid.UUID
) -> list[float] | None:
    """Embed the question for the vector retrieval leg, or return None.

    Mirrors the ingest-time embedding hook in `app.services.embeddings`:
    an embedding-provider outage must not fail Q&A, it should just fall
    back to full-text/trigram retrieval only.
    """
    provider = get_embedding_provider()
    if provider.mode == "disabled":
        return None
    try:
        vectors = await provider.embed_texts(
            [
                EmbeddingInput(
                    id="qa-question",
                    text=question,
                    kind="qa_question",
                    metadata={"organization_id": str(organization_id)},
                )
            ]
        )
    except Exception:
        log.warning(
            "Embedding the QA question failed; continuing without the vector "
            "retrieval leg",
            exc_info=True,
        )
        return None
    return vectors[0] if vectors else None


# --------------------------------------------------------------------------
# LLM call
# --------------------------------------------------------------------------


_QA_SYSTEM_PROMPT = """You are a contract question-answering assistant. You answer questions using ONLY the numbered clause excerpts provided in the user message. You are not a lawyer; you report what the provided contract text says and never give legal advice.

CRITICAL RULES:

1. Answer using ONLY the provided clause excerpts. Do not use outside knowledge about law, contracts in general, or anything not present in the excerpts.

2. For every claim in your answer, you MUST cite at least one excerpt by its bracketed index (e.g. excerpt [2]), quoting the EXACT verbatim substring of that excerpt's text that supports the claim. Do not paraphrase, summarize, or normalize whitespace in the quote — it will be matched against the source text character-for-character.

3. If the excerpts do not contain enough information to answer the question, set "answer" to a brief statement that the documents do not address it and return an empty "citations" list.

4. Provide a confidence score between 0.0 and 1.0 reflecting how well the excerpts support your answer.

5. Output ONLY valid JSON matching the schema below. No prose, no explanation, no markdown code fences.

OUTPUT SCHEMA:

{
  "answer": string,
  "citations": [{"index": number, "quote": string}],
  "confidence": number
}
"""

_QA_USER_PROMPT_TEMPLATE = """Question: {question}

Clause excerpts:

{context_block}
"""


def _build_context_block(hits: list[ClauseSearchResult]) -> str:
    blocks = []
    for index, hit in enumerate(hits, start=1):
        heading = hit.heading or "(no heading)"
        blocks.append(
            f"[{index}] Contract: {hit.contract_title} | Clause: {heading}\n{hit.text}"
        )
    return "\n\n".join(blocks)


def _resolve_qa_model_name() -> str:
    """Map our config-style model name to a LiteLLM-compatible string.

    Mirrors `app.services.extraction._resolve_model_name`. Q&A reuses
    `EXTRACTION_MODEL` — there is no separate QA-specific model setting;
    adding one before there's a real reason for the two to diverge would
    be speculative configuration surface.
    """
    if settings.LITELLM_PROVIDER == "ollama":
        return f"ollama/{settings.EXTRACTION_MODEL}"
    if settings.LITELLM_PROVIDER == "openai":
        return settings.EXTRACTION_MODEL
    if settings.LITELLM_PROVIDER == "anthropic":
        return f"anthropic/{settings.EXTRACTION_MODEL}"
    if settings.LITELLM_PROVIDER == "azure":
        return f"azure/{settings.EXTRACTION_MODEL}"
    return settings.EXTRACTION_MODEL


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    reraise=True,
)
async def _call_litellm_with_retry(*, messages: list[dict[str, str]], model: str) -> str:
    """Call LiteLLM with retries. Returns raw response text."""
    response = await litellm.acompletion(
        model=model,
        messages=messages,
        temperature=0.0,
        response_format={"type": "json_object"},
        timeout=settings.LLM_REQUEST_TIMEOUT_SECONDS,
    )
    content = response.choices[0].message.content
    if not content:
        raise QAError("LLM returned empty content")
    return content


async def _call_llm(
    question: str,
    hits: list[ClauseSearchResult],
    *,
    organization_id: uuid.UUID,
    contract_id: uuid.UUID | None,
) -> tuple[str, str]:
    """Apply pre-LLM policy to the outbound question and context, then call
    the LLM. Returns (raw response text, resolved model name)."""
    model = _resolve_qa_model_name()
    remote_provider = is_remote_provider(settings.LITELLM_PROVIDER)
    hook = load_hook_from_env()
    hook_context = LLMCallContext(
        purpose="qa.answer",
        model=model,
        is_remote_provider=remote_provider,
        document_id=str(contract_id) if contract_id is not None else None,
        organization_id=str(organization_id),
    )
    hooked_question = hook(question, hook_context)
    hooked_context_block = hook(_build_context_block(hits), hook_context)
    messages = [
        {"role": "system", "content": _QA_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _QA_USER_PROMPT_TEMPLATE.format(
                question=hooked_question, context_block=hooked_context_block
            ),
        },
    ]
    raw = await _call_litellm_with_retry(messages=messages, model=model)
    return raw, model


# --------------------------------------------------------------------------
# Response parsing and citation validation
# --------------------------------------------------------------------------


_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)


def _strip_code_fences(text: str) -> str:
    text = text.strip()
    match = _CODE_FENCE_RE.match(text)
    return match.group(1).strip() if match else text


def _parse_llm_response(raw: str) -> dict[str, Any] | None:
    cleaned = _strip_code_fences(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        log.warning("QA LLM returned invalid JSON", extra={"response_preview": raw[:500]})
        return None
    if not isinstance(parsed, dict):
        log.warning("QA LLM response is not a JSON object")
        return None
    return parsed


def _validate_citations(
    raw_citations: Any, hits: list[ClauseSearchResult]
) -> list[CitationResponse]:
    """Keep only citations whose quote appears verbatim in the cited clause.

    Mirrors `app.services.extraction`'s span-validation discipline: the
    model can claim a citation, but it can't fabricate text that isn't
    actually in the clause it points at.
    """
    if not isinstance(raw_citations, list):
        return []

    validated: list[CitationResponse] = []
    seen: set[tuple[uuid.UUID, int]] = set()
    for item in raw_citations:
        if not isinstance(item, dict):
            continue
        index = item.get("index")
        quote = item.get("quote")
        if not isinstance(index, int) or not isinstance(quote, str) or not quote:
            continue

        position = index - 1  # citations are 1-based, matching the context block
        if position < 0 or position >= len(hits):
            continue
        hit = hits[position]

        start_offset = hit.text.find(quote)
        if start_offset == -1:
            log.info(
                "Dropping QA citation: quote not found verbatim in cited clause",
                extra={"clause_id": str(hit.clause_id)},
            )
            continue

        dedupe_key = (hit.clause_id, start_offset)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        validated.append(
            CitationResponse(
                contract_id=hit.contract_id,
                contract_title=hit.contract_title,
                clause_id=hit.clause_id,
                heading=hit.heading,
                quote=quote,
                start_offset=start_offset,
                end_offset=start_offset + len(quote),
            )
        )
    return validated


def _clamp_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, confidence))
