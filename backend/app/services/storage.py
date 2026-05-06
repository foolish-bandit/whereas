"""Encrypted document storage adapter.

Stores documents in S3 (or any S3-compatible backend, e.g. MinIO) with the
ciphertext-on-disk produced by `app.security.encryption.encrypt_document`.

Threat model: an attacker who compromises Postgres alone or S3 alone cannot
decrypt documents. They need both stores plus the in-memory org master key
(derived from WHEREAS_INSTANCE_KEY) to read content. The wrapped DEK lives
in Postgres alongside contract metadata; the ciphertext blob lives in S3.

This module is a pure adapter:
  - It does not generate document IDs (the API layer owns that).
  - It does not persist anything to Postgres (the caller stores the
    `wrapped_dek_bytes` returned in `StoredDocument`).
  - It does not cache plaintext, decrypted bytes, or org master keys at the
    module level. Decrypted content lives only on the request stack.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError

from app.security.encryption import (
    WrappedKey,
    decrypt_document,
    encrypt_document,
)

if TYPE_CHECKING:
    from app.core.config import Settings

log = logging.getLogger(__name__)

_S3_KEY_PREFIX = "documents"
# Error codes S3/MinIO use to indicate "the bucket isn't there yet."
_BUCKET_MISSING_CODES = frozenset({"404", "NoSuchBucket", "NotFound"})
# Codes that mean "someone else (or a previous startup) already created it."
_BUCKET_EXISTS_CODES = frozenset({"BucketAlreadyOwnedByYou", "BucketAlreadyExists"})


@dataclass(frozen=True)
class StoredDocument:
    """The result of storing one encrypted document.

    `wrapped_dek_bytes` is the `WrappedKey.to_bytes()` form, ready for
    Postgres BYTEA storage. `encrypted_blob_sha256` is the sha256 hex digest
    of the ciphertext blob (NOT the plaintext) and exists so the caller can
    pass it back to `retrieve_decrypted` for end-to-end integrity verification.
    `size_bytes` is the size of the ciphertext blob, useful for quotas/audit.
    """

    s3_key: str
    wrapped_dek_bytes: bytes
    encrypted_blob_sha256: str
    size_bytes: int


class StorageIntegrityError(Exception):
    """The fetched encrypted blob's sha256 did not match the expected value.

    Distinct from `EncryptionError` so incident response can route an
    integrity-hash mismatch (likely tampering or replication corruption)
    differently from a GCM-tag failure (likely tampering, key mismatch, or
    document_id swap).
    """


class DocumentStorage:
    """Per-deployment storage adapter.

    Construct one with the application `Settings`. Methods are async and
    safe to call from FastAPI request handlers; the underlying boto3
    client is created lazily on first use so tests can monkeypatch the
    construction path.
    """

    def __init__(self, settings: Settings) -> None:
        self._endpoint = settings.S3_ENDPOINT
        self._access_key = settings.S3_ACCESS_KEY
        self._secret_key = settings.S3_SECRET_KEY
        self._bucket = settings.S3_BUCKET
        self._region = settings.S3_REGION
        self._client: Any | None = None

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = boto3.client(
                "s3",
                endpoint_url=self._endpoint or None,
                aws_access_key_id=self._access_key,
                aws_secret_access_key=self._secret_key,
                region_name=self._region,
            )
        return self._client

    @staticmethod
    def _s3_key_for(document_id: str) -> str:
        return f"{_S3_KEY_PREFIX}/{document_id}.enc"

    async def store_encrypted(
        self,
        *,
        plaintext_bytes: bytes,
        document_id: str,
        org_master_key: bytes,
    ) -> StoredDocument:
        """Encrypt `plaintext_bytes` and upload the ciphertext to S3.

        Returns a `StoredDocument` carrying the S3 key, the serialized wrapped
        DEK (for the caller to persist in Postgres), the sha256 of the
        ciphertext blob, and its size. The plaintext is never written to disk
        or logged.
        """
        encrypted_doc, wrapped_dek = encrypt_document(
            plaintext=plaintext_bytes,
            document_id=document_id,
            org_master_key=org_master_key,
        )
        # Best effort: drop the local reference to the master key now that the
        # encryption call has consumed it. Python doesn't guarantee zeroing of
        # immutable bytes, but we shouldn't extend its lifetime.
        del org_master_key

        blob = encrypted_doc.to_bytes()
        s3_key = self._s3_key_for(document_id)
        client = self._get_client()
        await asyncio.to_thread(
            client.put_object,
            Bucket=self._bucket,
            Key=s3_key,
            Body=blob,
        )
        log.info(
            "Stored encrypted document",
            extra={
                "document_id": document_id,
                "s3_key": s3_key,
                "size_bytes": len(blob),
            },
        )
        return StoredDocument(
            s3_key=s3_key,
            wrapped_dek_bytes=wrapped_dek.to_bytes(),
            encrypted_blob_sha256=hashlib.sha256(blob).hexdigest(),
            size_bytes=len(blob),
        )

    async def retrieve_decrypted(
        self,
        *,
        s3_key: str,
        document_id: str,
        wrapped_dek_bytes: bytes,
        org_master_key: bytes,
        expected_blob_sha256: str | None = None,
    ) -> bytes:
        """Fetch the ciphertext blob from S3 and decrypt it.

        If `expected_blob_sha256` is provided, the sha256 of the fetched blob
        is verified BEFORE decryption is attempted. A mismatch raises
        `StorageIntegrityError`, distinct from the `EncryptionError` raised
        by a GCM-tag failure inside `decrypt_document`. When
        `expected_blob_sha256` is None (the default), no hash is computed —
        this is intentional, so the cheap-read path stays cheap.

        Cryptographic failures from the encryption layer (`EncryptionError`)
        propagate unchanged; the storage layer must not obscure them.
        """
        wrapped_dek = WrappedKey.from_bytes(wrapped_dek_bytes)

        client = self._get_client()
        response = await asyncio.to_thread(
            client.get_object,
            Bucket=self._bucket,
            Key=s3_key,
        )
        blob = await asyncio.to_thread(response["Body"].read)

        if expected_blob_sha256 is not None:
            actual = hashlib.sha256(blob).hexdigest()
            if actual != expected_blob_sha256:
                log.error(
                    "Encrypted blob sha256 mismatch",
                    extra={"document_id": document_id, "s3_key": s3_key},
                )
                raise StorageIntegrityError(
                    f"Encrypted blob sha256 mismatch for {s3_key!r}: "
                    f"expected {expected_blob_sha256}, got {actual}"
                )

        plaintext = decrypt_document(
            encrypted_blob=blob,
            document_id=document_id,
            wrapped_dek=wrapped_dek,
            org_master_key=org_master_key,
        )
        del org_master_key

        log.info(
            "Retrieved encrypted document",
            extra={"document_id": document_id, "s3_key": s3_key},
        )
        return plaintext

    def presigned_download_url(
        self, *, s3_key: str, ttl_seconds: int = 300
    ) -> str:
        """Generate a presigned GET URL for the raw ciphertext blob.

        Callers should use `retrieve_decrypted()` for serving documents to
        authenticated users. This presigned URL serves CIPHERTEXT, which is
        useless without the wrapped DEK and org master key. Use it only for
        ciphertext-level operations (backups, replication) where the caller
        will handle decryption out-of-band.
        """
        client = self._get_client()
        return client.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": self._bucket, "Key": s3_key},
            ExpiresIn=ttl_seconds,
        )

    async def delete(self, *, s3_key: str) -> None:
        """Delete an encrypted document blob.

        Idempotent: S3's `delete_object` returns success whether or not the
        key existed. Used for deletion-compliance flows.
        """
        client = self._get_client()
        await asyncio.to_thread(
            client.delete_object,
            Bucket=self._bucket,
            Key=s3_key,
        )
        log.info("Deleted encrypted document", extra={"s3_key": s3_key})

    async def ensure_bucket_exists(self) -> None:
        """Create the configured bucket if it doesn't exist; idempotent.

        Attempts to enable bucket-level SSE-S3 after creation. On MinIO and
        other S3-compatible backends that don't implement SSE configuration,
        this step logs a warning and continues — bucket existence is the
        load-bearing outcome here, not server-side encryption (we encrypt
        at the application layer regardless).
        """
        client = self._get_client()

        try:
            await asyncio.to_thread(client.head_bucket, Bucket=self._bucket)
            return
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code not in _BUCKET_MISSING_CODES:
                raise

        params: dict[str, Any] = {"Bucket": self._bucket}
        if self._region and self._region != "us-east-1":
            params["CreateBucketConfiguration"] = {
                "LocationConstraint": self._region
            }
        try:
            await asyncio.to_thread(client.create_bucket, **params)
            log.info("Created S3 bucket", extra={"bucket": self._bucket})
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code not in _BUCKET_EXISTS_CODES:
                raise

        try:
            await asyncio.to_thread(
                client.put_bucket_encryption,
                Bucket=self._bucket,
                ServerSideEncryptionConfiguration={
                    "Rules": [
                        {
                            "ApplyServerSideEncryptionByDefault": {
                                "SSEAlgorithm": "AES256",
                            },
                        },
                    ],
                },
            )
        except ClientError as e:
            log.warning(
                "Bucket-level SSE not configured (backend may not support it)",
                extra={
                    "bucket": self._bucket,
                    "error_code": e.response.get("Error", {}).get("Code", ""),
                },
            )
