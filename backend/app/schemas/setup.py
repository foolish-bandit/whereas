"""Request/response schemas for the dev-only first-run setup endpoints."""
from __future__ import annotations

import uuid

from pydantic import BaseModel, Field


class SetupStatusResponse(BaseModel):
    setup_required: bool
    organization_count: int
    user_count: int
    dev_mode_enabled: bool
    message: str | None = None


class CreateDevSetupRequest(BaseModel):
    """Optional inputs for the dev-only setup endpoint.

    All three fields are optional. Empty / whitespace-only strings are
    treated as "not provided" and replaced with the documented defaults
    server-side. Email is validated lightly (must contain "@") server-side
    rather than via `EmailStr`, to avoid pulling in `email-validator` for
    a dev-only flow.
    """

    organization_name: str | None = Field(default=None, max_length=255)
    user_email: str | None = Field(default=None, max_length=255)
    user_name: str | None = Field(default=None, max_length=255)


class CreateDevSetupResponse(BaseModel):
    """Response returned by `POST /api/setup/dev`.

    Carries only UUIDs and human-readable strings. No wrapped key material,
    no password hashes, no instance key. The `dev_user_id` field is the
    UUID the frontend should set into `X-Whereas-Dev-User`; it equals
    `user_id` and is provided alongside it for clarity in the dev flow.
    """

    organization_id: uuid.UUID
    user_id: uuid.UUID
    dev_user_id: uuid.UUID
    organization_name: str
    user_email: str
    message: str
