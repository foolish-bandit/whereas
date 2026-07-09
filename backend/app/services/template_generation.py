"""DOCX generation from agreement templates and variable values.

This module is the seam between an ``AgreementTemplate`` (with its
``original_upload`` DOCX artifact and ``AgreementTemplateVariable``
definitions) and a draft agreement: a ``Contract`` row that owns a
``generated_docx`` ``ContractArtifact`` plus an optional Markdown
snapshot.

Architectural notes
-------------------

* Once an agreement is generated from a template it is no longer merely
  a template artifact — it is a draft agreement. We materialize a
  ``Contract`` row so the draft lives in the same repository, with the
  same download / review / extract surface, as any uploaded contract.
  The original template (artifact + Markdown + variables) is left
  untouched.
* Placeholder syntax is the docxtpl/Jinja form: ``{{counterparty_name}}``.
  We deliberately do not implement custom mini-language. docxtpl handles
  Word's split-run quirks for us, which a naive ``python-docx``
  replacement would mangle.
* Storage uses the existing ``DocumentStorage`` adapter; the generated
  bytes are encrypted under a fresh per-document DEK before they hit S3.
* Markdown conversion is non-fatal — when it fails the generation flow
  still succeeds with no snapshot row written.
* DocuSeal is intentionally out of scope for this PR. The generated
  ``Contract`` row is created in status ``UPLOADED`` and the caller can
  later wire a send flow on top.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from io import BytesIO
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
    ContractStatus,
)
from app.services.document_markdown import (
    convert_document_to_markdown,
    create_markdown_snapshot_for_contract,
)
from app.services.storage import DocumentStorage

log = logging.getLogger(__name__)

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
GENERATED_DOCX = "generated_docx"
TEMPLATE_GENERATION_SOURCE = "template_generation"


class TemplateGenerationError(Exception):
    """Base for all generation failures.

    Carries an HTTP status hint so the API layer can map errors uniformly
    without leaking implementation details.
    """

    status_code: int = 400

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


class MissingOriginalArtifactError(TemplateGenerationError):
    """No ``original_upload`` artifact exists for the template."""

    status_code = 409


class UnsupportedSourceTypeError(TemplateGenerationError):
    """The original template artifact is not a DOCX file."""

    status_code = 400


class VariableValidationError(TemplateGenerationError):
    """Required, unknown, or malformed variable values."""

    status_code = 400


@dataclass
class GeneratedAgreementResult:
    """Outcome of a successful generation flow."""

    contract: Contract
    artifact: ContractArtifact
    markdown_snapshot: Any | None = None
    variables_used: list[str] = field(default_factory=list)


async def generate_docx_from_template(
    db: AsyncSession,
    *,
    template: AgreementTemplate,
    variable_values: dict[str, Any],
    generated_title: str | None,
    user_id: uuid.UUID | None,
    org_master_key: bytes,
    storage: DocumentStorage,
) -> GeneratedAgreementResult:
    """Render a DOCX from the template's original upload + values, persist it.

    Steps:
      1. Resolve the latest official ``original_upload`` artifact.
      2. Decrypt and validate that it's a DOCX.
      3. Validate variable values against the template's variable rows.
      4. Render the DOCX via docxtpl.
      5. Encrypt + upload the rendered bytes via ``DocumentStorage``.
      6. Create a ``Contract`` row plus a ``generated_docx``
         ``ContractArtifact``.
      7. Best-effort Markdown snapshot.

    The caller owns the transaction. The storage encryption happens
    inside this function, but DB inserts are added to the supplied
    session and flushed; commit is the caller's responsibility.
    """
    artifact = await _latest_original_upload(db, template)
    if artifact is None:
        raise MissingOriginalArtifactError(
            "Upload an original DOCX template before generating an agreement."
        )
    if artifact.storage_key is None or artifact.wrapped_dek is None:
        raise MissingOriginalArtifactError(
            "Original template is missing storage metadata; re-upload required."
        )
    if not _is_docx(artifact.mime_type, artifact.filename):
        raise UnsupportedSourceTypeError(
            "DOCX generation requires a DOCX source template."
        )

    variables = await _load_variables(db, template)
    cleaned_values, used_keys = _validate_variable_values(
        variables, variable_values
    )

    template_bytes = await storage.retrieve_decrypted(
        s3_key=artifact.storage_key,
        document_id=f"template-artifact-{artifact.id}",
        wrapped_dek_bytes=artifact.wrapped_dek,
        org_master_key=org_master_key,
    )

    # docxtpl/Jinja rendering is CPU-bound; keep it off the event loop.
    rendered_bytes = await asyncio.to_thread(_render_docx, template_bytes, cleaned_values)
    file_hash = hashlib.sha256(rendered_bytes).hexdigest()

    contract = Contract(
        organization_id=template.organization_id,
        uploaded_by=user_id or _system_user_placeholder(template),
        title=_derive_generated_title(generated_title, template),
        status=ContractStatus.UPLOADED.value,
        s3_key="pending",
        mime_type=DOCX_MIME,
        file_hash_sha256=file_hash,
        page_count=None,
        full_text=None,
    )
    db.add(contract)
    await db.flush()

    document_id = f"contract-{contract.id}-generated-{uuid.uuid4()}"
    stored = await storage.store_encrypted(
        plaintext_bytes=rendered_bytes,
        document_id=document_id,
        org_master_key=org_master_key,
    )
    contract.s3_key = stored.s3_key
    contract.wrapped_dek = stored.wrapped_dek_bytes
    contract.status = ContractStatus.READY.value

    # Privacy: we persist the keys that were used and which were left
    # blank, but NOT the plaintext values. The values are already in the
    # rendered DOCX (encrypted at rest under the org master key, only
    # served via the authenticated contract download). Duplicating them
    # into metadata_json would put potentially sensitive contract data
    # — counterparty names, dates, dollar amounts — into a JSON column
    # that is easier to leak through casual queries, exports, and logs.
    # If a caller wants what was rendered, they should fetch the DOCX.
    metadata: dict[str, Any] = {
        "template_id": str(template.id),
        "template_name": template.name,
        "variable_keys": sorted(used_keys),
        "variable_keys_blank": sorted(set(cleaned_values) - used_keys),
        "generated_at": datetime.now(UTC).isoformat(),
    }

    contract_artifact = ContractArtifact(
        organization_id=template.organization_id,
        contract_id=contract.id,
        artifact_type=GENERATED_DOCX,
        storage_backend="s3",
        storage_key=stored.s3_key,
        filename=_derive_generated_filename(contract.title),
        mime_type=DOCX_MIME,
        file_hash_sha256=file_hash,
        size_bytes=len(rendered_bytes),
        source=TEMPLATE_GENERATION_SOURCE,
        is_official=True,
        created_by=user_id,
        metadata_json=metadata,
    )
    db.add(contract_artifact)
    await db.flush()

    snapshot = None
    try:
        snapshot = await create_markdown_snapshot_for_contract(
            db,
            contract=contract,
            file_bytes=rendered_bytes,
            fallback_plain_text=_extract_plain_text_for_fallback(rendered_bytes),
            actor_user_id=user_id,
            source_kind="generated",
        )
    except Exception:  # pragma: no cover - defensive; helper itself swallows
        log.exception(
            "Markdown snapshot creation failed for generated contract",
            extra={"contract_id": str(contract.id)},
        )
        snapshot = None

    return GeneratedAgreementResult(
        contract=contract,
        artifact=contract_artifact,
        markdown_snapshot=snapshot,
        variables_used=sorted(used_keys),
    )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_variable_values(
    variables: list[AgreementTemplateVariable],
    submitted: dict[str, Any],
) -> tuple[dict[str, Any], set[str]]:
    """Coerce + validate submitted values against template variable rows.

    Returns the cleaned mapping (key -> python-typed value, ready to feed
    docxtpl) and the set of variable keys that were referenced. Raises
    ``VariableValidationError`` on the first failure with a message safe
    to surface.
    """
    if not isinstance(submitted, dict):
        raise VariableValidationError("variable_values must be an object.")

    known: dict[str, AgreementTemplateVariable] = {v.key: v for v in variables}
    unknown = sorted(set(submitted.keys()) - set(known.keys()))
    if unknown:
        raise VariableValidationError(
            f"Unknown variable(s): {', '.join(unknown)}."
        )

    cleaned: dict[str, Any] = {}
    used: set[str] = set()
    for var in variables:
        provided = submitted.get(var.key, _MISSING)
        value = (
            provided
            if provided is not _MISSING
            else _default_for(var)
        )
        if _is_empty(value):
            if var.required:
                raise VariableValidationError(
                    f"Missing required variable: {var.key}."
                )
            cleaned[var.key] = ""
            continue
        cleaned[var.key] = _coerce_value(var, value)
        used.add(var.key)
    return cleaned, used


_MISSING = object()


def _default_for(var: AgreementTemplateVariable) -> Any:
    return var.default_value if var.default_value is not None else _MISSING


def _is_empty(value: Any) -> bool:
    if value is _MISSING or value is None:
        return True
    return isinstance(value, str) and value.strip() == ""


def _coerce_value(var: AgreementTemplateVariable, value: Any) -> Any:
    """Best-effort type coercion. Validation rules are deliberately small.

    The goal here is to catch the obviously-wrong cases (a string where a
    number was promised, a bogus YYYY-MM-DD) while still letting the
    template author keep the variable taxonomy free-form. Rich validation
    belongs in a follow-up.
    """
    var_type = (var.variable_type or "text").lower()
    if var_type == "text":
        return str(value)
    if var_type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in {"true", "false"}:
            return value.lower() == "true"
        raise VariableValidationError(
            f"Variable {var.key!r} expects a boolean."
        )
    if var_type in {"number", "money"}:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
        if isinstance(value, str):
            try:
                if "." in value:
                    return float(value)
                return int(value)
            except ValueError as exc:
                raise VariableValidationError(
                    f"Variable {var.key!r} expects a numeric value."
                ) from exc
        raise VariableValidationError(
            f"Variable {var.key!r} expects a numeric value."
        )
    if var_type == "date":
        if not isinstance(value, str):
            raise VariableValidationError(
                f"Variable {var.key!r} expects a YYYY-MM-DD date string."
            )
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise VariableValidationError(
                f"Variable {var.key!r} expects a YYYY-MM-DD date string."
            ) from exc
        return value
    if var_type == "select":
        text = str(value)
        options = _select_options(var)
        if options is not None and text not in options:
            raise VariableValidationError(
                f"Variable {var.key!r} value must be one of: "
                f"{', '.join(options)}."
            )
        return text
    # Fallback: stringify. Keeps the gate at "did the caller send something"
    # without pinning the variable taxonomy in v1.
    return str(value)


def _select_options(var: AgreementTemplateVariable) -> list[str] | None:
    meta = var.metadata_json or {}
    raw = meta.get("options")
    if isinstance(raw, list):
        cleaned = [str(o) for o in raw if isinstance(o, (str, int, float))]
        return cleaned or None
    return None


# ---------------------------------------------------------------------------
# DOCX rendering
# ---------------------------------------------------------------------------


def _render_docx(template_bytes: bytes, values: dict[str, Any]) -> bytes:
    """Render a DOCX with docxtpl. Imported lazily to keep startup light.

    Trust model:
      * The DOCX template itself is operator-uploaded — the same trust
        level as any code or playbook YAML the operator stores in the
        system. Jinja filters / for-loops authored inside the template
        are accepted as features.
      * Variable VALUES are caller-supplied and may contain
        Jinja-looking text. docxtpl inserts them as literal strings;
        they are not re-rendered. The end-to-end test
        ``test_docxtpl_renders_runs_split_across_xml`` plus the
        adversarial-value smoke check ensure this stays true.

    Missing placeholder behavior is deterministic: Jinja's default
    Undefined renders absent keys as the empty string. Required
    variables are gated upstream in ``_validate_variable_values``.
    """
    try:
        from docxtpl import DocxTemplate  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - guarded by deps
        raise TemplateGenerationError(
            "DOCX generation library is not installed.",
            status_code=500,
        ) from exc

    src = BytesIO(template_bytes)
    out = BytesIO()
    try:
        doc = DocxTemplate(src)
        doc.render(values)
        doc.save(out)
    except Exception as exc:
        raise TemplateGenerationError(
            f"Could not render DOCX: {type(exc).__name__}.",
            status_code=400,
        ) from exc
    return out.getvalue()


def _extract_plain_text_for_fallback(docx_bytes: bytes) -> str | None:
    """Pull plain-text out of the rendered DOCX so the Markdown fallback
    path can produce *something* even if MarkItDown isn't installed.

    Best effort; failure silently falls back to ``None``.
    """
    try:
        import zipfile
        from xml.etree import ElementTree as ET

        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        with zipfile.ZipFile(BytesIO(docx_bytes)) as archive:
            # Decompression-bomb guard: mirrors the check applied to
            # uploaded DOCX files, applied here too since this reads
            # the rendered output back out of a zip archive.
            total_uncompressed = sum(info.file_size for info in archive.infolist())
            if total_uncompressed > get_settings().DOCX_MAX_UNCOMPRESSED_BYTES:
                return None
            try:
                xml = archive.read("word/document.xml")
            except KeyError:
                return None
        root = ET.fromstring(xml)
        paragraphs = []
        for p in root.iter(f"{ns}p"):
            text_parts = [t.text or "" for t in p.iter(f"{ns}t")]
            joined = "".join(text_parts).strip()
            if joined:
                paragraphs.append(joined)
        if not paragraphs:
            return None
        return "\n\n".join(paragraphs)
    except Exception:  # pragma: no cover - defensive
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _latest_original_upload(
    db: AsyncSession, template: AgreementTemplate
) -> AgreementTemplateArtifact | None:
    stmt = (
        select(AgreementTemplateArtifact)
        .where(
            AgreementTemplateArtifact.template_id == template.id,
            AgreementTemplateArtifact.organization_id == template.organization_id,
            AgreementTemplateArtifact.artifact_type == "original_upload",
            AgreementTemplateArtifact.is_official.is_(True),
        )
        .order_by(AgreementTemplateArtifact.created_at.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _load_variables(
    db: AsyncSession, template: AgreementTemplate
) -> list[AgreementTemplateVariable]:
    stmt = (
        select(AgreementTemplateVariable)
        .where(
            AgreementTemplateVariable.template_id == template.id,
            AgreementTemplateVariable.organization_id == template.organization_id,
        )
        .order_by(
            AgreementTemplateVariable.sort_order.asc(),
            AgreementTemplateVariable.created_at.asc(),
        )
    )
    return list((await db.execute(stmt)).scalars().all())


def _is_docx(mime_type: str | None, filename: str | None) -> bool:
    if mime_type and mime_type == DOCX_MIME:
        return True
    return bool(filename and filename.lower().endswith(".docx"))


def _derive_generated_title(
    generated_title: str | None, template: AgreementTemplate
) -> str:
    cleaned = (generated_title or "").strip()
    if cleaned:
        return cleaned[:500]
    timestamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    return f"{template.name} — generated {timestamp}"[:500]


def _derive_generated_filename(title: str) -> str:
    import re

    base = re.sub(r"[^A-Za-z0-9._-]+", "_", title).strip("._") or "agreement"
    if not base.lower().endswith(".docx"):
        base = f"{base}.docx"
    return base[:180]


def _system_user_placeholder(template: AgreementTemplate) -> uuid.UUID:
    """Fall back to the template's creator when no caller is provided.

    The Contract.uploaded_by FK is NOT NULL. In practice an authenticated
    request always supplies a user; this branch only exists for offline /
    backfill code paths and is guarded behind ``user_id is None``.
    """
    if template.created_by is not None:
        return template.created_by
    raise TemplateGenerationError(
        "Cannot generate without a user — template has no creator.",
        status_code=409,
    )


# Re-exporting these so the ad-hoc 'convert_document_to_markdown' import
# isn't needed by callers that only need "happy path generation".
__all__ = [
    "GeneratedAgreementResult",
    "MissingOriginalArtifactError",
    "TemplateGenerationError",
    "UnsupportedSourceTypeError",
    "VariableValidationError",
    "convert_document_to_markdown",
    "generate_docx_from_template",
]
