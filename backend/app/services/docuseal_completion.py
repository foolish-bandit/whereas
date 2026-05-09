"""DocuSeal webhook completion handling.

Materializes a ``signed_pdf`` ``ContractArtifact`` when DocuSeal POSTs a
verified completion event for a submission Whereas previously sent.

Threat model / boundaries
-------------------------

* The DocuSeal peer service is on the same Postgres + same Docker
  Compose, but the webhook endpoint sits on the public side of the
  reverse proxy (it has to: DocuSeal calls it directly). Verification
  happens before this module is reached — see
  ``app.services.docuseal_bridge.verify_docuseal_webhook``.
* No PII (signer emails, name, party data) is persisted into
  ``ContractArtifact.metadata_json`` or the audit log. DocuSeal owns
  the submission record; Whereas owns the signed artifact and an
  audit-traceable pointer back.
* The signed PDF is encrypted at rest under the org master key. The
  per-artifact wrapped DEK lives on the ``ContractArtifact`` row, not
  ``Contract.wrapped_dek`` — see migration 0011.
"""
from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import (
    Contract,
    ContractArtifact,
    ContractStatus,
    Organization,
)
from app.security.audit_log import AuditEventType, record_event
from app.security.encryption import (
    EncryptionError,
    WrappedKey,
    load_instance_key,
    load_org_master_key,
)
from app.services.docuseal_bridge import (
    DocuSealError,
    get_signed_document_from_docuseal,
)
from app.services.storage import DocumentStorage

log = logging.getLogger(__name__)

SIGNED_PDF = "signed_pdf"
DOCUSEAL_SOURCE = "docuseal"
PDF_MIME = "application/pdf"

_SAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]+")

# Event-type values DocuSeal sends on a completed submission. The
# observed surface is ``submission.completed`` / ``form.completed``;
# legacy DocuSeal versions also emit ``completed``. Anything not in
# this set is ignored (e.g. ``submission.created``,
# ``submission.viewed``).
_COMPLETION_EVENTS = frozenset(
    {"submission.completed", "form.completed", "completed"}
)


class WebhookProcessingError(Exception):
    """A completion webhook could not be applied.

    Carries an HTTP status hint. 404 is reserved for "we have no
    contract for this submission id"; the route may choose to return
    202 instead to avoid retry storms from DocuSeal — that decision
    lives at the API layer.
    """

    status_code: int = 500

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


@dataclass
class CompletionResult:
    """What ``apply_completion_event`` did, for the route to render.

    ``status`` is one of:
      * ``"created"``    — a new ``signed_pdf`` artifact was created.
      * ``"duplicate"``  — a signed_pdf for this submission already
                           exists; nothing new written.
      * ``"ignored"``    — the event is not a completion type.
      * ``"unknown"``    — no contract matches the submission id.
    """

    status: str
    contract_id: uuid.UUID | None = None
    artifact_id: uuid.UUID | None = None
    submission_id: str | None = None


async def apply_completion_event(
    session: AsyncSession,
    *,
    payload: dict[str, Any],
) -> CompletionResult:
    """Process a verified DocuSeal webhook payload.

    Caller has already verified the request signature. This function:

      1. Decides whether the event is a completion type. Non-completion
         events are quietly ignored (returning ``"ignored"``).
      2. Resolves the contract by ``docuseal_submission_id``. If no
         contract matches, returns ``"unknown"`` so the route can
         answer 202 — DocuSeal occasionally sends events for
         submissions Whereas did not create.
      3. Idempotency: if a ``signed_pdf`` artifact for this contract
         and submission already exists, returns ``"duplicate"``
         without writing.
      4. Pulls the completed PDF bytes from DocuSeal, encrypts +
         stores them, writes the artifact + audit event, flips the
         contract status to ``EXECUTED``.

    The caller owns the transaction; this function only ``flush()``es.
    """
    event_type = _extract_event_type(payload)
    submission_id = _extract_submission_id(payload)
    if event_type not in _COMPLETION_EVENTS:
        return CompletionResult(status="ignored", submission_id=submission_id)
    if not submission_id:
        return CompletionResult(status="ignored")

    contract = await _find_contract_by_submission(session, submission_id)
    if contract is None:
        return CompletionResult(status="unknown", submission_id=submission_id)

    existing = await _existing_signed_artifact(
        session,
        contract_id=contract.id,
        organization_id=contract.organization_id,
        submission_id=submission_id,
    )
    if existing is not None:
        return CompletionResult(
            status="duplicate",
            contract_id=contract.id,
            artifact_id=existing.id,
            submission_id=submission_id,
        )

    org = await _load_org_or_raise(session, contract.organization_id)
    org_master_key = _load_org_master_key_or_raise(org)

    try:
        signed_bytes = await get_signed_document_from_docuseal(
            submission_id=submission_id,
            user_id=contract.uploaded_by,
            user_email="docuseal-webhook@whereas",
            organization_id=contract.organization_id,
        )
    except DocuSealError as exc:
        # Don't conflate "DocuSeal won't give us the file" with
        # "Whereas couldn't process the webhook"; surface 502 so
        # DocuSeal will retry.
        raise WebhookProcessingError(
            f"Could not retrieve signed document: {exc}",
            status_code=502,
        ) from exc

    storage = DocumentStorage(get_settings())
    document_id = f"contract-{contract.id}-signed-{uuid.uuid4()}"
    try:
        stored = await storage.store_encrypted(
            plaintext_bytes=signed_bytes,
            document_id=document_id,
            org_master_key=org_master_key,
        )
    except Exception as exc:
        raise WebhookProcessingError(
            "Could not store signed document.",
        ) from exc
    finally:
        del org_master_key

    file_hash = hashlib.sha256(signed_bytes).hexdigest()
    filename = _signed_pdf_filename(contract)
    metadata: dict[str, Any] = {
        "docuseal_submission_id": submission_id,
        "signed_at": _extract_signed_at(payload),
    }
    event_id = _extract_event_id(payload)
    if event_id is not None:
        metadata["docuseal_event_id"] = event_id

    artifact = ContractArtifact(
        organization_id=contract.organization_id,
        contract_id=contract.id,
        artifact_type=SIGNED_PDF,
        storage_backend="s3",
        storage_key=stored.s3_key,
        wrapped_dek=stored.wrapped_dek_bytes,
        filename=filename,
        mime_type=PDF_MIME,
        file_hash_sha256=file_hash,
        size_bytes=len(signed_bytes),
        source=DOCUSEAL_SOURCE,
        is_official=True,
        created_by=None,
        metadata_json=metadata,
    )
    session.add(artifact)
    await session.flush()
    # Best-effort: drop the local plaintext reference now that the
    # ciphertext is on S3 and the metadata row is in Postgres.
    del signed_bytes

    contract.status = ContractStatus.EXECUTED.value

    await record_event(
        session,
        organization_id=contract.organization_id,
        event_type=AuditEventType.CONTRACT_EXECUTED,
        actor_user_id=None,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "artifact_id": str(artifact.id),
            "filename": filename,
            "docuseal_submission_id": submission_id,
            "docuseal_event_id": event_id,
        },
    )

    return CompletionResult(
        status="created",
        contract_id=contract.id,
        artifact_id=artifact.id,
        submission_id=submission_id,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _find_contract_by_submission(
    session: AsyncSession, submission_id: str
) -> Contract | None:
    stmt = (
        select(Contract)
        .where(Contract.docuseal_submission_id == submission_id)
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _existing_signed_artifact(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
    submission_id: str,
) -> ContractArtifact | None:
    """Return any existing signed_pdf row for this contract+submission.

    Idempotency key is ``(contract_id, submission_id)``. We don't gate
    on event_id alone because DocuSeal may emit a completed event
    without a stable event id, and the same submission completing
    again would otherwise look "new" each time.
    """
    stmt = (
        select(ContractArtifact)
        .where(
            ContractArtifact.contract_id == contract_id,
            ContractArtifact.organization_id == organization_id,
            ContractArtifact.artifact_type == SIGNED_PDF,
        )
        .order_by(ContractArtifact.created_at.desc(), ContractArtifact.id.desc())
    )
    rows = (await session.execute(stmt)).scalars().all()
    for row in rows:
        meta = row.metadata_json or {}
        if meta.get("docuseal_submission_id") == submission_id:
            return row
    return None


async def _load_org_or_raise(
    session: AsyncSession, organization_id: uuid.UUID
) -> Organization:
    org = (
        await session.execute(
            select(Organization).where(Organization.id == organization_id)
        )
    ).scalar_one_or_none()
    if org is None:
        raise WebhookProcessingError(
            "Organization for contract not found.",
            status_code=500,
        )
    return org


def _load_org_master_key_or_raise(org: Organization) -> bytes:
    if org.wrapped_master_key is None:
        raise WebhookProcessingError(
            "Organization keys are not initialized.",
            status_code=409,
        )
    try:
        instance_key = load_instance_key()
    except EncryptionError as exc:
        raise WebhookProcessingError(
            "Encryption instance key is not configured.",
            status_code=500,
        ) from exc
    try:
        return load_org_master_key(
            wrapped_master_key=WrappedKey.from_bytes(org.wrapped_master_key),
            organization_id=str(org.id),
            instance_key=instance_key,
        )
    except (EncryptionError, ValueError) as exc:
        raise WebhookProcessingError(
            "Organization keys are not initialized.",
            status_code=409,
        ) from exc


def _signed_pdf_filename(contract: Contract) -> str:
    base = _SAFE_FILENAME_CHARS.sub("_", contract.title or "").strip("._")
    if not base:
        base = "contract"
    return f"{base}.signed.pdf"[:180]


def _extract_event_type(payload: dict[str, Any]) -> str | None:
    """DocuSeal sends ``event_type`` on newer versions; older versions
    sometimes use ``type`` or nest it under ``event``. Accept all."""
    for key in ("event_type", "type"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    nested = payload.get("event")
    if isinstance(nested, dict):
        nested_type = nested.get("type") or nested.get("event_type")
        if isinstance(nested_type, str) and nested_type.strip():
            return nested_type.strip()
    return None


def _extract_submission_id(payload: dict[str, Any]) -> str | None:
    """Find the submission id wherever DocuSeal puts it.

    Newer DocuSeal versions wrap the submission under ``data``; some
    legacy payloads include it at the top level.
    """
    candidates: list[Any] = []
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("submission_id", "id", "slug"):
            candidates.append(data.get(key))
        sub = data.get("submission")
        if isinstance(sub, dict):
            for key in ("id", "submission_id", "slug"):
                candidates.append(sub.get(key))
    for key in ("submission_id", "id", "slug"):
        candidates.append(payload.get(key))
    for candidate in candidates:
        if isinstance(candidate, (str, int)) and str(candidate).strip():
            return str(candidate)
    return None


def _extract_event_id(payload: dict[str, Any]) -> str | None:
    """Pull a DocuSeal-side event id, if present, for idempotency.

    Falls through to ``None`` rather than inventing one — the
    submission id is the load-bearing dedupe key.
    """
    for key in ("event_id", "id"):
        value = payload.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value)
    return None


def _extract_signed_at(payload: dict[str, Any]) -> str | None:
    for key in ("completed_at", "signed_at", "finished_at"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("completed_at", "signed_at", "finished_at"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return None


