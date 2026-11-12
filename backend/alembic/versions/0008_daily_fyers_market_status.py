"""persist the daily Fyers market-status check"""

import sqlalchemy as sa

from alembic import op

revision = "0008_daily_fyers_market_status"
down_revision = "0007_fyers_feed_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "fyers_feed_settings",
        sa.Column("market_status_checked_on", sa.Date(), nullable=True),
    )
    op.add_column(
        "fyers_feed_settings",
        sa.Column("market_status", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("fyers_feed_settings", "market_status")
    op.drop_column("fyers_feed_settings", "market_status_checked_on")
