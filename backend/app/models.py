"""Persistence models for authentication."""

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    mobile_number: Mapped[str | None] = mapped_column(String(16))
    is_active: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true"
    )
    license_active: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    license_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    session_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    user: Mapped[User] = relationship(back_populates="refresh_tokens")


class BrokerConnection(Base):
    __tablename__ = "broker_connections"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    encrypted_access_token: Mapped[str] = mapped_column(String(1024))
    encrypted_refresh_token: Mapped[str | None] = mapped_column(String(1024))
    connected_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class FyersOAuthState(Base):
    __tablename__ = "fyers_oauth_states"

    id: Mapped[int] = mapped_column(primary_key=True)
    state_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class FyersFeedSettings(Base):
    __tablename__ = "fyers_feed_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    refresh_interval_seconds: Mapped[int] = mapped_column(
        default=5, server_default="5"
    )
    market_status_checked_on: Mapped[date | None] = mapped_column(Date)
    market_status: Mapped[str | None] = mapped_column(String(32))
    api_requests_date: Mapped[date | None] = mapped_column(Date)
    api_requests_today: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
