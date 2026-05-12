"""Agreement template routes.

Templates are first-class CLM objects with the same dual representation
as contracts: an official ``original_upload`` artifact (DOCX/PDF) plus a
lightweight Markdown working snapshot for fast preview and future
local-first sync. This module deliberately keeps the upload path lean —
no extraction, no clause segmentation, no playbook review — because the
template surface only needs the original bytes plus a Markdown preview
in this PR.

Variable definitions are metadata only here; a later PR turns them into
filled DOCX agreements without touching this file.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, File, Header, HTTPException, Query, UploadFile
from sqlalchemy import select

from app.api.contracts import (
    DbSession,
    _current_dev_user,
    _load_org_key_or_http,
    _load_organization,
    _safe_input_filename,
    _validate_upload,
)
from app.core.config import get_settings
from app.models import (
    AgreementTemplate,
    AgreementTemplateArtifact,
    AgreementTemplateMarkdownSnapshot,
    AgreementTemplateStatus,
    AgreementTemplateVariable,
    User,
)
from app.schemas.agreement_templates import (
    AgreementGenerationRequest,
    AgreementGenerationResponse,
    AgreementTemplateArtifactResponse,
    AgreementTemplateCreateRequest,
    AgreementTemplateMarkdownSnapshotResponse,
    AgreementTemplateResponse,
    AgreementTemplateUpdateRequest,
    AgreementTemplateVariableCreateRequest,
    AgreementTemplateVariableResponse,
    AgreementTemplateVariableUpdateRequest,
    TemplateVariableSuggestionResponse,
)
from app.schemas.artifacts import ContractArtifactResponse
from app.schemas.contracts import ContractListItemResponse
from app.schemas.markdown import ContractMarkdownSnapshotResponse
from app.services.document_markdown import convert_document_to_markdown
from app.services.document_parser import (
    DocumentParseError,
    UnsupportedDocumentTypeError,
    parse_document,
)
from app.services.storage import DocumentStorage
from app.services.template_generation import (
    TemplateGenerationError,
    generate_docx_from_template,
)
from app.services.template_variable_detection import detect_variable_suggestions

log = logging.getLogger(__name__)

router = APIRouter()

_VALID_STATUSES = {s.value for s in AgreementTemplateStatus}


# ---------------------------------------------------------------------------
# Template CRUD
# ---------------------------------------------------------------------------


@router.post("", response_model=AgreementTemplateResponse, status_code=201)
async def create_agreement_template(
    payload: AgreementTemplateCreateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = AgreementTemplate(
        organization_id=user.organization_id,
        name=payload.name,
        description=payload.description,
        template_type=payload.template_type,
        status=AgreementTemplateStatus.ACTIVE.value,
        created_by=user.id,
        metadata_json=payload.metadata_json,
    )
    session.add(template)
    await session.flush()
    await session.refresh(template)
    return AgreementTemplateResponse.model_validate(template)


@router.get("", response_model=list[AgreementTemplateResponse])
async def list_agreement_templates(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    include_archived: bool = Query(default=False),
    template_type: str | None = None,
) -> list[AgreementTemplateResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = select(AgreementTemplate).where(
        AgreementTemplate.organization_id == user.organization_id
    )
    if not include_archived:
        stmt = stmt.where(
            AgreementTemplate.status == AgreementTemplateStatus.ACTIVE.value
        )
    if template_type:
        stmt = stmt.where(AgreementTemplate.template_type == template_type)
    stmt = stmt.order_by(
        AgreementTemplate.updated_at.desc(), AgreementTemplate.id.desc()
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [AgreementTemplateResponse.model_validate(r) for r in rows]


@router.get("/{template_id}", response_model=AgreementTemplateResponse)
async def get_agreement_template(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(session, template_id, user.organization_id)
    return AgreementTemplateResponse.model_validate(template)


@router.patch("/{template_id}", response_model=AgreementTemplateResponse)
async def update_agreement_template(
    template_id: uuid.UUID,
    payload: AgreementTemplateUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(session, template_id, user.organization_id)
    data = payload.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in _VALID_STATUSES:
        raise HTTPException(status_code=422, detail="Invalid template status.")
    for key, value in data.items():
        setattr(template, key, value)
    await session.flush()
    await session.refresh(template)
    return AgreementTemplateResponse.model_validate(template)


@router.delete("/{template_id}", status_code=204)
async def archive_agreement_template(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> None:
    """Soft delete: marks the template as archived but keeps history."""
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(session, template_id, user.organization_id)
    template.status = AgreementTemplateStatus.ARCHIVED.value
    await session.flush()


# ---------------------------------------------------------------------------
# Upload / artifacts / markdown
# ---------------------------------------------------------------------------


@router.post(
    "/{template_id}/upload",
    response_model=AgreementTemplateArtifactResponse,
    status_code=201,
)
async def upload_agreement_template_original(
    template_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementTemplateArtifactResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(session, template_id, user.organization_id)

    settings = get_settings()
    filename = _safe_input_filename(file.filename)
    file_bytes = await file.read()
    mime_type = _validate_upload(
        filename=filename,
        content_type=file.content_type,
        file_bytes=file_bytes,
        max_bytes=settings.CONTRACT_UPLOAD_MAX_BYTES,
    )
    file_hash = hashlib.sha256(file_bytes).hexdigest()

    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(settings)
    try:
        stored = await storage.store_encrypted(
            plaintext_bytes=file_bytes,
            document_id=f"template-{template.id}-{uuid.uuid4()}",
            org_master_key=org_master_key,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail="Could not store encrypted template."
        ) from e
    finally:
        del org_master_key

    artifact = AgreementTemplateArtifact(
        organization_id=user.organization_id,
        template_id=template.id,
        artifact_type="original_upload",
        storage_backend="s3",
        storage_key=stored.s3_key,
        wrapped_dek=stored.wrapped_dek_bytes,
        filename=filename,
        mime_type=mime_type,
        file_hash_sha256=file_hash,
        size_bytes=len(file_bytes),
        source="user_upload",
        is_official=True,
        created_by=user.id,
    )
    session.add(artifact)
    await session.flush()

    # Markdown working snapshot. Non-fatal — the upload still succeeds
    # if conversion fails. Use the existing parser as a fallback text
    # source so a malformed DOCX still lands a usable preview when the
    # parser can pull plain text out of it.
    fallback_text: str | None = None
    try:
        parsed = parse_document(file_bytes, filename)
        fallback_text = parsed.full_text
    except (DocumentParseError, UnsupportedDocumentTypeError):
        fallback_text = None
    except Exception:  # pragma: no cover - defensive
        log.exception(
            "Template parse failed; markdown will rely on converter only",
            extra={"template_id": str(template.id)},
        )
        fallback_text = None

    try:
        result = convert_document_to_markdown(
            file_bytes=file_bytes,
            mime_type=mime_type,
            filename=filename,
            fallback_plain_text=fallback_text,
        )
    except Exception:  # pragma: no cover - defensive
        log.exception(
            "Template markdown conversion raised; upload continues",
            extra={"template_id": str(template.id)},
        )
        result = None

    if result is not None and result.status == "ready" and result.markdown_text:
        snapshot = AgreementTemplateMarkdownSnapshot(
            organization_id=user.organization_id,
            template_id=template.id,
            markdown_text=result.markdown_text,
            source_kind="original_upload",
            converter_name=result.converter_name,
            converter_version=result.converter_version,
            conversion_status=result.status,
            conversion_warnings=list(result.warnings) if result.warnings else None,
            created_by=user.id,
        )
        session.add(snapshot)
        await session.flush()

    await session.refresh(artifact)
    return AgreementTemplateArtifactResponse.model_validate(artifact)


@router.get(
    "/{template_id}/artifacts",
    response_model=list[AgreementTemplateArtifactResponse],
)
async def list_agreement_template_artifacts(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[AgreementTemplateArtifactResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_template_for_org(session, template_id, user.organization_id)
    stmt = (
        select(AgreementTemplateArtifact)
        .where(
            AgreementTemplateArtifact.template_id == template_id,
            AgreementTemplateArtifact.organization_id == user.organization_id,
        )
        .order_by(
            AgreementTemplateArtifact.created_at.desc(),
            AgreementTemplateArtifact.id.desc(),
        )
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [AgreementTemplateArtifactResponse.model_validate(r) for r in rows]


@router.get(
    "/{template_id}/markdown",
    response_model=AgreementTemplateMarkdownSnapshotResponse,
)
async def get_agreement_template_markdown(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementTemplateMarkdownSnapshotResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_template_for_org(session, template_id, user.organization_id)
    stmt = (
        select(AgreementTemplateMarkdownSnapshot)
        .where(
            AgreementTemplateMarkdownSnapshot.template_id == template_id,
            AgreementTemplateMarkdownSnapshot.organization_id == user.organization_id,
            AgreementTemplateMarkdownSnapshot.conversion_status == "ready",
        )
        .order_by(AgreementTemplateMarkdownSnapshot.created_at.desc())
        .limit(1)
    )
    snapshot = (await session.execute(stmt)).scalar_one_or_none()
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Markdown snapshot not found.")
    return AgreementTemplateMarkdownSnapshotResponse.model_validate(snapshot)


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


@router.post(
    "/{template_id}/generate",
    response_model=AgreementGenerationResponse,
    status_code=201,
)
async def generate_agreement_from_template(
    template_id: uuid.UUID,
    payload: AgreementGenerationRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementGenerationResponse:
    """Render a DOCX from the template + variable values and persist it.

    Generation creates a *new* ``Contract`` row and stores the rendered
    DOCX as a ``generated_docx`` ``ContractArtifact``. The template's
    own ``original_upload`` artifact is NOT mutated. DocuSeal sending
    is intentionally out of scope for this PR — the resulting Contract
    is left in ``uploaded`` / ``ready`` state so a later flow can pick
    it up.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(
        session, template_id, user.organization_id
    )

    settings = get_settings()
    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(settings)
    try:
        result = await generate_docx_from_template(
            session,
            template=template,
            variable_values=payload.variable_values,
            generated_title=payload.title,
            user_id=user.id,
            org_master_key=org_master_key,
            storage=storage,
        )
    except TemplateGenerationError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail=str(exc)
        ) from exc
    finally:
        del org_master_key

    await session.refresh(result.contract)
    await session.refresh(result.artifact)
    snapshot_response: ContractMarkdownSnapshotResponse | None = None
    if result.markdown_snapshot is not None:
        await session.refresh(result.markdown_snapshot)
        snapshot_response = ContractMarkdownSnapshotResponse.model_validate(
            result.markdown_snapshot
        )
    return AgreementGenerationResponse(
        contract=ContractListItemResponse.model_validate(result.contract),
        artifact=ContractArtifactResponse.model_validate(result.artifact),
        markdown_snapshot=snapshot_response,
        variables_used=result.variables_used,
    )


# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------


@router.post(
    "/{template_id}/variables",
    response_model=AgreementTemplateVariableResponse,
    status_code=201,
)
async def create_agreement_template_variable(
    template_id: uuid.UUID,
    payload: AgreementTemplateVariableCreateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementTemplateVariableResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(session, template_id, user.organization_id)

    duplicate = (
        await session.execute(
            select(AgreementTemplateVariable.id).where(
                AgreementTemplateVariable.template_id == template.id,
                AgreementTemplateVariable.key == payload.key,
            )
        )
    ).first()
    if duplicate is not None:
        raise HTTPException(
            status_code=409,
            detail="A variable with this key already exists on the template.",
        )

    variable = AgreementTemplateVariable(
        organization_id=user.organization_id,
        template_id=template.id,
        **payload.model_dump(),
    )
    session.add(variable)
    await session.flush()
    await session.refresh(variable)
    return AgreementTemplateVariableResponse.model_validate(variable)


@router.get(
    "/{template_id}/variables",
    response_model=list[AgreementTemplateVariableResponse],
)
async def list_agreement_template_variables(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[AgreementTemplateVariableResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_template_for_org(session, template_id, user.organization_id)
    stmt = (
        select(AgreementTemplateVariable)
        .where(
            AgreementTemplateVariable.template_id == template_id,
            AgreementTemplateVariable.organization_id == user.organization_id,
        )
        .order_by(
            AgreementTemplateVariable.sort_order.asc(),
            AgreementTemplateVariable.created_at.asc(),
            AgreementTemplateVariable.id.asc(),
        )
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [AgreementTemplateVariableResponse.model_validate(r) for r in rows]


@router.get(
    "/{template_id}/variable-suggestions",
    response_model=list[TemplateVariableSuggestionResponse],
)
async def list_agreement_template_variable_suggestions(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[TemplateVariableSuggestionResponse]:
    """Deterministic ``{{placeholder}}`` detection on the Text preview (PR #96).

    Reads the latest *ready* ``AgreementTemplateMarkdownSnapshot`` for
    the template and runs a small regex extractor (see
    ``app.services.template_variable_detection``) to surface the bare
    identifiers between Jinja-style ``{{ … }}`` braces. Keys that
    already exist as ``AgreementTemplateVariable`` rows are filtered
    out server-side so the UI only renders *new* suggestions.

    Org-scoped: a template id from another org returns 404 via the
    same ``_get_template_for_org`` helper every other route here
    uses. If there is no markdown snapshot yet, the response is an
    empty list (a "no preview yet" state on the detail page —
    nothing to suggest, and not an error).

    The response carries only ``key`` / ``label`` / ``occurrences`` —
    no document bytes, no extracted-text snippets, no storage
    metadata. No LLM, no OCR, no remote service.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_template_for_org(session, template_id, user.organization_id)

    snapshot_stmt = (
        select(AgreementTemplateMarkdownSnapshot.markdown_text)
        .where(
            AgreementTemplateMarkdownSnapshot.template_id == template_id,
            AgreementTemplateMarkdownSnapshot.organization_id == user.organization_id,
            AgreementTemplateMarkdownSnapshot.conversion_status == "ready",
        )
        .order_by(AgreementTemplateMarkdownSnapshot.created_at.desc())
        .limit(1)
    )
    markdown_text = (await session.execute(snapshot_stmt)).scalar_one_or_none()
    if not markdown_text:
        return []

    existing_keys_stmt = select(AgreementTemplateVariable.key).where(
        AgreementTemplateVariable.template_id == template_id,
        AgreementTemplateVariable.organization_id == user.organization_id,
    )
    existing_keys = list((await session.execute(existing_keys_stmt)).scalars())

    suggestions = detect_variable_suggestions(
        markdown_text, exclude_keys=existing_keys
    )
    return [
        TemplateVariableSuggestionResponse(
            key=s.key, label=s.label, occurrences=s.occurrences
        )
        for s in suggestions
    ]


@router.patch(
    "/{template_id}/variables/{variable_id}",
    response_model=AgreementTemplateVariableResponse,
)
async def update_agreement_template_variable(
    template_id: uuid.UUID,
    variable_id: uuid.UUID,
    payload: AgreementTemplateVariableUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> AgreementTemplateVariableResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    variable = await _get_variable_for_org(
        session, template_id, variable_id, user.organization_id
    )
    data = payload.model_dump(exclude_unset=True)
    if "key" in data and data["key"] != variable.key:
        duplicate = (
            await session.execute(
                select(AgreementTemplateVariable.id).where(
                    AgreementTemplateVariable.template_id == template_id,
                    AgreementTemplateVariable.key == data["key"],
                    AgreementTemplateVariable.id != variable.id,
                )
            )
        ).first()
        if duplicate is not None:
            raise HTTPException(
                status_code=409,
                detail="A variable with this key already exists on the template.",
            )
    for key, value in data.items():
        setattr(variable, key, value)
    await session.flush()
    await session.refresh(variable)
    return AgreementTemplateVariableResponse.model_validate(variable)


@router.delete(
    "/{template_id}/variables/{variable_id}",
    status_code=204,
)
async def delete_agreement_template_variable(
    template_id: uuid.UUID,
    variable_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> None:
    user = await _current_dev_user(session, x_whereas_dev_user)
    variable = await _get_variable_for_org(
        session, template_id, variable_id, user.organization_id
    )
    await session.delete(variable)
    await session.flush()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_template_for_org(
    session,
    template_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> AgreementTemplate:
    stmt = select(AgreementTemplate).where(
        AgreementTemplate.id == template_id,
        AgreementTemplate.organization_id == organization_id,
    )
    template = (await session.execute(stmt)).scalar_one_or_none()
    if template is None:
        raise HTTPException(status_code=404, detail="Agreement template not found.")
    return template


async def _get_variable_for_org(
    session,
    template_id: uuid.UUID,
    variable_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> AgreementTemplateVariable:
    stmt = select(AgreementTemplateVariable).where(
        AgreementTemplateVariable.id == variable_id,
        AgreementTemplateVariable.template_id == template_id,
        AgreementTemplateVariable.organization_id == organization_id,
    )
    variable = (await session.execute(stmt)).scalar_one_or_none()
    if variable is None:
        raise HTTPException(
            status_code=404, detail="Agreement template variable not found."
        )
    return variable


__all__ = ["router", "User"]
