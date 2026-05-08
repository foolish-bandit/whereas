"""Generate LLM-suggested redlines for failed playbook findings.

Pipeline
--------

1. Resolve the model name and pre-LLM hook (same plumbing the
   metadata-extraction service uses).
2. Build the redline prompt from the finding row (rule metadata,
   firm-authored guidance / preferred language, and the cited clause
   text — all of which are already exact-span-grounded by the
   segmenter).
3. Call LiteLLM with retries and JSON-only response format.
4. Parse and validate the JSON. Reject empty redlines, NaN
   confidences, and confidences outside ``[0.0, 1.0]``.
5. Persist a new ``SuggestedRedline`` row with the model name,
   prompt version, and confidence so a reviewer can audit what
   produced the suggestion.

Design choices
--------------

**No span citation on the redline itself.** The redline is replacement
language; by construction nothing in the source document can cite it.
The *finding* the redline is attached to already carries the
exact-span citation back to the source via ``DeviationFinding.span_*``.
Surfacing a redline without its parent finding is therefore not
allowed at the API boundary.

**One row per generation.** Regenerating creates a new row rather
than mutating an existing one. The row's ``status`` is the only
reviewer-mutable field on this entity through the API; the rest
(text, model, prompt version, confidence) is immutable post-write,
mirroring the deterministic-fields-immutable rule on
``DeviationFinding``.

**No span fidelity check on the LLM output.** Unlike the metadata
extraction pipeline, redlines are *not* spans of the source document
— they are proposed replacements. Validation here is limited to:
non-empty ``redline_text``, finite ``confidence`` in ``[0, 1]``, and
JSON shape. The audit signal (model name, prompt version, confidence)
travels with the row; legal review is the human's job.

**Auditing remote-provider use.** First-time use of a remote provider
for redline generation emits a single
``LLM_REMOTE_PROVIDER_ENABLED`` audit event per organization, mirroring
the metadata extraction service. Subsequent calls are not re-audited.
"""
from __future__ import annotations

import json
import logging
import math
import uuid
from dataclasses import dataclass

import litellm
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import get_settings
from app.models import (
    Clause,
    Contract,
    DeviationFinding,
    SuggestedRedline,
    SuggestedRedlineStatus,
)
from app.prompts.redline import PROMPT_VERSION, build_redline_messages
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
class GeneratedRedline:
    """Validated LLM output before persistence.

    ``model_name`` and ``prompt_version`` are not part of this struct
    because they are determined by the caller (the configured model
    and the ``PROMPT_VERSION`` constant), not parsed from the LLM
    response.
    """

    redline_text: str
    rationale: str | None
    confidence: float


class RedlineGenerationError(Exception):
    """Raised when redline generation fails irrecoverably."""


# --------------------------------------------------------------------------
# LiteLLM call (mirrors extraction.py's pattern)
# --------------------------------------------------------------------------


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
        response_format={"type": "json_object"},
        timeout=settings.LLM_REQUEST_TIMEOUT_SECONDS,
    )
    content = response.choices[0].message.content
    if not content:
        raise RedlineGenerationError("LLM returned empty content")
    return content


def _resolve_model_name() -> str:
    """Map the configured provider/model to a LiteLLM-compatible name.

    Mirrors ``app.services.extraction._resolve_model_name``. Kept inline
    (rather than imported) so the redline pipeline does not depend on
    the extraction module's internals; both happen to share the same
    provider matrix today, and a divergence (e.g. a separate
    ``REDLINE_MODEL`` setting) would land here.
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


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


async def generate_redline_for_finding(
    session: AsyncSession,
    *,
    contract: Contract,
    finding: DeviationFinding,
    actor_user_id: uuid.UUID | None = None,
) -> SuggestedRedline:
    """Generate one suggested redline for a failed finding and persist it.

    Caller owns transaction management. This function flushes so the
    returned ORM row is usable immediately, but it does not commit.

    Raises:
      ``RedlineGenerationError`` if the finding is not a failure, has
      no clause-level evidence to redline, the LLM call is blocked by
      the pre-LLM hook, the LLM returns malformed output, or the LLM
      output fails the validation rules in ``_parse_and_validate``.
    """
    if finding.status != "fail":
        raise RedlineGenerationError(
            "Redlines can only be generated for failed findings."
        )
    if not finding.evidence_text or finding.span_start is None:
        # No exact-span clause to redline: the rule failed because the
        # clause is *missing* entirely (a `required_clause` rule with
        # no candidate). Suggesting net-new clause text without an
        # anchoring source span is out of scope for v1.
        raise RedlineGenerationError(
            "Finding has no clause-level evidence to redline."
        )

    clause_text = await _resolve_clause_text(
        session, finding=finding, fallback_text=finding.evidence_text
    )

    messages = build_redline_messages(
        rule_title=finding.rule_title,
        rule_message=finding.message,
        rule_type=finding.rule_type,
        clause_type=finding.clause_type,
        clause_text=clause_text,
        expected_value=finding.expected_value,
        required_terms=list(finding.matched_terms or ()) or None,
        guidance=finding.guidance,
        preferred_language=finding.preferred_language,
    )

    model = _resolve_model_name()
    remote_provider = is_remote_provider(settings.LITELLM_PROVIDER)
    context = LLMCallContext(
        purpose="redline_generation",
        model=model,
        is_remote_provider=remote_provider,
        document_id=str(contract.id),
        organization_id=str(contract.organization_id),
    )
    hook = load_hook_from_env()
    try:
        # The hook may transform / redact content sent to remote
        # providers. We pass the clause text through it; the rest of
        # the prompt (rule title, message, firm guidance) is
        # firm-authored configuration, not document content, and is
        # not subject to the hook.
        hooked_clause = hook(clause_text, context)
    except PreLLMHookError as e:
        log.warning(
            "Redline LLM call blocked by pre-LLM hook",
            extra={
                "contract_id": str(contract.id),
                "finding_id": str(finding.id),
                "error": str(e),
            },
        )
        raise RedlineGenerationError(
            f"LLM call blocked by policy: {e}"
        ) from e

    if hooked_clause != clause_text:
        # Re-render the user prompt with the hook-transformed clause
        # text. Rule metadata is unchanged.
        messages = build_redline_messages(
            rule_title=finding.rule_title,
            rule_message=finding.message,
            rule_type=finding.rule_type,
            clause_type=finding.clause_type,
            clause_text=hooked_clause,
            expected_value=finding.expected_value,
            required_terms=list(finding.matched_terms or ()) or None,
            guidance=finding.guidance,
            preferred_language=finding.preferred_language,
        )

    try:
        raw_response = await _call_litellm_with_retry(
            messages=messages, model=model
        )
    except Exception as e:
        log.error(
            "Redline LLM call failed",
            extra={
                "contract_id": str(contract.id),
                "finding_id": str(finding.id),
                "error": str(e),
            },
        )
        raise RedlineGenerationError(f"LLM call failed: {e}") from e

    parsed = _parse_and_validate(raw_response)

    if remote_provider:
        await _record_first_remote_provider_use(
            session,
            contract=contract,
            actor_user_id=actor_user_id,
            model_name=model,
        )

    redline = SuggestedRedline(
        organization_id=contract.organization_id,
        contract_id=contract.id,
        finding_id=finding.id,
        redline_text=parsed.redline_text,
        rationale=parsed.rationale,
        model_name=model,
        prompt_version=PROMPT_VERSION,
        confidence=parsed.confidence,
        status=SuggestedRedlineStatus.PROPOSED.value,
        created_by=actor_user_id,
    )
    session.add(redline)
    await session.flush()
    return redline


async def update_redline_status(
    session: AsyncSession,
    *,
    redline: SuggestedRedline,
    new_status: str,
) -> SuggestedRedline:
    """Update a redline's reviewer workflow status.

    Validates that ``new_status`` is one of ``proposed`` /
    ``accepted`` / ``rejected``. The function does not mutate any
    other field; ``redline_text``, ``model_name``, ``prompt_version``,
    ``confidence``, and ``rationale`` are immutable post-write.
    """
    if new_status not in _REVIEWER_STATUSES:
        raise InvalidRedlineStatusError(
            f"status must be one of {sorted(_REVIEWER_STATUSES)!r}; "
            f"got {new_status!r}."
        )
    redline.status = new_status
    await session.flush()
    await session.refresh(redline)
    return redline


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


_REVIEWER_STATUSES: frozenset[str] = frozenset(
    {
        SuggestedRedlineStatus.PROPOSED.value,
        SuggestedRedlineStatus.ACCEPTED.value,
        SuggestedRedlineStatus.REJECTED.value,
    }
)


class InvalidRedlineStatusError(ValueError):
    """Raised when a caller asks to set an unsupported redline status."""


async def _resolve_clause_text(
    session: AsyncSession,
    *,
    finding: DeviationFinding,
    fallback_text: str,
) -> str:
    """Return the most authoritative clause text we have for the finding.

    Prefers the live ``Clause.text`` (still exact-span-grounded against
    the contract's ``full_text`` per the segmenter's invariant) when
    the FK still resolves; falls back to ``DeviationFinding.evidence_text``
    when the clause has been re-segmented out from under the finding
    (``ON DELETE SET NULL`` on ``clause_id``). Both are byte-identical
    in the steady state.
    """
    if finding.clause_id is None:
        return fallback_text
    result = await session.execute(
        select(Clause.text).where(Clause.id == finding.clause_id)
    )
    text = result.scalar_one_or_none()
    return text if text is not None else fallback_text


def _parse_and_validate(raw_response: str) -> GeneratedRedline:
    """Parse the LLM's JSON output and apply the validation rules.

    Validation:
      * top-level value is a JSON object;
      * ``redline_text`` is a non-empty string;
      * ``confidence`` is a finite float in ``[0.0, 1.0]``;
      * ``rationale`` is a string or null.

    Anything else raises ``RedlineGenerationError``.
    """
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError as e:
        raise RedlineGenerationError(f"Invalid JSON from LLM: {e}") from e
    if not isinstance(parsed, dict):
        raise RedlineGenerationError("LLM response is not a JSON object")

    redline_text = parsed.get("redline_text")
    if not isinstance(redline_text, str) or not redline_text.strip():
        raise RedlineGenerationError("redline_text is missing or empty")

    confidence_raw = parsed.get("confidence")
    try:
        confidence = float(confidence_raw)  # type: ignore[arg-type]
    except (TypeError, ValueError) as e:
        raise RedlineGenerationError(
            f"confidence is missing or not a number: {confidence_raw!r}"
        ) from e
    if math.isnan(confidence) or math.isinf(confidence):
        raise RedlineGenerationError(
            f"confidence is not finite: {confidence!r}"
        )
    if confidence < 0.0 or confidence > 1.0:
        raise RedlineGenerationError(
            f"confidence out of range [0, 1]: {confidence!r}"
        )

    rationale = parsed.get("rationale")
    if rationale is not None and not isinstance(rationale, str):
        raise RedlineGenerationError("rationale, if present, must be a string")
    if isinstance(rationale, str):
        rationale = rationale.strip() or None

    return GeneratedRedline(
        redline_text=redline_text.strip(),
        rationale=rationale,
        confidence=confidence,
    )


async def _record_first_remote_provider_use(
    session: AsyncSession,
    *,
    contract: Contract,
    actor_user_id: uuid.UUID | None,
    model_name: str,
) -> None:
    """Audit first-ever remote-provider use for an org.

    Mirrors the extraction service's helper of the same shape. A single
    event is emitted per organization across all LLM purposes; if
    extraction has already audited the first use, redline generation
    does not double-log.
    """
    stmt = (
        select(AuditEvent)
        .where(
            AuditEvent.organization_id == contract.organization_id,
            AuditEvent.event_type
            == AuditEventType.LLM_REMOTE_PROVIDER_ENABLED.value,
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
            "purpose": "redline_generation",
            "contract_id": str(contract.id),
        },
    )


# --------------------------------------------------------------------------
# Read helpers
# --------------------------------------------------------------------------


async def list_redlines_for_finding(
    session: AsyncSession,
    *,
    finding_id: uuid.UUID,
) -> list[SuggestedRedline]:
    """List redlines for a finding, newest first."""
    stmt = (
        select(SuggestedRedline)
        .where(SuggestedRedline.finding_id == finding_id)
        .order_by(
            SuggestedRedline.created_at.desc(),
            SuggestedRedline.id.desc(),
        )
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def get_redline_for_org(
    session: AsyncSession,
    *,
    redline_id: uuid.UUID,
    finding_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> SuggestedRedline | None:
    """Fetch one redline scoped to (finding, org)."""
    stmt = select(SuggestedRedline).where(
        SuggestedRedline.id == redline_id,
        SuggestedRedline.finding_id == finding_id,
        SuggestedRedline.organization_id == organization_id,
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()
