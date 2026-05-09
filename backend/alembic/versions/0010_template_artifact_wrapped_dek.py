"""add wrapped_dek to agreement_template_artifacts

Revision ID: 0010_template_artifact_wrapped_dek
Revises: 0009_agreement_templates
Create Date: 2026-05-09

PR #37 stored encrypted template bytes via ``DocumentStorage`` but did
not persist the wrapped DEK, so the ciphertext was unreadable. The DOCX
generation flow needs to decrypt the original template, which requires
the wrapped DEK alongside ``storage_key``.

The column is nullable because rows written before this migration won't
have a value; those legacy artifacts cannot be used for generation
(callers will surface a clean 409). New uploads write the wrapped DEK at
artifact creation time.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "0010_template_artifact_wrapped_dek"
down_revision = "0009_agreement_templates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agreement_template_artifacts",
        sa.Column("wrapped_dek", sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agreement_template_artifacts", "wrapped_dek")
