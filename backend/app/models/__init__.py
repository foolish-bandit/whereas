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
from enum import StrEnum

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Index,
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


class ContractStatus(StrEnum):
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
    wrapped_dek: Mapped[bytes | None] = mapped_column(
        LargeBinary,
        nullable=True,
        comment=(
            "Serialized WrappedKey for the per-document DEK: nonce || ciphertext "
            "from app.security.encryption.WrappedKey.to_bytes(), wrapping the "
            "document DEK under the organization master key."
        ),
    )
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
    playbook_review_runs: Mapped[list[PlaybookReviewRun]] = relationship(
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
    """A segmented (and optionally classified) clause from a contract.

    Each row is grounded in `contracts.full_text`: the invariant
    `Contract.full_text[span_start:span_end] == Clause.text` MUST hold,
    enforced at persistence time by `clause_segmentation`. Spans are
    character offsets into the same canonical string the metadata
    extractor uses, so highlights compose with extraction citations.

    The `embedding` column is reserved for a future RAG layer; v1 leaves
    it unset.
    """
    __tablename__ = "clauses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    contract_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contracts.id"), nullable=False, index=True
    )

    # Stable position within the contract (0-based, monotonically increasing).
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    heading: Mapped[str | None] = mapped_column(String(500))

    # Position in the document
    span_start: Mapped[int] = mapped_column(Integer, nullable=False)
    span_end: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)

    # Optional classification. `clause_type_source` records how the label
    # was produced (e.g. "heuristic", "llm", "cuad_taxonomy") so callers
    # can weigh it. v1 only emits "heuristic" or null.
    clause_type: Mapped[str | None] = mapped_column(String(64), index=True)
    clause_type_source: Mapped[str | None] = mapped_column(String(32))
    confidence: Mapped[float | None] = mapped_column(Float)

    # Provenance. `segmentation_method` is required so a future re-run can
    # tell which clauses came from which strategy version.
    segmentation_method: Mapped[str] = mapped_column(String(32), nullable=False)
    model_name: Mapped[str | None] = mapped_column(String(128))
    prompt_version: Mapped[str | None] = mapped_column(String(32))

    # Reserved for the future RAG layer; BGE-M3 = 1024 dims.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    contract: Mapped[Contract] = relationship(back_populates="clauses")

    __table_args__ = (
        UniqueConstraint("contract_id", "ordinal", name="uq_clauses_contract_ordinal"),
        Index("ix_clauses_org_contract", "organization_id", "contract_id"),
    )


# ------------------------------------------------------------------
# Playbooks
# ------------------------------------------------------------------


class Playbook(Base):
    """A YAML-defined library of firm positions on contract terms.

    Playbooks are organization-scoped. `yaml_source` is the verbatim YAML
    the user submitted (so the editor can round-trip without losing
    formatting); `parsed_rules` is the validated, normalized projection
    used by downstream rule matching. The two are kept in sync at write
    time only — re-validating an existing playbook never rewrites
    `yaml_source`.

    The `is_active` flag is a soft toggle. Future deviation analysis
    will only apply rules from active playbooks; deactivating a
    playbook does not delete it or its prior findings.
    """
    __tablename__ = "playbooks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    jurisdiction: Mapped[str | None] = mapped_column(String(128))
    contract_type: Mapped[str | None] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(32), nullable=False, default="1.0")
    yaml_source: Mapped[str] = mapped_column(Text, nullable=False)
    parsed_rules: Mapped[dict] = mapped_column(JSON, nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_playbooks_organization_id", "organization_id"),
        Index("ix_playbooks_org_name", "organization_id", "name"),
        Index("ix_playbooks_org_active", "organization_id", "is_active"),
    )


class DeviationSeverity(StrEnum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    BLOCKER = "blocker"


class FindingStatus(StrEnum):
    """Human-workflow state of a persisted deterministic finding.

    `OPEN` is the entry state; reviewers can mark a finding `REVIEWED`
    (acknowledged) or `IGNORED` (deliberately set aside). `SUPERSEDED`
    is reserved for the rerun path: when a new review run lands for the
    same (contract, playbook), prior `OPEN` findings transition to
    `SUPERSEDED` so the latest run is the source of truth without
    losing the audit trail. Reviewer decisions (`REVIEWED`, `IGNORED`)
    are deliberately *not* superseded — those are explicit human
    judgements and re-running the same playbook should not reset them.
    """

    OPEN = "open"
    REVIEWED = "reviewed"
    IGNORED = "ignored"
    SUPERSEDED = "superseded"


class PlaybookReviewRun(Base):
    """One execution of a playbook against a contract's segmented clauses.

    A review run is the durable audit of *when* a contract was reviewed
    against a particular playbook. The aggregate counts
    (`rules_checked`, `passed_count`, `failed_count`) are stored on the
    run; per-rule failures are stored as `DeviationFinding` rows
    pointing back at this run via `review_run_id`.

    Pass results are *not* persisted as separate rows — the matcher is
    deterministic, so anyone who needs the full per-rule pass/fail list
    for a historical run can re-run the matcher against the same
    (contract, playbook). The run record itself is what audits "we did
    review this contract on date X".
    """

    __tablename__ = "playbook_review_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=_uuid
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    contract_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("contracts.id", ondelete="CASCADE"),
        nullable=False,
    )
    playbook_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("playbooks.id"), nullable=False
    )
    rules_checked: Mapped[int] = mapped_column(Integer, nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False)
    passed_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    contract: Mapped[Contract] = relationship(back_populates="playbook_review_runs")
    findings: Mapped[list[DeviationFinding]] = relationship(
        back_populates="review_run", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_playbook_review_runs_org", "organization_id"),
        Index("ix_playbook_review_runs_contract", "contract_id"),
        Index(
            "ix_playbook_review_runs_contract_playbook",
            "contract_id",
            "playbook_id",
        ),
        Index("ix_playbook_review_runs_created_at", "created_at"),
    )


class DeviationFinding(Base):
    """A single failed deterministic rule outcome from a playbook review.

    Findings are written from the deterministic matcher
    (`app.services.playbook_matcher.match_playbook`) against the
    contract's segmented clauses. **Only failures are persisted** —
    pass results would be one-row-per-rule noise that no reviewer
    triages, and the parent `PlaybookReviewRun` already records
    `passed_count` / `rules_checked` for audit.

    Span fields (`span_start`, `span_end`, `evidence_text`) are copied
    verbatim off the source `Clause` row. The matcher does not
    paraphrase or recompute spans; this row's evidence is the same
    exact-span citation the segmenter persisted.

    `status` is the deterministic outcome (always `"fail"` for
    persisted rows in v1; the column is kept so a future change that
    persists passes does not need a migration). `finding_status` is
    the human workflow state (see `FindingStatus`). The two are
    independent: `status` is set once at write time; `finding_status`
    is updated by reviewers.
    """

    __tablename__ = "deviation_findings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=_uuid
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    contract_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("contracts.id", ondelete="CASCADE"),
        nullable=False,
    )
    playbook_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("playbooks.id"), nullable=False
    )
    review_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("playbook_review_runs.id", ondelete="CASCADE"),
        nullable=False,
    )

    # Rule shape — captured at write time so a finding is meaningful
    # even if the parent playbook is later edited or deactivated.
    rule_id: Mapped[str] = mapped_column(String(128), nullable=False)
    rule_title: Mapped[str] = mapped_column(String(500), nullable=False)
    rule_type: Mapped[str] = mapped_column(String(32), nullable=False)
    clause_type: Mapped[str] = mapped_column(String(64), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)

    # Deterministic outcome at write time. v1 only persists failures.
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    finding_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=FindingStatus.OPEN.value
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)

    # Evidence: copied verbatim from the matcher result, which itself
    # mirrors the source Clause row. ON DELETE SET NULL on `clause_id`
    # so a future re-segmentation that drops a clause does not orphan
    # the finding (span fields are still meaningful against the source
    # text).
    clause_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("clauses.id", ondelete="SET NULL")
    )
    evidence_text: Mapped[str | None] = mapped_column(Text)
    span_start: Mapped[int | None] = mapped_column(Integer)
    span_end: Mapped[int | None] = mapped_column(Integer)
    matched_terms: Mapped[list[str] | None] = mapped_column(JSON)
    expected_value: Mapped[str | None] = mapped_column(Text)

    # Optional rule-level guidance the firm's playbook author wrote.
    guidance: Mapped[str | None] = mapped_column(Text)
    preferred_language: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    contract: Mapped[Contract] = relationship(back_populates="deviation_findings")
    review_run: Mapped[PlaybookReviewRun] = relationship(back_populates="findings")

    __table_args__ = (
        Index("ix_deviation_findings_organization_id", "organization_id"),
        Index("ix_deviation_findings_contract_id", "contract_id"),
        Index("ix_deviation_findings_playbook_id", "playbook_id"),
        Index(
            "ix_deviation_findings_contract_playbook",
            "contract_id",
            "playbook_id",
        ),
        Index(
            "ix_deviation_findings_contract_status",
            "contract_id",
            "finding_status",
        ),
        Index("ix_deviation_findings_review_run_id", "review_run_id"),
        Index("ix_deviation_findings_severity", "severity"),
    )
