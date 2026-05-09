"""add wrapped_dek to contract_artifacts

Revision ID: 0011_contract_artifact_wrapped_dek
Revises: 0010_template_artifact_wrapped_dek
Create Date: 2026-05-09

PRs #34/#35 introduced ``contract_artifacts`` with the explicit note
that the per-document DEK still lived on ``contracts.wrapped_dek``,
because every artifact for a contract was encrypted under the same DEK.

The DocuSeal completion webhook (PR #45) breaks that assumption: a
``signed_pdf`` artifact carries DocuSeal-supplied bytes that have to be
encrypted under their own DEK at write time. The shared
``DocumentStorage`` adapter wraps a fresh DEK per call, so storing the
signed PDF under ``contracts.wrapped_dek`` would either overwrite the
DEK that decrypts the original/generated artifact (corrupting it) or
require Whereas to re-implement the encryption seam.

The column is nullable because pre-#45 rows do not have a value.
Download falls back to ``contracts.wrapped_dek`` for those.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "0011_contract_artifact_wrapped_dek"
down_revision = "0010_template_artifact_wrapped_dek"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "contract_artifacts",
        sa.Column("wrapped_dek", sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("contract_artifacts", "wrapped_dek")
