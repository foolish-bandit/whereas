"""Request and response schemas for the DocuSeal send flow."""
from __future__ import annotations

import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ApprovalGatePolicySummary(BaseModel):
    """Compact, UI-safe projection of an ``ApprovalPolicy`` row.

    Mirrors ``RequestApprovalPolicySummary`` (PR #56) intentionally so a
    client that already consumes the request approval visibility surface
    (`/api/requests/{id}/approval-status`) can reuse the same display
    code for the DocuSeal gate. ``description`` / ``metadata_json`` /
    ``created_by`` / ``created_at`` and storage / artifact fields are
    omitted by allowlist so a future column on :class:`ApprovalPolicy`
    cannot accidentally leak through this surface.
    """

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    name: str
    workflow_template_id: uuid.UUID
    auto_attach: bool
    applies_to_generated_contracts: bool
    request_type: str | None = None
    contract_type: str | None = None
    priority: str | None = None
    agreement_template_id: uuid.UUID | None = None


class ContractApprovalGateResponse(BaseModel):
    """Response shape for ``GET /api/contracts/{id}/approval-gate``.

    Backwards-compatible with the previous JSON: ``required_policy_ids``
    and ``missing_policy_ids`` remain present and unchanged. ``required_policies``
    and ``missing_policies`` are added so the UI can render policy
    *names* directly without an extra lookup. The two id lists and the
    two summary lists are derived from the same policy rows in the same
    order, so ``required_policy_ids[i]`` and ``required_policies[i].id``
    always match.

    No storage internals (``storage_key`` / ``wrapped_dek`` / ``s3_key``),
    no document bytes, no signer PII, no DocuSeal secrets are surfaced
    here — every field is on the allowlist below and ``extra="forbid"``
    rejects anything else.
    """

    model_config = ConfigDict(extra="forbid")

    allowed: bool
    code: str
    request_id: uuid.UUID | None
    blocking_workflow_ids: list[uuid.UUID] = Field(default_factory=list)
    completed_workflow_ids: list[uuid.UUID] = Field(default_factory=list)
    active_count: int
    rejected_count: int
    cancelled_count: int
    completed_count: int
    required_policy_ids: list[uuid.UUID] = Field(default_factory=list)
    missing_policy_ids: list[uuid.UUID] = Field(default_factory=list)
    required_policies: list[ApprovalGatePolicySummary] = Field(default_factory=list)
    missing_policies: list[ApprovalGatePolicySummary] = Field(default_factory=list)


class DocuSealSignerRequest(BaseModel):
    """One signer (DocuSeal "submitter") on a send-for-signature request.

    The shape mirrors DocuSeal's submitter payload: email + name +
    optional role label. ``role`` defaults to ``"signer"`` so callers
    that don't model multi-role submissions don't have to think about
    it. Anything beyond this is left to a future PR; we deliberately do
    not invent fields DocuSeal doesn't already accept.

    Email is validated lightly (must contain ``@`` and a non-empty
    label on each side) server-side rather than via ``EmailStr``, to
    avoid pulling in ``email-validator`` just for a signer label.
    DocuSeal itself is the authoritative validator for delivery.
    """

    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=255)
    name: str = Field(min_length=1, max_length=255)
    role: str = Field(default="signer", min_length=1, max_length=64)

    @field_validator("name", "role")
    @classmethod
    def _strip_whitespace(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("must not be blank")
        return cleaned

    @field_validator("email")
    @classmethod
    def _validate_email_shape(cls, value: str) -> str:
        cleaned = value.strip()
        if cleaned.count("@") != 1:
            raise ValueError("must look like an email address")
        local, _, domain = cleaned.partition("@")
        if not local or not domain or "." not in domain:
            raise ValueError("must look like an email address")
        return cleaned


class SendContractToDocuSealRequest(BaseModel):
    """Body of POST /api/contracts/{id}/send-to-docuseal."""

    model_config = ConfigDict(extra="forbid")

    signers: list[DocuSealSignerRequest] = Field(min_length=1, max_length=20)
    approval_override: bool = False
    approval_override_reason: str | None = Field(default=None, max_length=1000)


class SendContractToDocuSealResponse(BaseModel):
    """Response for a successful DocuSeal send.

    Carries the artifact identity that was sent (so the UI can mark the
    correct row), the DocuSeal submission id (when present), an embed
    URL when the upstream returned one, and an opaque ``raw`` projection
    of the upstream JSON for clients that want to render extra DocuSeal
    fields. Storage internals (storage_key, wrapped_dek, raw S3 keys)
    and the auth-bridge JWT are never echoed back.
    """

    model_config = ConfigDict(extra="forbid")

    contract_id: uuid.UUID
    artifact_id: uuid.UUID | None
    artifact_type: str | None
    filename: str | None
    submission_id: str | None
    status: str
    embed_url: str | None = None
    signer_count: int
    raw: dict[str, Any] | None = None
