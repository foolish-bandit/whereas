"""DOCX generation from agreement templates.

Renders a filled DOCX from an ``AgreementTemplate`` and a set of
variable values, then persists the result as a brand-new draft
``Contract`` plus a ``ContractArtifact`` of type ``generated_docx``.

Architectural choice: a generated agreement is no longer just a
template artifact — it is the first version of a draft contract. So
the generation result is recorded as a Contract, not as another
``AgreementTemplateArtifact`` row. The original template upload is
never mutated; the draft is a fresh row that points back at the
template via ``ContractArtifact.metadata_json.template_id``.

DOCX rendering uses ``docxtpl`` with simple ``{{ variable_name }}``
placeholder syntax. ``docxtpl`` walks the underlying XML and rejoins
runs that span a placeholder, which plain text replacement cannot do
reliably — that robustness matters because Word frequently splits a
literal token across runs.

This module deliberately does not call DocuSeal. Sending generated
agreements for signature lives in a future PR.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import io
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import (
    AgreementTemplate,
    AgreementTemplateArtifact,
    AgreementTemplateVariable,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ContractStatus,
    Organization,
)
from app.security.encryption import (
    EncryptionError,
    WrappedKey,
    load_instance_key,
    load_org_master_key,
)
from app.services.document_markdown import convert_document_to_markdown
from app.services.storage import DocumentStorage

log = logging.getLogger(__name__)

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# Bound titles to a length the Contract.title column can hold.
_MAX_TITLE_LEN = 500


class TemplateGenerationError(Exception):
    """Base exception for template generation failures."""

    def __init__(self, message: str, *, http_status: int = 400) -> None:
        super().__init__(message)
        self.http_status = http_status


class TemplateValidationError(TemplateGenerationError):
    """Variable values failed validation. Maps to HTTP 400."""

    def __init__(self, message: str) -> None:
        super().__init__(message, http_status=400)


class TemplateSourceError(TemplateGenerationError):
    """The original template artifact is missing or unsupported.

    Maps to HTTP 400; the template exists but cannot be used to
    generate. The caller has already verified the template is in the
    user's org, so a 404 would be misleading.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message, http_status=400)


class TemplateRenderError(TemplateGenerationError):
    """DOCX rendering itself blew up. Maps to HTTP 500."""

    def __init__(self, message: str) -> None:
        super().__init__(message, http_status=500)


@dataclass
class GeneratedAgreementResult:
    """Outcome of a successful generation call.

    ``markdown_snapshot`` is ``None`` when conversion did not produce
    anything usable. The caller treats that as non-fatal: the DOCX
    artifact is the legal record; the markdown snapshot is just a
    preview.
    """

    contract: Contract
    artifact: ContractArtifact
    markdown_snapshot: ContractMarkdownSnapshot | None


# ---------------------------------------------------------------------------
# Variable validation
# ---------------------------------------------------------------------------


def _coerce_value(
    variable: AgreementTemplateVariable, raw: Any
) -> Any:
    """Validate a single variable value and return the rendered form.

    Validation is deliberately permissive but typed: the goal is
    "obviously wrong inputs are rejected at the API boundary," not
    "the legal document is type-safe." Most placeholder substitution
    works on strings; the returned value is what gets handed to the
    DOCX template context.
    """
    vtype = (variable.variable_type or "text").lower()

    if vtype == "boolean":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str) and raw.lower() in {"true", "false"}:
            return raw.lower() == "true"
        raise TemplateValidationError(
            f"Variable {variable.key!r} must be a boolean."
        )

    if vtype in {"number", "money"}:
        if isinstance(raw, bool):
            raise TemplateValidationError(
                f"Variable {variable.key!r} must be numeric."
            )
        if isinstance(raw, (int, float)):
            return raw
        if isinstance(raw, str):
            cleaned = raw.strip().replace(",", "")
            try:
                return float(cleaned) if "." in cleaned else int(cleaned)
            except ValueError as exc:
                raise TemplateValidationError(
                    f"Variable {variable.key!r} must be numeric."
                ) from exc
        raise TemplateValidationError(
            f"Variable {variable.key!r} must be numeric."
        )

    if vtype == "date":
        if isinstance(raw, str):
            cleaned = raw.strip()
            if not cleaned:
                raise TemplateValidationError(
                    f"Variable {variable.key!r} must be a non-empty date string."
                )
            # Accept ISO 8601 (YYYY-MM-DD) when easy; otherwise pass
            # the string through and let the user own the format.
            with contextlib.suppress(ValueError):
                dt.date.fromisoformat(cleaned)
            return cleaned
        raise TemplateValidationError(
            f"Variable {variable.key!r} must be a date string."
        )

    if vtype == "select":
        if not isinstance(raw, str):
            raise TemplateValidationError(
                f"Variable {variable.key!r} must be a string."
            )
        meta = variable.metadata_json or {}
        options = meta.get("options")
        if isinstance(options, list) and options and raw not in options:
            raise TemplateValidationError(
                f"Variable {variable.key!r} must be one of: {', '.join(map(str, options))}."
            )
        return raw

    # text / party / address / anything else: stringify safely.
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (int, float, bool)):
        return str(raw)
    raise TemplateValidationError(
        f"Variable {variable.key!r} must be a string."
    )


def validate_variable_values(
    variables: list[AgreementTemplateVariable],
    variable_values: dict[str, Any],
) -> dict[str, Any]:
    """Validate the input dict against the template's variables.

    Behavior:
      - Required variables must be present and non-empty.
      - Unknown keys are rejected (400). Tolerating unknowns silently
        would mask user typos and let stale UIs render placeholders
        the template no longer references.
      - Missing optional variables fall back to the variable's
        ``default_value`` if set, else an empty string. Empty strings
        in the rendered DOCX are preferable to leaving ``{{ key }}``
        text in the document.
    """
    by_key = {v.key: v for v in variables}
    rendered: dict[str, Any] = {}

    unknown = sorted(set(variable_values) - set(by_key))
    if unknown:
        raise TemplateValidationError(
            f"Unknown variable keys: {', '.join(unknown)}."
        )

    for variable in variables:
        if variable.key in variable_values:
            raw = variable_values[variable.key]
            if variable.required and (raw is None or raw == ""):
                raise TemplateValidationError(
                    f"Variable {variable.key!r} is required."
                )
            if raw is None or raw == "":
                rendered[variable.key] = variable.default_value or ""
                continue
            rendered[variable.key] = _coerce_value(variable, raw)
        else:
            if variable.required:
                raise TemplateValidationError(
                    f"Variable {variable.key!r} is required."
                )
            rendered[variable.key] = variable.default_value or ""

    return rendered


# ---------------------------------------------------------------------------
# DOCX rendering
# ---------------------------------------------------------------------------


def render_docx_bytes(
    template_bytes: bytes,
    context: dict[str, Any],
) -> bytes:
    """Render a DOCX template with a context dict.

    Uses ``docxtpl`` so placeholders that span multiple Word "runs"
    still resolve. Failures are wrapped in :class:`TemplateRenderError`
    so the API layer can return a single 500 with a clean message.
    """
    try:
        from docxtpl import DocxTemplate
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise TemplateRenderError(
            "docxtpl is not installed; cannot render template."
        ) from exc

    try:
        tpl = DocxTemplate(io.BytesIO(template_bytes))
        tpl.render(context)
        out = io.BytesIO()
        tpl.save(out)
        return out.getvalue()
    except TemplateRenderError:
        raise
    except Exception as exc:
        raise TemplateRenderError(
            f"Could not render DOCX template: {type(exc).__name__}"
        ) from exc


# ---------------------------------------------------------------------------
# Generation entry point
# ---------------------------------------------------------------------------


async def generate_docx_from_template(
    db: AsyncSession,
    *,
    template: AgreementTemplate,
    organization: Organization,
    variable_values: dict[str, Any],
    generated_title: str | None,
    user_id: uuid.UUID | None,
) -> GeneratedAgreementResult:
    """Generate a draft Contract + DOCX artifact from a template.

    Steps:
      1. Validate variable values against the template's variables.
      2. Resolve the latest official ``original_upload`` template
         artifact and verify it is a DOCX.
      3. Decrypt the template bytes.
      4. Render the DOCX with the validated context.
      5. Encrypt and store the rendered bytes.
      6. Insert a draft Contract whose canonical bytes point at the
         generated DOCX (Contract.s3_key/wrapped_dek/mime_type).
      7. Insert a ``generated_docx`` ContractArtifact row tied to the
         new contract, with template provenance in metadata_json.
      8. Best-effort markdown snapshot for the generated DOCX. A
         failure here does not fail the generation.

    The original template artifact is never mutated.
    """
    # Validation — load variables for org+template.
    variables_stmt = select(AgreementTemplateVariable).where(
        AgreementTemplateVariable.template_id == template.id,
        AgreementTemplateVariable.organization_id == template.organization_id,
    )
    variables = list((await db.execute(variables_stmt)).scalars().all())
    rendered_context = validate_variable_values(variables, variable_values)

    # Resolve latest official original_upload artifact.
    artifact_stmt = (
        select(AgreementTemplateArtifact)
        .where(
            AgreementTemplateArtifact.template_id == template.id,
            AgreementTemplateArtifact.organization_id == template.organization_id,
            AgreementTemplateArtifact.artifact_type == "original_upload",
            AgreementTemplateArtifact.is_official.is_(True),
        )
        .order_by(
            AgreementTemplateArtifact.created_at.desc(),
            AgreementTemplateArtifact.id.desc(),
        )
        .limit(1)
    )
    template_artifact = (
        await db.execute(artifact_stmt)
    ).scalar_one_or_none()
    if template_artifact is None or not template_artifact.storage_key:
        raise TemplateSourceError(
            "Template has no uploaded source. Upload a DOCX before generating."
        )
    if template_artifact.mime_type and template_artifact.mime_type != DOCX_MIME:
        raise TemplateSourceError(
            "Only DOCX templates can be used to generate draft agreements."
        )
    if template_artifact.wrapped_dek is None:
        # Templates uploaded before migration 0010 lack a wrapped DEK
        # and cannot be decrypted. Surface the operational fix without
        # leaking storage internals.
        raise TemplateSourceError(
            "Template was uploaded before generation was supported. "
            "Re-upload the original DOCX to enable generation."
        )

    # Decrypt template bytes.
    try:
        instance_key = load_instance_key()
        org_master_key = load_org_master_key(
            wrapped_master_key=WrappedKey.from_bytes(organization.wrapped_master_key),
            organization_id=str(organization.id),
            instance_key=instance_key,
        )
    except EncryptionError as exc:
        raise TemplateRenderError(
            "Encryption keys are not configured."
        ) from exc

    storage = DocumentStorage(get_settings())
    document_id = _template_document_id(template_artifact.storage_key, template.id)
    try:
        template_bytes = await storage.retrieve_decrypted(
            s3_key=template_artifact.storage_key,
            document_id=document_id,
            wrapped_dek_bytes=template_artifact.wrapped_dek,
            org_master_key=org_master_key,
        )
    except Exception as exc:
        raise TemplateRenderError(
            "Could not retrieve the template bytes for rendering."
        ) from exc
    finally:
        del org_master_key

    # Render the DOCX.
    rendered_bytes = render_docx_bytes(template_bytes, rendered_context)
    rendered_hash = hashlib.sha256(rendered_bytes).hexdigest()

    # Re-derive the org master key for storage; the previous one is
    # discarded to keep its lifetime scoped to retrieval.
    try:
        org_master_key = load_org_master_key(
            wrapped_master_key=WrappedKey.from_bytes(organization.wrapped_master_key),
            organization_id=str(organization.id),
            instance_key=load_instance_key(),
        )
    except EncryptionError as exc:
        raise TemplateRenderError(
            "Encryption keys are not configured."
        ) from exc

    title = _derive_generated_title(generated_title, template)

    contract = Contract(
        organization_id=template.organization_id,
        uploaded_by=user_id or _system_user_id(template),
        title=title,
        status=ContractStatus.DRAFT.value,
        s3_key="pending",
        mime_type=DOCX_MIME,
        file_hash_sha256=rendered_hash,
        page_count=None,
        full_text=None,
    )
    db.add(contract)
    await db.flush()

    try:
        stored = await storage.store_encrypted(
            plaintext_bytes=rendered_bytes,
            document_id=str(contract.id),
            org_master_key=org_master_key,
        )
    except Exception as exc:
        raise TemplateRenderError(
            "Could not store the generated DOCX."
        ) from exc
    finally:
        del org_master_key

    contract.s3_key = stored.s3_key
    contract.wrapped_dek = stored.wrapped_dek_bytes
    await db.flush()

    artifact = ContractArtifact(
        organization_id=template.organization_id,
        contract_id=contract.id,
        artifact_type="generated_docx",
        storage_backend="s3",
        storage_key=stored.s3_key,
        filename=_derive_generated_filename(title),
        mime_type=DOCX_MIME,
        file_hash_sha256=rendered_hash,
        size_bytes=len(rendered_bytes),
        source="template_generation",
        is_official=True,
        created_by=user_id,
        metadata_json={
            "template_id": str(template.id),
            "template_name": template.name,
            "template_type": template.template_type,
            # Surface the keys used so an auditor can see which variables
            # were filled, without persisting potentially sensitive raw
            # values in metadata_json.
            "variable_keys": sorted(rendered_context.keys()),
        },
    )
    db.add(artifact)
    await db.flush()

    snapshot = await _persist_markdown_snapshot(
        db,
        contract=contract,
        rendered_bytes=rendered_bytes,
        user_id=user_id,
    )

    return GeneratedAgreementResult(
        contract=contract, artifact=artifact, markdown_snapshot=snapshot
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _template_document_id(storage_key: str, template_id: uuid.UUID) -> str:
    """Recover the document_id used at template upload time.

    The upload path stored the template under
    ``documents/template-<template_id>-<random>.enc``. Decryption needs
    the same document_id that was passed to ``store_encrypted`` because
    GCM uses it as additional authenticated data. The basename without
    the ``.enc`` suffix is that exact identifier.
    """
    base = storage_key.rsplit("/", 1)[-1]
    if base.endswith(".enc"):
        base = base[: -len(".enc")]
    return base or f"template-{template_id}"


def _system_user_id(template: AgreementTemplate) -> uuid.UUID:
    """Fallback uploader id when the caller is anonymous (rare).

    The ``Contract.uploaded_by`` column is NOT NULL. In practice every
    request that reaches this service has a dev user, but the
    function signature allows ``user_id=None`` for service-driven
    flows. Falling back to ``template.created_by`` keeps the row
    valid and ties the draft to the template's author, which is the
    closest meaningful actor.
    """
    if template.created_by is not None:
        return template.created_by
    # Last resort: a synthetic UUID; the FK is to users.id, so this
    # would fail at flush time. Surface that as a TemplateRenderError
    # rather than a raw SQL violation.
    raise TemplateRenderError(
        "Cannot generate without an authenticated user; the template "
        "has no created_by to fall back to."
    )


def _derive_generated_title(
    explicit_title: str | None, template: AgreementTemplate
) -> str:
    """Pick a Contract.title for the generated draft.

    Priority:
      1. Caller-supplied title (trimmed and length-bounded).
      2. ``"<template name> — <UTC timestamp>"`` so multiple drafts
         from the same template are distinguishable in lists.
    """
    if explicit_title:
        cleaned = explicit_title.strip()
        if cleaned:
            return cleaned[:_MAX_TITLE_LEN]
    stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M UTC")
    return f"{template.name} — {stamp}"[:_MAX_TITLE_LEN]


def _derive_generated_filename(title: str) -> str:
    """Build a download-safe filename from the contract title."""
    import re

    base = re.sub(r"[^A-Za-z0-9._-]+", "_", title).strip("._") or "agreement"
    if not base.lower().endswith(".docx"):
        base = f"{base}.docx"
    return base[:180]


async def _persist_markdown_snapshot(
    db: AsyncSession,
    *,
    contract: Contract,
    rendered_bytes: bytes,
    user_id: uuid.UUID | None,
) -> ContractMarkdownSnapshot | None:
    """Best-effort markdown snapshot for the generated DOCX.

    Conversion failure is non-fatal: the DOCX is the legal record;
    the markdown snapshot is a preview. Logs the failure and returns
    ``None`` so the caller can carry on.
    """
    try:
        result = convert_document_to_markdown(
            file_bytes=rendered_bytes,
            mime_type=DOCX_MIME,
            filename=None,
            fallback_plain_text=None,
        )
    except Exception:  # pragma: no cover - defensive
        log.exception(
            "Markdown conversion raised for generated DOCX",
            extra={"contract_id": str(contract.id)},
        )
        return None

    if result.status != "ready" or not result.markdown_text:
        return None

    snapshot = ContractMarkdownSnapshot(
        contract_id=contract.id,
        organization_id=contract.organization_id,
        markdown_text=result.markdown_text,
        source_kind="generated",
        converter_name=result.converter_name,
        converter_version=result.converter_version,
        conversion_status=result.status,
        conversion_warnings=list(result.warnings) if result.warnings else None,
        created_by=user_id,
    )
    db.add(snapshot)
    try:
        await db.flush()
    except Exception:  # pragma: no cover - defensive
        log.exception(
            "Failed to persist markdown snapshot for generated DOCX",
            extra={"contract_id": str(contract.id)},
        )
        return None
    return snapshot
