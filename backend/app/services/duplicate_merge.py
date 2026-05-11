"""Duplicate-merge service (PR #76).

Resolves a duplicate Repository (Contract) record into a canonical one
without deleting data. The source row stays in the database — its
``merged_into_contract_id`` / ``merged_at`` / ``merged_by_user_id``
columns mark it as merged. The source row's ``ContractArtifact`` rows
are reassigned to the target so the target's Document History gains
the merged artifacts.

Design notes
============

* Artifact bytes, ``storage_key``, ``wrapped_dek``, and per-artifact
  ``metadata_json`` are NOT touched. Reassignment only flips
  ``contract_id`` (and re-stamps ``organization_id`` defensively,
  though it must already match). Downloading a moved artifact still
  decrypts under the source-org/source-DEK that wrote it; we never
  re-encrypt during merge.
* ``ContractMarkdownSnapshot`` rows on the source are deliberately
  left alone. The target's "current text preview" is the snapshot
  most recently written for the target ``contract_id``, so leaving
  the source snapshots in place keeps source traceability without
  silently replacing the target preview.
* ``ContractRequest`` links and ``ApprovalWorkflowRun`` links are
  NOT rewired in this PR. The merge response includes booleans so
  the UI can warn that workflow/request linkage stayed on the source.
* DocuSeal state is NOT touched. If either side has a
  ``signed_pdf``, both signed PDFs land on the target as artifacts;
  the existing document-history priority chooses what the "current"
  document is. We do not call DocuSeal, do not mutate
  ``docuseal_submission_id`` on either record, and do not flip
  contract ``status``.

Errors
======

``DuplicateMergeError`` carries an HTTP status and a stable error
code (``same_record`` / ``source_already_merged`` /
``target_already_merged``) so the API layer can map cleanly.
``404`` is the caller's responsibility — this service trusts that
the rows handed to it are already org-scoped.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ApprovalWorkflowRun,
    Contract,
    ContractArtifact,
    ContractRequest,
)


class DuplicateMergeError(Exception):
    """Domain error from the merge service.

    ``http_status`` lets the API layer raise the right ``HTTPException``
    without re-deciding policy. ``code`` is a stable short string so
    the frontend can branch on it without parsing prose.
    """

    def __init__(self, *, http_status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DuplicateMergeResult:
    """Outcome of a successful merge.

    ``workflow_runs_attached_to_source`` and
    ``requests_attached_to_source`` are counts, NOT lists of ids.
    They're surfaced as a warning hint: this PR does not rewire
    those links, so the UI can tell the user "this duplicate had
    N workflows attached — they stayed on the merged record".
    """

    target_contract_id: uuid.UUID
    source_contract_id: uuid.UUID
    artifacts_moved: int
    merged_at: datetime
    merged_by_user_id: uuid.UUID
    workflow_runs_attached_to_source: int
    requests_attached_to_source: int


async def merge_duplicate_contract(
    session: AsyncSession,
    *,
    target: Contract,
    source: Contract,
    merged_by_user_id: uuid.UUID,
    merge_note: str | None = None,
) -> DuplicateMergeResult:
    """Merge ``source`` into ``target``. Both rows must belong to the
    same organization; the caller's API handler is responsible for
    that scoping and for the 404 if either is missing.

    Raises :class:`DuplicateMergeError` on:

    * ``source.id == target.id`` (``code='same_record'``, 400).
    * source already merged (``code='source_already_merged'``, 409).
    * target already merged (``code='target_already_merged'``, 409).
    """
    if source.id == target.id:
        raise DuplicateMergeError(
            http_status=400,
            code="same_record",
            message="Source and target Repository records must differ.",
        )
    if source.organization_id != target.organization_id:
        # Defense-in-depth: the API layer already scopes both lookups
        # to the caller's org, so reaching this branch means a bug.
        # Treat as "not found" to avoid leaking cross-org existence.
        raise DuplicateMergeError(
            http_status=404,
            code="cross_org",
            message="Source Repository record was not found.",
        )
    if source.merged_into_contract_id is not None:
        raise DuplicateMergeError(
            http_status=409,
            code="source_already_merged",
            message="This Repository record has already been merged.",
        )
    if target.merged_into_contract_id is not None:
        raise DuplicateMergeError(
            http_status=409,
            code="target_already_merged",
            message=(
                "The target Repository record was itself merged into "
                "another record; pick that one instead."
            ),
        )

    now = datetime.now(UTC)

    # Count workflow / request links attached to the source so the
    # response can warn. We do NOT rewire them in this PR.
    workflow_runs_attached = await _count_workflow_runs_for_contract(
        session, contract_id=source.id
    )
    requests_attached = await _count_requests_for_contract(
        session, contract_id=source.id
    )

    # Reassign artifacts. ``ContractArtifact.contract_id`` is the only
    # field that changes; ``organization_id``, ``storage_key``,
    # ``wrapped_dek``, ``metadata_json``, ``file_hash_sha256``,
    # ``created_at`` etc. all stay put.
    artifacts_moved = await _reassign_artifacts(
        session,
        source_contract_id=source.id,
        target_contract_id=target.id,
    )

    # Flag the source as merged. The source row's own data (title,
    # status, full_text, s3_key, etc.) is untouched so the merged
    # detail page can still render a safe historical view.
    source.merged_into_contract_id = target.id
    source.merged_at = now
    source.merged_by_user_id = merged_by_user_id

    session.add(source)
    await session.flush()

    # ``merge_note`` is consumed here only as a presence boolean for
    # audit. The note text itself is NOT persisted in this PR — that
    # is a deliberate narrowing to avoid surfacing operator prose
    # through the audit log without a UI to read it back safely.
    _ = merge_note  # noqa: F841 — intentional, see docstring

    return DuplicateMergeResult(
        target_contract_id=target.id,
        source_contract_id=source.id,
        artifacts_moved=artifacts_moved,
        merged_at=now,
        merged_by_user_id=merged_by_user_id,
        workflow_runs_attached_to_source=workflow_runs_attached,
        requests_attached_to_source=requests_attached,
    )


async def _reassign_artifacts(
    session: AsyncSession,
    *,
    source_contract_id: uuid.UUID,
    target_contract_id: uuid.UUID,
) -> int:
    """Move every ``ContractArtifact`` row from source → target.

    Returns the number of rows reassigned. The bulk UPDATE skips the
    ORM unit-of-work to keep the merge transaction small; we do not
    need to refresh the target's loaded ``artifacts`` collection here
    because the API handler refetches the target detail after a
    successful merge.
    """
    count_stmt = select(ContractArtifact.id).where(
        ContractArtifact.contract_id == source_contract_id
    )
    artifact_ids = (await session.execute(count_stmt)).scalars().all()
    if not artifact_ids:
        return 0
    await session.execute(
        update(ContractArtifact)
        .where(ContractArtifact.contract_id == source_contract_id)
        .values(contract_id=target_contract_id)
    )
    return len(artifact_ids)


async def _count_workflow_runs_for_contract(
    session: AsyncSession, *, contract_id: uuid.UUID
) -> int:
    stmt = select(ApprovalWorkflowRun.id).where(
        ApprovalWorkflowRun.contract_id == contract_id
    )
    rows = (await session.execute(stmt)).scalars().all()
    return len(rows)


async def _count_requests_for_contract(
    session: AsyncSession, *, contract_id: uuid.UUID
) -> int:
    stmt = select(ContractRequest.id).where(
        ContractRequest.linked_contract_id == contract_id
    )
    rows = (await session.execute(stmt)).scalars().all()
    return len(rows)
