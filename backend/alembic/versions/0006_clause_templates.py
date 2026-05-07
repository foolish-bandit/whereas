"""add clause templates

Revision ID: 0006_clause_templates
Revises: 0005_deviation_findings_persistence
Create Date: 2026-05-07
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006_clause_templates"
down_revision = "0005_deviation_findings_persistence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'clause_templates',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('clause_type', sa.String(length=128), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('jurisdiction', sa.String(length=128), nullable=True),
        sa.Column('contract_type', sa.String(length=128), nullable=True),
        sa.Column('version', sa.String(length=64), nullable=True),
        sa.Column('source', sa.String(length=255), nullable=True),
        sa.Column('tags', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id']),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_clause_templates_org', 'clause_templates', ['organization_id'])
    op.create_index('ix_clause_templates_org_active', 'clause_templates', ['organization_id', 'is_active'])
    op.create_index('ix_clause_templates_org_type', 'clause_templates', ['organization_id', 'clause_type'])
    op.create_index('ix_clause_templates_org_jurisdiction', 'clause_templates', ['organization_id', 'jurisdiction'])
    op.create_index('ix_clause_templates_org_contract_type', 'clause_templates', ['organization_id', 'contract_type'])


def downgrade() -> None:
    op.drop_index('ix_clause_templates_org_contract_type', table_name='clause_templates')
    op.drop_index('ix_clause_templates_org_jurisdiction', table_name='clause_templates')
    op.drop_index('ix_clause_templates_org_type', table_name='clause_templates')
    op.drop_index('ix_clause_templates_org_active', table_name='clause_templates')
    op.drop_index('ix_clause_templates_org', table_name='clause_templates')
    op.drop_table('clause_templates')
