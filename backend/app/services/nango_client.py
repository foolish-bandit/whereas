"""HTTP client for talking to a self-hosted Nango deployment.

Nango is a peer service (similar shape to DocuSeal in this codebase):
it runs alongside in docker-compose and handles the OAuth dance,
token storage, and provider-specific sync orchestration for Google
Drive / OneDrive / SharePoint / Gmail / Outlook. Whereas calls Nango
over HTTP — Nango's first-party SDK is Node-only.

The client is deliberately thin. It exposes only the verbs Whereas
actually uses (mint a Connect session, list connections, delete a
connection, hand a webhook back, proxy a file download) and treats
Nango as a trust boundary: every response is parsed defensively, and
no upstream content is logged.

Configuration:
- ``NANGO_BASE_URL``: where the Nango server lives (default
  ``http://nango-server:3003`` in compose).
- ``NANGO_SECRET_KEY``: the secret the Nango server was started with;
  used for server-to-server auth on Nango's REST API.
- ``NANGO_WEBHOOK_SECRET``: HMAC secret Nango signs outbound webhooks
  with. The verifier in this module fails closed when it is unset in
  any environment other than ``development``.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.core.config import Settings, get_settings

log = logging.getLogger(__name__)

# Tolerance for Nango's outbound webhook timestamps, matching the
# DocuSeal verifier and standard webhook-signing windows.
WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

NANGO_SIGNATURE_HEADER = "X-Nango-Signature"


class NangoError(Exception):
    """A Nango API call failed in a way the caller cannot retry."""

    status_code: int = 502

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


class RetryableNangoError(NangoError):
    """A Nango API call failed transiently and may resolve on retry."""


class NangoWebhookVerificationError(Exception):
    """A Nango webhook payload could not be authenticated."""

    status_code: int = 401

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


@dataclass(frozen=True)
class ConnectSession:
    """The opaque session token the frontend hands to the Nango Connect UI."""

    token: str
    expires_at: datetime | None


@dataclass(frozen=True)
class NangoFile:
    """A file record returned by a Nango sync.

    ``download_url`` is the Nango-proxied URL the caller fetches the
    bytes from. ``provider_file_id`` is the upstream provider's stable
    id (Google Drive file id, OneDrive driveItem id, mail message id).
    """

    provider_file_id: str
    filename: str
    mime_type: str | None
    size_bytes: int | None
    revision: str | None
    download_url: str | None
    metadata: dict[str, Any]


_RETRYABLE = (httpx.HTTPError, RetryableNangoError)


def _auth_headers(secret_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret_key}"}


def _settings_or_default(settings: Settings | None) -> Settings:
    return settings or get_settings()


def _require_secret(settings: Settings) -> str:
    if not settings.NANGO_SECRET_KEY:
        raise NangoError(
            "Nango is not configured (NANGO_SECRET_KEY is unset).",
            status_code=503,
        )
    return settings.NANGO_SECRET_KEY


def _raise_for_status(
    response: httpx.Response, *, what: str
) -> None:
    if response.status_code >= 500:
        raise RetryableNangoError(
            f"Nango returned {response.status_code} on {what}.",
        )
    if response.status_code >= 400:
        # 4xx is the caller's fault (bad provider, unknown connection,
        # malformed payload). Surface as a clean 502 to the API caller;
        # the upstream status is logged but not echoed verbatim.
        log.warning(
            "Nango rejected %s with status %s",
            what,
            response.status_code,
        )
        raise NangoError(
            f"Nango rejected the request ({response.status_code}).",
            status_code=502,
        )


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type(_RETRYABLE),
    reraise=True,
)
async def create_connect_session(
    *,
    organization_id: str,
    provider: str,
    end_user_email: str | None = None,
    settings: Settings | None = None,
) -> ConnectSession:
    """Mint a short-lived Connect session for the frontend.

    ``organization_id`` is forwarded to Nango as the end-user id so a
    later webhook ties back to a Whereas org. The Connect UI does the
    OAuth dance; on success the frontend receives the
    ``connection_id`` from Nango's Connect callback and POSTs it back
    to Whereas.
    """
    settings = _settings_or_default(settings)
    secret = _require_secret(settings)

    payload: dict[str, Any] = {
        "end_user": {"id": organization_id},
        "allowed_integrations": [provider],
    }
    if end_user_email:
        payload["end_user"]["email"] = end_user_email

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.post(
                f"{settings.NANGO_BASE_URL}/connect/sessions",
                headers=_auth_headers(secret),
                json=payload,
            )
        except httpx.HTTPError as exc:
            raise RetryableNangoError(
                f"Could not reach Nango: {type(exc).__name__}.",
            ) from exc

    _raise_for_status(response, what="create_connect_session")
    body = _parse_json_or_502(response)
    data = body.get("data") or body
    token = data.get("token") or data.get("session_token")
    if not isinstance(token, str) or not token:
        raise NangoError("Nango returned no session token.")
    expires_str = data.get("expires_at")
    expires_at: datetime | None = None
    if isinstance(expires_str, str):
        try:
            expires_at = datetime.fromisoformat(expires_str.replace("Z", "+00:00"))
        except ValueError:
            expires_at = None
    return ConnectSession(token=token, expires_at=expires_at)


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type(_RETRYABLE),
    reraise=True,
)
async def delete_connection(
    *,
    connection_id: str,
    provider: str,
    settings: Settings | None = None,
) -> None:
    """Tell Nango to revoke and forget a connection.

    A 404 from Nango is treated as success — if the connection is
    already gone, the disconnect is a no-op rather than an error.
    """
    settings = _settings_or_default(settings)
    secret = _require_secret(settings)

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.delete(
                f"{settings.NANGO_BASE_URL}/connection/{connection_id}",
                headers=_auth_headers(secret),
                params={"provider_config_key": provider},
            )
        except httpx.HTTPError as exc:
            raise RetryableNangoError(
                f"Could not reach Nango: {type(exc).__name__}.",
            ) from exc

    if response.status_code == 404:
        return
    _raise_for_status(response, what="delete_connection")


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type(_RETRYABLE),
    reraise=True,
)
async def list_files(
    *,
    connection_id: str,
    provider: str,
    sync_name: str = "documents",
    cursor: str | None = None,
    settings: Settings | None = None,
) -> tuple[list[NangoFile], str | None]:
    """List files synced by Nango for a given connection.

    Nango exposes synced records under ``GET /records?model=...`` once
    a sync template has run. ``sync_name`` selects the named sync
    configured on the Nango side (default ``"documents"``); Whereas's
    Nango deployment ships a ``documents`` sync for each supported
    provider that yields rows of the shape ``NangoFile`` reads.
    """
    settings = _settings_or_default(settings)
    secret = _require_secret(settings)

    params: dict[str, Any] = {"model": sync_name}
    if cursor:
        params["cursor"] = cursor

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.get(
                f"{settings.NANGO_BASE_URL}/records",
                headers={
                    **_auth_headers(secret),
                    "Connection-Id": connection_id,
                    "Provider-Config-Key": provider,
                },
                params=params,
            )
        except httpx.HTTPError as exc:
            raise RetryableNangoError(
                f"Could not reach Nango: {type(exc).__name__}.",
            ) from exc

    _raise_for_status(response, what="list_files")
    body = _parse_json_or_502(response)
    records = body.get("records") or body.get("data") or []
    next_cursor = body.get("next_cursor") or body.get("next")
    files: list[NangoFile] = []
    if isinstance(records, list):
        for record in records:
            parsed = _parse_file_record(record)
            if parsed is not None:
                files.append(parsed)
    return files, next_cursor if isinstance(next_cursor, str) else None


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type(_RETRYABLE),
    reraise=True,
)
async def download_file(
    *,
    connection_id: str,
    provider: str,
    download_url: str,
    settings: Settings | None = None,
) -> bytes:
    """Fetch a file's bytes through the Nango proxy.

    ``download_url`` is either the value Nango returned in the file
    record (which may already be a Nango-proxied URL) or a path on
    ``NANGO_BASE_URL`` that needs the auth headers attached. Absolute
    URLs are honored as-is when they point at the configured Nango
    base; anything else is rejected so a poisoned record from a
    misbehaving sync cannot redirect us off-host.
    """
    settings = _settings_or_default(settings)
    secret = _require_secret(settings)

    url = _resolve_download_url(download_url, base_url=settings.NANGO_BASE_URL)

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.get(
                url,
                headers={
                    **_auth_headers(secret),
                    "Connection-Id": connection_id,
                    "Provider-Config-Key": provider,
                },
            )
        except httpx.HTTPError as exc:
            raise RetryableNangoError(
                f"Could not reach Nango: {type(exc).__name__}.",
            ) from exc

    _raise_for_status(response, what="download_file")
    if not response.content:
        raise NangoError("Nango returned an empty file body.")
    return response.content


# ---------------------------------------------------------------------------
# Webhook verification
# ---------------------------------------------------------------------------


def verify_webhook(
    *,
    headers: Any,
    body: bytes,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> None:
    """Verify an inbound Nango webhook.

    Nango signs webhooks with HMAC-SHA256 over the raw body, keyed on
    ``NANGO_WEBHOOK_SECRET``. The header value is
    ``"{timestamp}.{signature_hex}"`` where ``signature_hex`` is
    ``HMAC-SHA256(secret, "{timestamp}.{body}")``. A missing or stale
    timestamp, missing header, mismatched signature, or missing
    configured secret (in any non-development environment) is a hard
    fail. ``development`` accepts an unconfigured secret with a
    warning, matching the DocuSeal verifier's posture.
    """
    settings = _settings_or_default(settings)
    secret = (settings.NANGO_WEBHOOK_SECRET or "").strip()
    header_lookup = _CaseInsensitiveHeaders(headers)
    now = now or datetime.now(UTC)

    if not secret:
        if settings.ENVIRONMENT == "development":
            log.warning(
                "Accepting Nango webhook without verification "
                "(NANGO_WEBHOOK_SECRET unset; development only).",
            )
            return
        raise NangoWebhookVerificationError(
            "Webhook secret is not configured.",
            status_code=503,
        )

    sent = header_lookup.get(NANGO_SIGNATURE_HEADER)
    if not sent:
        raise NangoWebhookVerificationError("Webhook signature missing.")

    raw = sent.strip()
    if "." not in raw:
        raise NangoWebhookVerificationError("Webhook signature is malformed.")
    timestamp_str, _, signature = raw.partition(".")
    if not timestamp_str or not signature:
        raise NangoWebhookVerificationError("Webhook signature is malformed.")

    try:
        sent_ts = int(timestamp_str)
    except ValueError as exc:
        raise NangoWebhookVerificationError(
            "Webhook signature timestamp is malformed.",
        ) from exc

    skew = abs(int(now.timestamp()) - sent_ts)
    if skew > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS:
        raise NangoWebhookVerificationError("Webhook signature is stale.")

    signed_payload = timestamp_str.encode("ascii") + b"." + body
    expected = hmac.new(
        secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature.strip().lower()):
        raise NangoWebhookVerificationError("Webhook signature mismatch.")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _parse_json_or_502(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError as exc:
        raise NangoError("Nango returned a non-JSON response.") from exc
    if not isinstance(body, dict):
        raise NangoError("Nango returned an unexpected JSON shape.")
    return body


def _parse_file_record(record: Any) -> NangoFile | None:
    if not isinstance(record, dict):
        return None
    provider_file_id = record.get("id") or record.get("provider_file_id")
    if not isinstance(provider_file_id, str) or not provider_file_id:
        return None
    filename = record.get("name") or record.get("filename") or provider_file_id
    if not isinstance(filename, str) or not filename.strip():
        filename = provider_file_id
    mime_type = record.get("mime_type") or record.get("mimeType")
    if not isinstance(mime_type, str):
        mime_type = None
    size = record.get("size_bytes") or record.get("size")
    size_bytes: int | None
    if isinstance(size, int):
        size_bytes = size
    elif isinstance(size, str) and size.isdigit():
        size_bytes = int(size)
    else:
        size_bytes = None
    revision = record.get("revision") or record.get("etag") or record.get("version")
    if not isinstance(revision, str):
        revision = None
    download_url = (
        record.get("download_url")
        or record.get("downloadUrl")
        or record.get("url")
    )
    if not isinstance(download_url, str) or not download_url:
        download_url = None
    return NangoFile(
        provider_file_id=provider_file_id,
        filename=filename,
        mime_type=mime_type,
        size_bytes=size_bytes,
        revision=revision,
        download_url=download_url,
        metadata={k: v for k, v in record.items() if k not in {"download_url", "url"}},
    )


def _resolve_download_url(url: str, *, base_url: str) -> str:
    """Resolve a download URL strictly against the configured Nango base.

    Absolute URLs that don't share the Nango host are rejected — a
    misbehaving Nango sync result must not be able to coerce Whereas
    into fetching arbitrary URLs. Relative paths are joined to
    ``base_url``.
    """
    if url.startswith("/"):
        return f"{base_url.rstrip('/')}{url}"
    if url.startswith(f"{base_url.rstrip('/')}/") or url == base_url.rstrip("/"):
        return url
    raise NangoError(
        "Refusing to fetch a download URL outside the configured Nango host.",
    )


class _CaseInsensitiveHeaders:
    """Tiny case-insensitive header lookup.

    Mirrors the helper in ``docuseal_bridge`` so the two webhook
    verifiers behave identically when tests pass plain dicts.
    """

    def __init__(self, headers: Any) -> None:
        self._normalized = {
            (k.lower() if isinstance(k, str) else k): v
            for k, v in (
                headers.items() if hasattr(headers, "items") else headers
            )
        }

    def get(self, name: str) -> str | None:
        value = self._normalized.get(name.lower())
        return value if isinstance(value, str) else None
