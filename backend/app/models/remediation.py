"""Typed links between persisted findings and their Inbox remediation work."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models import DeviationFinding, InboxItem


class FindingRemediationTask(Base):
    """One durable Inbox work item for one persisted deviation finding.

    The link row stores identifiers and source provenance only. Approved clause
    text, evidence text, and playbook guidance remain in their authoritative
    tables and are never copied here.
    """

    __tablename__ = "finding_remediation_tasks"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    finding_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("deviation_findings.id", ondelete="CASCADE"),
        nullable=False,
    )
    inbox_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inbox_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    source_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    finding: Mapped[DeviationFinding] = relationship()
    inbox_item: Mapped[InboxItem] = relationship()

    __table_args__ = (
        UniqueConstraint(
            "organization_id",
            "finding_id",
            name="uq_finding_remediation_tasks_org_finding",
        ),
        UniqueConstraint(
            "inbox_item_id",
            name="uq_finding_remediation_tasks_inbox_item",
        ),
        Index(
            "ix_finding_remediation_tasks_org_created",
            "organization_id",
            "created_at",
        ),
    )
