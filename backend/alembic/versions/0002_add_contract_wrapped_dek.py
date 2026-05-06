"""Add contract wrapped DEK metadata.

Revision ID: 0002_add_contract_wrapped_dek
Revises: 0001_initial_schema
Create Date: 2026-05-06

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_add_contract_wrapped_dek"
down_revision: str | Sequence[str] | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WRAPPED_DEK_COMMENT = (
    "Serialized WrappedKey for the per-document DEK: nonce || ciphertext "
    "from app.security.encryption.WrappedKey.to_bytes(), wrapping the "
    "document DEK under the organization master key."
)


def upgrade() -> None:
    """Add the serialized wrapped document key to contract metadata."""
    op.add_column(
        "contracts",
        sa.Column(
            "wrapped_dek",
            sa.LargeBinary(),
            nullable=True,
            comment=_WRAPPED_DEK_COMMENT,
        ),
    )


def downgrade() -> None:
    """Remove the serialized wrapped document key from contract metadata."""
    op.drop_column("contracts", "wrapped_dek")
