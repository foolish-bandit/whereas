"""ORM models for Whereas.

Design notes:
- Every extracted fact lives in `ExtractedField` with a span reference back to source.
- Clauses are stored separately from raw document text so we can re-segment without
  losing user annotations.
- Contracts have versions; uploads create new versions, not mutations.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


# ------------------------------------------------------------------
# Identity
# ------------------------------------------------------------------


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Per-org master key, wrapped under WHEREAS_INSTANCE_KEY. The plaintext
    # master key is never stored; it is generated, wrapped, and persisted here
    # by `app.security.encryption.create_org_master_key` when the org is
    # created. Currently nullable because (a) the org-creation flow that calls
    # `create_org_master_key` has not yet been wired up and (b) any orgs that
    # exist before that flow lands won't have a wrapped key. A follow-up
    # migration will backfill and tighten this to NOT NULL.
    wrapped_master_key: Mapped[bytes | None] = mapped_column(
        LargeBinary,
        nullable=True,
        comment=(
            "Wrapped under WHEREAS_INSTANCE_KEY via "
            "app.security.encryption.create_org_master_key. NULL only for orgs "
            "created before key wrapping was wired up; will be backfilled."
        ),
    )

    users: Mapped[list[User]] = relationship(back_populates="organization")


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_admin: Mapped[bool] = mapped_column(default=False)
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    organization: Mapped[Organization] = relationship(back_populates="users")


# ------------------------------------------------------------------
# Contracts
# ------------------------------------------------------------------


class ContractStatus(str, Enum):
    UPLOADED = "uploaded"
    EXTRACTING = "extracting"
    READY = "ready"
    FAILED = "failed"
    SENT_FOR_SIGNATURE = "sent_for_signature"
    EXECUTED = "executed"


class Contract(Base):
    __tablename__ = "contracts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True
    )
    uploaded_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=ContractStatus.UPLOADED.value, nullable=False, index=True
    )

    # Storage references
    s3_key: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    file_hash_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    page_count: Mapped[int | None] = mapped_column(Integer)

    # Full extracted text (for search and RAG)
    full_text: Mapped[str | None] = mapped_column(Text)

    # DocuSeal linkage
    docuseal_submission_id: Mapped[str | None] = mapped_column(String(128))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    extracted_fields: Mapped[list[ExtractedField]] = relationship(
        back_populates="contract", cascade="all, delete-orphan"
    )
    clauses: Mapped[list[Clause]] = relationship(
        back_populates="contract", cascade="all, delete-orphan"
    )
    deviation_findings: Mapped[list[DeviationFinding]] = relationship(
        back_populates="contract", cascade="all, delete-orphan"
    )


# ------------------------------------------------------------------
# Extracted metadata
# ------------------------------------------------------------------


class ExtractedField(Base):
    """A single piece of metadata extracted from a contract.

    Every field carries:
    - The extracted value (typed loosely as JSON to handle dates, money, lists, etc.)
    - A span citation back to the source (character offsets in `Contract.full_text`)
    - A confidence score from the extraction model
    - The model and prompt version that produced it (for reproducibility)
    """
    __tablename__ = "extracted_fields"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    contract_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contracts.id"), nullable=False, index=True
    )

    field_name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    # e.g., "parties", "effective_date", "term_months", "governing_law", "contract_value"

    value_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    # Structured value. For dates, use ISO 8601 strings. For money, {"amount": ..., "currency": ...}.

    # Span citation: character offsets into Contract.full_text
    span_start: Mapped[int | None] = mapped_column(Integer)
    span_end: Mapped[int | None] = mapped_column(Integer)
    span_text: Mapped[str | None] = mapped_column(Text)
    # Storing span_text redundantly because contract.full_text may change if we re-OCR.

    confidence: Mapped[float] = mapped_column(Float, nullable=False)

    # Provenance
    model_name: Mapped[str] = mapped_column(String(128), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(32), nullable=False)
    extracted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # User overrides
    overridden_value_json: Mapped[dict | None] = mapped_column(JSON)
    overridden_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    overridden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    contract: Mapped[Contract] = relationship(back_populates="extracted_fields")

    __table_args__ = (
        UniqueConstraint("contract_id", "field_name", name="uq_extracted_field_per_contract"),
    )


# ------------------------------------------------------------------
# Clauses
# ------------------------------------------------------------------


class Clause(Base):
    """A segmented and classified clause from a contract.

    Clauses are produced by the segmentation + classification pipeline.
    Each clause has an embedding for similarity search and RAG.
    """
    __tablename__ = "clauses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    contract_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contracts.id"), nullable=False, index=True
    )

    # Position in the document
    span_start: Mapped[int] = mapped_column(Integer, nullable=False)
    span_end: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)

    # Classification (CUAD taxonomy by default)
    clause_type: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    classification_confidence: Mapped[float] = mapped_column(Float, nullable=False)

    # Embedding for RAG and similarity search
    # BGE-M3 produces 1024-dim vectors. If you change models, write a migration.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    contract: Mapped[Contract] = relationship(back_populates="clauses")


# ------------------------------------------------------------------
# Playbooks
# ------------------------------------------------------------------


class Playbook(Base):
    """A YAML-defined library of firm positions on contract terms."""
    __tablename__ = "playbooks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    yaml_source: Mapped[str] = mapped_column(Text, nullable=False)
    parsed_rules: Mapped[dict] = mapped_column(JSON, nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DeviationSeverity(str, Enum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    BLOCKER = "blocker"


class DeviationFinding(Base):
    """A single deviation between a contract's clauses and a playbook's positions."""
    __tablename__ = "deviation_findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    contract_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contracts.id"), nullable=False, index=True
    )
    playbook_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("playbooks.id"), nullable=False
    )
    clause_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("clauses.id")
    )

    rule_id: Mapped[str] = mapped_column(String(128), nullable=False)  # from the playbook YAML
    severity: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    suggested_redline: Mapped[str | None] = mapped_column(Text)

    # Provenance
    model_name: Mapped[str] = mapped_column(String(128), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)

    # User actions
    dismissed: Mapped[bool] = mapped_column(default=False)
    dismissed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    dismissed_reason: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    contract: Mapped[Contract] = relationship(back_populates="deviation_findings")
