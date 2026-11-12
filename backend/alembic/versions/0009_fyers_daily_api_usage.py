"""track daily Fyers API request usage"""

import sqlalchemy as sa

from alembic import op

revision = "0009_fyers_daily_api_usage"
down_revision = "0008_daily_fyers_market_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "fyers_feed_settings",
        sa.Column("api_requests_date", sa.Date(), nullable=True),
    )
    op.add_column(
        "fyers_feed_settings",
        sa.Column(
            "api_requests_today",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("fyers_feed_settings", "api_requests_today")
    op.drop_column("fyers_feed_settings", "api_requests_date")
