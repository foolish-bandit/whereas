"""add wrapped_dek to agreement_template_artifacts

Revision ID: 0010_template_artifact_wrapped_dek
Revises: 0009_agreement_templates
Create Date: 2026-05-09

The 0009 migration introduced AgreementTemplateArtifact rows for
encrypted template uploads but neglected to persist the wrapped DEK
needed to decrypt them. This migration adds a nullable
``wrapped_dek`` BYTEA column so the generation flow (and any future
template download path) can retrieve plaintext template bytes.

The column is nullable on purpose: rows created by 0009 prior to this
migration are unrecoverable, but they should not block the schema
upgrade. New uploads start populating ``wrapped_dek`` immediately.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010_template_artifact_wrapped_dek"
down_revision: str | Sequence[str] | None = "0009_agreement_templates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_WRAPPED_DEK_COMMENT = (
    "Serialized WrappedKey for the per-document DEK: nonce || ciphertext "
    "from app.security.encryption.WrappedKey.to_bytes(), wrapping the "
    "artifact DEK under the organization master key."
)


def upgrade() -> None:
    op.add_column(
        "agreement_template_artifacts",
        sa.Column(
            "wrapped_dek",
            sa.LargeBinary(),
            nullable=True,
            comment=_WRAPPED_DEK_COMMENT,
        ),
    )


def downgrade() -> None:
    op.drop_column("agreement_template_artifacts", "wrapped_dek")
