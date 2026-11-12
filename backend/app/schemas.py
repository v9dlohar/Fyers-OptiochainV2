"""Pydantic request and response schemas."""

import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class RegistrationCredentials(Credentials):
    mobile_number: str = Field(min_length=7, max_length=20)

    @field_validator("mobile_number")
    @classmethod
    def normalize_mobile_number(cls, value: str) -> str:
        number = value.strip()
        if not re.fullmatch(r"\+?[0-9][0-9\s().-]*[0-9]", number):
            raise ValueError("Enter a valid mobile number.")
        digits = re.sub(r"\D", "", number)
        if not 7 <= len(digits) <= 15:
            raise ValueError("Mobile number must contain 7 to 15 digits.")
        return ("+" if number.startswith("+") else "") + digits


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    is_active: bool
    license_active: bool
    must_change_password: bool
    is_admin: bool
    created_at: datetime


class LicenseUserResponse(BaseModel):
    id: int
    email: EmailStr
    mobile_number: str | None
    license_active: bool
    license_expires_at: datetime | None
    created_at: datetime


class LicenseUpdate(BaseModel):
    active: bool
    duration_days: int | None = Field(default=None, ge=1, le=3650)


class PasswordChange(BaseModel):
    current_password: str | None = Field(default=None, min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class PasswordResetResponse(BaseModel):
    temporary_password: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20)


class FyersStatus(BaseModel):
    connected: bool
    provider: str
    connected_at: datetime | None = None


class FyersFeedSettingsUpdate(BaseModel):
    refresh_interval_seconds: int = Field(ge=1, le=5)


class OptionChainResponse(BaseModel):
    provider: str
    symbol: str
    data: dict
