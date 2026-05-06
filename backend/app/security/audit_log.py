"""Append-only hash-chained audit log.

Threat model this addresses:
  - An attacker with read+write access to Postgres (but no app credentials)
    may try to delete or rewrite audit entries to cover their tracks. The
    hash chain means any tampering breaks verification.
  - An attacker with app-level access can still write new entries, but
    cannot silently modify or delete past ones without breaking the chain.

Architecture:
  - Each event has a sequence number monotonic per organization (each
    org's audit log is its own chain).
  - Each event stores `prev_hash` (the entry_hash of the previous event in
    that org's sequence) and its own `entry_hash`. The first event's
    prev_hash is `GENESIS_HASH`.
  - `compute_entry_hash` defines the canonical record format. THE EXACT
    SERIALIZATION IS LOAD-BEARING: any record ever written becomes
    unverifiable if its inputs, key set, ordering, or json.dumps arguments
    change. Treat changes here as a database migration, not a refactor.

Operational notes:
  - Verification is O(N) per organization. Schedule it as a background job
    on a sensible cadence; don't put it on the request path.
  - The chain is per-org. We don't try to defeat collusion across orgs.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    select,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------


# The "previous hash" for the first event in any organization's chain.
# 64 zero hex chars = 32 zero bytes, matching the SHA-256 digest length.
# Changing this value invalidates every chain ever started under the prior one.
GENESIS_HASH = "0" * 64


# --------------------------------------------------------------------------
# Event taxonomy
# --------------------------------------------------------------------------


class AuditEventType(str, Enum):
    """Canonical audit event types. Dotted, lowercase, namespaced.

    The string values are part of the persisted record and are bound into
    the entry hash, so renames are migrations, not refactors. New event
    types should be added in the PR that wires up their emission, not
    speculatively.
    """

    USER_LOGIN_SUCCESS = "user.login.success"
    USER_LOGIN_FAILURE = "user.login.failure"
    USER_LOGOUT = "user.logout"
    USER_PASSWORD_CHANGED = "user.password.changed"
    USER_MFA_ENABLED = "user.mfa.enabled"
    USER_MFA_DISABLED = "user.mfa.disabled"

    USER_CREATED = "user.created"
    USER_DEACTIVATED = "user.deactivated"
    USER_ROLE_CHANGED = "user.role.changed"

    CONTRACT_UPLOADED = "contract.uploaded"
    CONTRACT_DOWNLOADED = "contract.downloaded"
    CONTRACT_DELETED = "contract.deleted"
    CONTRACT_FIELD_OVERRIDDEN = "contract.field.overridden"

    PLAYBOOK_CREATED = "playbook.created"
    PLAYBOOK_UPDATED = "playbook.updated"
    PLAYBOOK_DELETED = "playbook.deleted"

    DEVIATION_DISMISSED = "deviation.dismissed"

    CONTRACT_SENT_FOR_SIGNATURE = "contract.sent_for_signature"
    CONTRACT_EXECUTED = "contract.executed"

    LLM_REMOTE_PROVIDER_ENABLED = "llm.remote_provider.enabled"
    KEY_ROTATION_INITIATED = "key.rotation.initiated"
    KEY_ROTATION_COMPLETED = "key.rotation.completed"


# --------------------------------------------------------------------------
# ORM model
# --------------------------------------------------------------------------


class AuditEvent(Base):
    """One entry in an organization's hash-chained audit log.

    The (organization_id, sequence) pair is unique: each org's chain is its
    own monotonic stream starting at sequence=1. `entry_hash` is unique
    globally, which catches accidental cross-chain replay.
    """

    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id"),
        nullable=False,
        index=True,
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    actor_ip: Mapped[str | None] = mapped_column(String(45))
    actor_user_agent: Mapped[str | None] = mapped_column(String(500))
    event_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_type: Mapped[str | None] = mapped_column(String(64))
    target_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    prev_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    __table_args__ = (
        UniqueConstraint("organization_id", "sequence", name="uq_audit_org_sequence"),
    )


# --------------------------------------------------------------------------
# Hashing primitive (LOAD-BEARING)
# --------------------------------------------------------------------------


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
    """Canonical SHA-256 hash of one audit record.

    LOAD-BEARING: chain verification re-runs this against stored events, so
    any change here breaks verification of every record ever written under
    the prior version. Specifically, all of these are part of the contract:
      - The set of fields included (the nine arguments here).
      - Their representations: `sequence` as an int, `occurred_at` via
        `.isoformat()`, UUIDs/strings passed through as-is, `details` as a
        dict.
      - The exact `json.dumps` invocation:
            sort_keys=True       (recursive canonical key ordering)
            separators=(",", ":") (no whitespace ambiguity)
            default=str          (fallback for unexpected types in details)
      - UTF-8 encoding before SHA-256.
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
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# Persistence helpers
# --------------------------------------------------------------------------


async def record_event(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID | str,
    event_type: AuditEventType | str,
    actor_user_id: uuid.UUID | str | None = None,
    actor_ip: str | None = None,
    actor_user_agent: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    details: dict[str, Any] | None = None,
    occurred_at: datetime | None = None,
) -> AuditEvent:
    """Append a new audit event to the organization's chain.

    The write happens in the caller's transaction. We `flush()` so the
    returned `AuditEvent` carries its database-assigned id, but commit
    remains the caller's responsibility — typically the request handler's
    session-scope context manager.
    """
    if occurred_at is None:
        occurred_at = datetime.now(timezone.utc)
    if details is None:
        details = {}

    event_type_str = (
        event_type.value if isinstance(event_type, AuditEventType) else event_type
    )
    org_id_str = str(organization_id)
    actor_id_str = str(actor_user_id) if actor_user_id is not None else None

    # Chain onto the most recent event for the org. If there is none, the
    # chain starts fresh at sequence=1 with prev_hash=GENESIS_HASH.
    prev_event = await _latest_event_for_org(session, organization_id)
    if prev_event is None:
        sequence = 1
        prev_hash = GENESIS_HASH
    else:
        sequence = prev_event.sequence + 1
        prev_hash = prev_event.entry_hash

    entry_hash = compute_entry_hash(
        sequence=sequence,
        organization_id=org_id_str,
        actor_user_id=actor_id_str,
        event_type=event_type_str,
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
        event_type=event_type_str,
        target_type=target_type,
        target_id=target_id,
        details=details,
        occurred_at=occurred_at,
        prev_hash=prev_hash,
        entry_hash=entry_hash,
    )
    session.add(event)
    await session.flush()
    log.info(
        "Recorded audit event",
        extra={
            "organization_id": org_id_str,
            "sequence": sequence,
            "event_type": event_type_str,
        },
    )
    return event


async def verify_chain(
    session: AsyncSession,
    organization_id: uuid.UUID | str,
) -> tuple[bool, int | None]:
    """Verify the audit chain for an organization end-to-end.

    Walks events in `sequence` order. For each, checks that:
      1. The sequence number is the expected next integer (no gaps).
      2. `prev_hash` matches the previous event's `entry_hash` (or
         `GENESIS_HASH` for the first event).
      3. Recomputing `compute_entry_hash` reproduces the stored
         `entry_hash` exactly.

    Returns `(True, None)` on success, or `(False, broken_sequence_number)`
    on the first inconsistency found. Cost is O(N) in the org's audit log
    size, so don't run on the request path.
    """
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.organization_id == organization_id)
        .order_by(AuditEvent.sequence.asc())
    )
    result = await session.execute(stmt)

    expected_prev_hash = GENESIS_HASH
    expected_sequence = 1

    for event in result.scalars():
        if event.sequence != expected_sequence:
            log.error(
                "Audit chain sequence gap",
                extra={
                    "organization_id": str(organization_id),
                    "expected_sequence": expected_sequence,
                    "got_sequence": event.sequence,
                },
            )
            return False, event.sequence
        if event.prev_hash != expected_prev_hash:
            log.error(
                "Audit chain prev_hash mismatch",
                extra={
                    "organization_id": str(organization_id),
                    "sequence": event.sequence,
                },
            )
            return False, event.sequence

        recomputed = compute_entry_hash(
            sequence=event.sequence,
            organization_id=str(event.organization_id),
            actor_user_id=(
                str(event.actor_user_id) if event.actor_user_id is not None else None
            ),
            event_type=event.event_type,
            target_type=event.target_type,
            target_id=event.target_id,
            details=event.details,
            occurred_at=event.occurred_at,
            prev_hash=event.prev_hash,
        )
        if recomputed != event.entry_hash:
            log.error(
                "Audit chain entry_hash mismatch",
                extra={
                    "organization_id": str(organization_id),
                    "sequence": event.sequence,
                },
            )
            return False, event.sequence

        expected_prev_hash = event.entry_hash
        expected_sequence = event.sequence + 1

    return True, None


async def _latest_event_for_org(
    session: AsyncSession, organization_id: uuid.UUID | str
) -> AuditEvent | None:
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.organization_id == organization_id)
        .order_by(AuditEvent.sequence.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()
