"""persist the shared Fyers feed interval"""

import sqlalchemy as sa

from alembic import op

revision = "0007_fyers_feed_settings"
down_revision = "0006_signup_license_details"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "fyers_feed_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "refresh_interval_seconds",
            sa.Integer(),
            server_default="5",
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.bulk_insert(
        sa.table(
            "fyers_feed_settings",
            sa.column("id", sa.Integer()),
            sa.column("refresh_interval_seconds", sa.Integer()),
        ),
        [{"id": 1, "refresh_interval_seconds": 5}],
    )


def downgrade() -> None:
    op.drop_table("fyers_feed_settings")
