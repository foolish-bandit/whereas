"""Contract metadata extraction service.

Pipeline:
1. Send document text + extraction prompt to LLM via LiteLLM.
2. Parse JSON response. Reject malformed responses.
3. Validate every span: it MUST appear verbatim in the source text. If it doesn't,
   we treat that field as a hallucination and drop it.
4. Compute character offsets for valid spans.
5. Apply confidence thresholds from settings.
6. Return ExtractedField records ready to persist.

This is the load-bearing reliability mechanism. The model can lie, but it can't
fabricate text that's actually in the document.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any

import litellm
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import get_settings
from app.models import Contract, ExtractedField
from app.prompts.extraction import (
    PROMPT_VERSION,
    build_extraction_messages,
)
from app.schemas.ai_extraction import MetadataExtractionResponse
from app.security.audit_log import AuditEvent, AuditEventType, record_event
from app.security.llm_hook import (
    LLMCallContext,
    PreLLMHookError,
    is_remote_provider,
    load_hook_from_env,
)

log = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class ExtractedFieldResult:
    field_name: str
    value: object | None
    span_text: str | None
    span_start: int | None
    span_end: int | None
    confidence: float
    model_name: str
    prompt_version: str
    rejected_reason: str | None = None


class ExtractionError(Exception):
    """Raised when extraction fails irrecoverably."""


def _response_format() -> dict[str, Any]:
    """Build the `response_format` kwarg for the extraction LLM call.

    Default is the plain `json_object` mode that every OpenAI-compatible
    endpoint (including Ollama's) accepts. When
    `settings.EXTRACTION_STRUCTURED_OUTPUT` is enabled, upgrade to a
    `json_schema` response format derived from
    `MetadataExtractionResponse` so providers that support structured
    outputs can constrain generation. This is strictly best-effort: a
    provider that ignores or rejects `response_format` behaves exactly
    as it did before this option existed, so the flag defaults off.
    """
    if not settings.EXTRACTION_STRUCTURED_OUTPUT:
        return {"type": "json_object"}
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "metadata_extraction_response",
            "schema": MetadataExtractionResponse.model_json_schema(),
        },
    }


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    reraise=True,
)
async def _call_litellm_with_retry(
    *,
    messages: list[dict[str, str]],
    model: str,
) -> str:
    """Call LiteLLM with retries. Returns raw response text."""
    response = await litellm.acompletion(
        model=model,
        messages=messages,
        temperature=0.0,
        response_format=_response_format(),
        timeout=settings.LLM_REQUEST_TIMEOUT_SECONDS,
    )
    content = response.choices[0].message.content
    if not content:
        raise ExtractionError("LLM returned empty content")
    return content


async def _call_llm(
    document_text: str,
    *,
    contract_id: str | None = None,
    organization_id: str | None = None,
) -> tuple[list[dict[str, str]], str]:
    """Apply pre-LLM policy, then call the LLM.

    Returns `(messages, raw_response_text)`. The messages are handed
    back so a validation-failure reask (`_reask_with_validation_error`)
    can replay the same conversation with the model's prior reply and a
    corrective follow-up appended, rather than resending document text.
    """
    model = _resolve_model_name()
    remote_provider = is_remote_provider(settings.LITELLM_PROVIDER)
    context = LLMCallContext(
        purpose="metadata_extraction",
        model=model,
        is_remote_provider=remote_provider,
        document_id=contract_id,
        organization_id=organization_id,
    )
    hook = load_hook_from_env()
    hooked_text = hook(document_text, context)
    messages = build_extraction_messages(hooked_text)
    raw_response = await _call_litellm_with_retry(messages=messages, model=model)
    return messages, raw_response


async def _reask_with_validation_error(
    messages: list[dict[str, str]],
    previous_reply: str,
    error: ValidationError,
    *,
    model: str,
) -> str:
    """Issue one corrective reask after a schema validation failure.

    Follows the Instructor reask pattern: append the model's previous
    reply plus a message describing the validation error, and ask for
    corrected JSON only. This is a single semantic retry, separate from
    the tenacity transport-retry wrapped by `_call_litellm_with_retry`
    (this call still gets its own transport retries, same as any other
    `_call_litellm_with_retry` invocation).
    """
    reask_messages = [
        *messages,
        {"role": "assistant", "content": previous_reply},
        {
            "role": "user",
            "content": (
                f"Your previous response failed validation: {error}. "
                "Return ONLY corrected JSON matching the schema."
            ),
        },
    ]
    return await _call_litellm_with_retry(messages=reask_messages, model=model)


# --------------------------------------------------------------------------
# Tolerant JSON parsing
# --------------------------------------------------------------------------


_CODE_FENCE_RE = re.compile(r"```(?:json)?", re.IGNORECASE)
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def _repair_json_text(raw: str) -> str:
    """Best-effort repair of a raw LLM response so it parses as JSON.

    Handles the failure modes weaker local models commonly produce:
      - the JSON wrapped in a markdown code fence (```json ... ```)
      - chatty prose before/after the JSON ("Here is the JSON: {...}")
      - trailing commas before a closing `}` or `]`

    Intentionally conservative: it does not attempt to fix unbalanced
    braces, unquoted keys, or other structural damage. If the input is
    broken in a way this can't repair, the caller's subsequent
    `json.loads` still raises and the existing failure path
    (`ExtractionError`) takes over.
    """
    text = _CODE_FENCE_RE.sub("", raw).strip()

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]

    return _TRAILING_COMMA_RE.sub(r"\1", text)


def _parse_json_response(raw_response: str, contract_id_for_log: str) -> dict[str, Any]:
    """Parse `raw_response` as a JSON object, repairing minor damage first.

    Raises `ExtractionError` if the response is not parseable JSON (even
    after `_repair_json_text`) or does not parse to a JSON object.
    """
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError:
        repaired = _repair_json_text(raw_response)
        try:
            parsed = json.loads(repaired)
        except json.JSONDecodeError as e:
            log.error(
                "LLM returned invalid JSON",
                extra={"contract_id": contract_id_for_log, "response": raw_response[:500]},
            )
            raise ExtractionError(f"Invalid JSON from LLM: {e}") from e

    if not isinstance(parsed, dict):
        raise ExtractionError("LLM response is not a JSON object")
    return parsed


def _resolve_model_name() -> str:
    """Map our config-style model name to a LiteLLM-compatible string."""
    if settings.LITELLM_PROVIDER == "ollama":
        return f"ollama/{settings.EXTRACTION_MODEL}"
    if settings.LITELLM_PROVIDER == "openai":
        return settings.EXTRACTION_MODEL
    if settings.LITELLM_PROVIDER == "anthropic":
        return f"anthropic/{settings.EXTRACTION_MODEL}"
    if settings.LITELLM_PROVIDER == "azure":
        return f"azure/{settings.EXTRACTION_MODEL}"
    return settings.EXTRACTION_MODEL


def _validate_span(span: str | None, document_text: str) -> tuple[int | None, int | None]:
    """Validate that a span appears verbatim in the source.

    Returns (start, end) offsets if valid, (None, None) if not.
    Uses the FIRST occurrence. This is a known limitation; if a span appears
    multiple times in the document, we don't currently disambiguate.
    """
    if not span:
        return None, None
    idx = document_text.find(span)
    if idx == -1:
        return None, None
    return idx, idx + len(span)


async def extract_metadata(
    document_text: str,
    contract_id: str | None = None,
    organization_id: str | None = None,
) -> list[ExtractedFieldResult]:
    """Extract structured metadata from a contract.

    `document_text` MUST be `ParsedDocument.full_text` produced by
    `app.services.document_parser.parse_document`. Span validation here uses
    `str.find(span)` against this exact string, so feeding in any other
    rendering (raw bytes decoded, output from a different parser, normalized
    whitespace, etc.) will cause every span to be rejected as a hallucination.

    Returns a list of ExtractedFieldResult. Fields where the model returned a
    value but we could not validate the span are returned with rejected_reason
    set, so the caller can audit hallucinations.
    """
    contract_id_for_log = contract_id or "unknown"
    try:
        messages, raw_response = await _call_llm(
            document_text,
            contract_id=contract_id,
            organization_id=organization_id,
        )
    except PreLLMHookError as e:
        log.warning(
            "LLM call blocked by pre-LLM hook",
            extra={"contract_id": contract_id_for_log, "error": str(e)},
        )
        raise ExtractionError(f"LLM call blocked by policy: {e}") from e
    except Exception as e:
        log.error(
            "LLM call failed",
            extra={"contract_id": contract_id_for_log, "error": str(e)},
        )
        raise ExtractionError(f"LLM call failed: {e}") from e

    parsed = _parse_json_response(raw_response, contract_id_for_log)

    try:
        MetadataExtractionResponse.model_validate(parsed)
    except ValidationError as validation_error:
        # One corrective reask (Instructor pattern), then give up for good
        # if the retry still doesn't validate - see _reask_with_validation_error.
        log.warning(
            "LLM response failed schema validation, issuing one reask",
            extra={"contract_id": contract_id_for_log, "error": str(validation_error)},
        )
        try:
            raw_response = await _reask_with_validation_error(
                messages,
                raw_response,
                validation_error,
                model=_resolve_model_name(),
            )
        except Exception as e:
            log.error(
                "LLM reask call failed",
                extra={"contract_id": contract_id_for_log, "error": str(e)},
            )
            raise ExtractionError(f"LLM call failed during reask: {e}") from e

        parsed = _parse_json_response(raw_response, contract_id_for_log)
        try:
            MetadataExtractionResponse.model_validate(parsed)
        except ValidationError as e:
            log.error(
                "LLM response failed schema validation after reask",
                extra={"contract_id": contract_id_for_log, "error": str(e)},
            )
            raise ExtractionError(
                f"LLM response failed schema validation after reask: {e}"
            ) from e

    model_name = _resolve_model_name()
    results: list[ExtractedFieldResult] = []

    for field_name, payload in parsed.items():
        if not isinstance(payload, dict):
            log.warning(
                "Malformed field payload, skipping",
                extra={"contract_id": contract_id_for_log, "field": field_name},
            )
            continue

        value = payload.get("value")
        span = payload.get("span")
        confidence = payload.get("confidence", 0.0)

        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            confidence = 0.0

        # Drop below the hard threshold entirely
        if confidence < settings.EXTRACTION_DROP_THRESHOLD and value is not None:
            log.info(
                "Dropping low-confidence extraction",
                extra={
                    "contract_id": contract_id_for_log,
                    "field": field_name,
                    "confidence": confidence,
                },
            )
            continue

        # Validate span for non-null values
        rejected_reason = None
        span_start: int | None = None
        span_end: int | None = None

        if value is not None:
            if not span:
                rejected_reason = "missing_span"
                value = None
            else:
                span_start, span_end = _validate_span(span, document_text)
                if span_start is None:
                    rejected_reason = "span_not_found_in_source"
                    log.warning(
                        "Span not found in source - probable hallucination",
                        extra={
                            "contract_id": contract_id_for_log,
                            "field": field_name,
                            "span_preview": span[:100],
                        },
                    )
                    value = None
                    span = None

        results.append(
            ExtractedFieldResult(
                field_name=field_name,
                value=value,
                span_text=span,
                span_start=span_start,
                span_end=span_end,
                confidence=confidence,
                model_name=model_name,
                prompt_version=PROMPT_VERSION,
                rejected_reason=rejected_reason,
            )
        )

    return results


async def extract_and_persist_metadata(
    session: AsyncSession,
    *,
    contract: Contract,
    actor_user_id: uuid.UUID | None = None,
) -> list[ExtractedField]:
    """Extract metadata for a contract and persist accepted fields.

    The caller owns the transaction. This function flushes so returned ORM
    rows are usable immediately, but it does not commit.
    """
    if contract.full_text is None:
        raise ExtractionError("Contract has no full_text to extract from")

    model_name = _resolve_model_name()
    remote_provider = is_remote_provider(settings.LITELLM_PROVIDER)
    results = await extract_metadata(
        contract.full_text,
        contract_id=str(contract.id),
        organization_id=str(contract.organization_id),
    )

    if remote_provider:
        await _record_first_remote_provider_use(
            session,
            contract=contract,
            actor_user_id=actor_user_id,
            model_name=model_name,
        )

    await session.execute(delete(ExtractedField).where(ExtractedField.contract_id == contract.id))

    persisted: list[ExtractedField] = []
    for result in results:
        if (
            result.rejected_reason is not None
            or result.value is None
            or result.span_start is None
            or result.span_end is None
            or result.span_text is None
        ):
            continue

        # The hook may transform/redact outbound text, but citation offsets
        # remain tied to the original Contract.full_text. Without a mapping
        # layer, spans that only exist in transformed text must be rejected.
        field = ExtractedField(
            contract_id=contract.id,
            field_name=result.field_name,
            value_json=result.value,
            span_start=result.span_start,
            span_end=result.span_end,
            span_text=result.span_text,
            confidence=result.confidence,
            model_name=result.model_name,
            prompt_version=result.prompt_version,
        )
        persisted.append(field)

    session.add_all(persisted)
    await session.flush()
    return persisted


async def _record_first_remote_provider_use(
    session: AsyncSession,
    *,
    contract: Contract,
    actor_user_id: uuid.UUID | None,
    model_name: str,
) -> None:
    stmt = (
        select(AuditEvent)
        .where(
            AuditEvent.organization_id == contract.organization_id,
            AuditEvent.event_type == AuditEventType.LLM_REMOTE_PROVIDER_ENABLED.value,
        )
        .limit(1)
    )
    result = await session.execute(stmt)
    if result.scalar_one_or_none() is not None:
        return

    await record_event(
        session,
        organization_id=contract.organization_id,
        event_type=AuditEventType.LLM_REMOTE_PROVIDER_ENABLED,
        actor_user_id=actor_user_id,
        target_type="organization",
        target_id=str(contract.organization_id),
        details={
            "provider": settings.LITELLM_PROVIDER,
            "model": model_name,
            "purpose": "metadata_extraction",
            "contract_id": str(contract.id),
        },
    )
