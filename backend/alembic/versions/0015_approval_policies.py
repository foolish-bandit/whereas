"""PR #53 approval policies.

Revision ID: 0015_approval_policies
Revises: 0014_approval_workflow_templates
Create Date: 2026-05-10
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = '0015_approval_policies'
down_revision = '0014_approval_workflow_templates'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'approval_policies',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='active'),
        sa.Column('workflow_template_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('request_type', sa.String(length=64), nullable=True),
        sa.Column('contract_type', sa.String(length=64), nullable=True),
        sa.Column('priority', sa.String(length=32), nullable=True),
        sa.Column('agreement_template_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('applies_to_generated_contracts', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('auto_attach', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True, server_default=sa.func.now()),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('metadata_json', sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(['agreement_template_id'], ['agreement_templates.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['workflow_template_id'], ['approval_workflow_templates.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('organization_id', 'name', name='uq_approval_policies_org_name'),
    )
    for col in ['organization_id','status','workflow_template_id','request_type','contract_type','priority','agreement_template_id']:
        op.create_index(f'ix_approval_policies_{col}', 'approval_policies', [col], unique=False)
    op.create_index('ix_approval_policies_org_status_request_contract', 'approval_policies', ['organization_id','status','request_type','contract_type'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_approval_policies_org_status_request_contract', table_name='approval_policies')
    for col in ['agreement_template_id','priority','contract_type','request_type','workflow_template_id','status','organization_id']:
        op.drop_index(f'ix_approval_policies_{col}', table_name='approval_policies')
    op.drop_table('approval_policies')
