"""Operator-run backfill: legacy Contract storage fields -> ContractArtifact.

Run this once after deploying the ContractArtifact model so existing
contracts get an explicit ``original_upload`` artifact row. Idempotent;
re-running is a no-op once every legacy contract has an artifact.

Usage::

    python -m backend.scripts.backfill_contract_artifacts --dry-run
    python -m backend.scripts.backfill_contract_artifacts
    python -m backend.scripts.backfill_contract_artifacts --organization-id <uuid>
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from app.core.database import SessionLocal
from app.services.contract_artifacts import (
    BackfillResult,
    backfill_original_upload_artifacts,
)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill ContractArtifact rows for legacy contracts that only "
            "have Contract.s3_key/mime_type/file_hash_sha256 set."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be created without writing anything.",
    )
    parser.add_argument(
        "--organization-id",
        type=uuid.UUID,
        default=None,
        help="Limit the backfill to a single organization.",
    )
    return parser.parse_args(argv)


def _print_result(result: BackfillResult, *, dry_run: bool) -> None:
    print(f"scanned:             {result.scanned}")
    if dry_run:
        print(f"would_create:        {result.would_create}")
    else:
        print(f"created:             {result.created}")
    print(f"skipped_existing:    {result.skipped_existing}")
    print(f"skipped_no_storage:  {result.skipped_no_storage}")


async def _run(args: argparse.Namespace) -> BackfillResult:
    async with SessionLocal() as session:
        return await backfill_original_upload_artifacts(
            session,
            organization_id=args.organization_id,
            dry_run=args.dry_run,
        )


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    result = asyncio.run(_run(args))
    _print_result(result, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
