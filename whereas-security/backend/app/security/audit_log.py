"""Append-only audit log with hash chaining.

Every privileged action gets a record. Records form a hash chain: each entry
includes the SHA-256 of the previous entry, so any tampering breaks the chain
and is detectable by re-hashing.

This isn't blockchain magic. It's the simplest tamper-evident log: if someone
deletes or modifies a row, the chain breaks at that point and every subsequent
row's hash becomes invalid. You verify the chain periodically (or on demand).

What this protects against:
  - Someone with database write access selectively deleting evidence of an action.
  - Silent modification of audit records.

What this does NOT protect against:
  - Truncation of the chain (deleting the most recent N entries). For that,
    pin the latest hash externally — to a separate log, an external service,
    or a regulator-required attestation.
  - Compromise of the running application (an attacker with app-level access
    can write valid new entries that hide their actions, but cannot rewrite
    history without breaking the chain).
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    String,
    select,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# --------------------------------------------------------------------------
# Audit event types
# --------------------------------------------------------------------------


class AuditEventType(str, Enum):
    # Auth
    USER_LOGIN_SUCCESS = "user.login.success"
    USER_LOGIN_FAILURE = "user.login.failure"
    USER_LOGOUT = "user.logout"
    USER_PASSWORD_CHANGED = "user.password.changed"
    USER_MFA_ENABLED = "user.mfa.enabled"
    USER_MFA_DISABLED = "user.mfa.disabled"

    # Org admin
    USER_CREATED = "user.created"
    USER_DEACTIVATED = "user.deactivated"
    USER_ROLE_CHANGED = "user.role.changed"

    # Contracts
    CONTRACT_UPLOADED = "contract.uploaded"
    CONTRACT_DOWNLOADED = "contract.downloaded"
    CONTRACT_DELETED = "contract.deleted"
    CONTRACT_FIELD_OVERRIDDEN = "contract.field.overridden"

    # Playbooks
    PLAYBOOK_CREATED = "playbook.created"
    PLAYBOOK_UPDATED = "playbook.updated"
    PLAYBOOK_DELETED = "playbook.deleted"

    # Deviations
    DEVIATION_DISMISSED = "deviation.dismissed"

    # E-signature
    CONTRACT_SENT_FOR_SIGNATURE = "contract.sent_for_signature"
    CONTRACT_EXECUTED = "contract.executed"

    # Security
    LLM_REMOTE_PROVIDER_ENABLED = "security.llm_remote_provider.enabled"
    KEY_ROTATION_INITIATED = "security.key_rotation.initiated"
    KEY_ROTATION_COMPLETED = "security.key_rotation.completed"


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------


# Genesis hash for the start of the chain. 32 zero bytes, hex encoded.
GENESIS_HASH = "0" * 64


class AuditEvent(Base):
    """A single audit log entry. Append-only; never updated or deleted.

    The `entry_hash` is computed over the canonical JSON serialization of the
    record (excluding entry_hash itself, including prev_hash). Any modification
    after insert breaks the chain.
    """
    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Sequence number is monotonic per organization. Helps with chain verification
    # because we can scan in order without sorting by timestamp (timestamps can
    # collide or move backward across DB clocks).
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, index=True)

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True
    )

    # Actor (None for system-initiated events)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    actor_ip: Mapped[str | None] = mapped_column(String(45))  # IPv6 max length
    actor_user_agent: Mapped[str | None] = mapped_column(String(500))

    event_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # The thing the action was performed on (e.g., contract id, playbook id)
    target_type: Mapped[str | None] = mapped_column(String(64))
    target_id: Mapped[str | None] = mapped_column(String(64))

    # Free-form details. Avoid storing sensitive data here; just the metadata
    # of the action (e.g., which field was changed, not the values).
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )

    # Hash chain
    prev_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)


# --------------------------------------------------------------------------
# Hashing
# --------------------------------------------------------------------------


def _canonical_json(data: dict[str, Any]) -> str:
    """JSON-serialize a dict with sorted keys and consistent separators.

    Required for hash stability: any two equivalent dicts must produce the same
    string, so the hash is reproducible.
    """
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)


def compute_entry_hash(
    *,
    sequence: int,
    organization_id: str,
    actor_user_id: str | None,
    event_type: str,
    target_type: str | None,
    target_id: str | None,
    details: dict[str, Any],
    occurred_at: datetime,
    prev_hash: str,
) -> str:
    """Compute the SHA-256 hash for an audit entry.

    The fields included here ARE the canonical record. Any change to which
    fields are hashed is a breaking change — old records won't re-verify.
    Bump a schema version if you ever need to do this.
    """
    payload = {
        "sequence": sequence,
        "organization_id": organization_id,
        "actor_user_id": actor_user_id,
        "event_type": event_type,
        "target_type": target_type,
        "target_id": target_id,
        "details": details,
        "occurred_at": occurred_at.isoformat(),
        "prev_hash": prev_hash,
    }
    canonical = _canonical_json(payload)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# Writer
# --------------------------------------------------------------------------


async def record_event(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    event_type: AuditEventType,
    actor_user_id: uuid.UUID | None = None,
    actor_ip: str | None = None,
    actor_user_agent: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> AuditEvent:
    """Record an audit event. Always commits its own row; if the surrounding
    transaction rolls back, the audit row stays — that's intentional. We want
    to know about attempted actions, not just successful ones.

    Note: in practice you may want to write the audit log in a separate session
    to guarantee independence from the business transaction. For v0.1 we keep
    it simple and rely on the application-layer commit ordering.
    """
    details = details or {}

    # Get the most recent event for this org to chain from
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.organization_id == organization_id)
        .order_by(AuditEvent.sequence.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    last = result.scalar_one_or_none()

    sequence = (last.sequence + 1) if last else 1
    prev_hash = last.entry_hash if last else GENESIS_HASH
    occurred_at = datetime.now(UTC)

    entry_hash = compute_entry_hash(
        sequence=sequence,
        organization_id=str(organization_id),
        actor_user_id=str(actor_user_id) if actor_user_id else None,
        event_type=event_type.value,
        target_type=target_type,
        target_id=target_id,
        details=details,
        occurred_at=occurred_at,
        prev_hash=prev_hash,
    )

    event = AuditEvent(
        sequence=sequence,
        organization_id=organization_id,
        actor_user_id=actor_user_id,
        actor_ip=actor_ip,
        actor_user_agent=actor_user_agent,
        event_type=event_type.value,
        target_type=target_type,
        target_id=target_id,
        details=details,
        occurred_at=occurred_at,
        prev_hash=prev_hash,
        entry_hash=entry_hash,
    )
    session.add(event)
    await session.flush()
    return event


# --------------------------------------------------------------------------
# Verifier
# --------------------------------------------------------------------------


async def verify_chain(session: AsyncSession, organization_id: uuid.UUID) -> tuple[bool, int | None]:
    """Verify the audit chain for an organization.

    Returns (ok, broken_at_sequence). If ok is True, the chain is intact.
    If False, broken_at_sequence is the first sequence number where
    verification failed.

    Run this periodically as a cron job and alert on failure.
    """
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.organization_id == organization_id)
        .order_by(AuditEvent.sequence.asc())
    )
    result = await session.execute(stmt)
    events = result.scalars().all()

    expected_prev = GENESIS_HASH
    expected_sequence = 1

    for event in events:
        if event.sequence != expected_sequence:
            return False, event.sequence
        if event.prev_hash != expected_prev:
            return False, event.sequence
        recomputed = compute_entry_hash(
            sequence=event.sequence,
            organization_id=str(event.organization_id),
            actor_user_id=str(event.actor_user_id) if event.actor_user_id else None,
            event_type=event.event_type,
            target_type=event.target_type,
            target_id=event.target_id,
            details=event.details,
            occurred_at=event.occurred_at,
            prev_hash=event.prev_hash,
        )
        if recomputed != event.entry_hash:
            return False, event.sequence
        expected_prev = event.entry_hash
        expected_sequence += 1

    return True, None
