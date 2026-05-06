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

from dataclasses import dataclass


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

    def __init__(self, settings) -> None:  # type: ignore[no-untyped-def]
        raise NotImplementedError

    async def store_encrypted(
        self,
        *,
        plaintext_bytes: bytes,
        document_id: str,
        org_master_key: bytes,
    ) -> StoredDocument:
        raise NotImplementedError

    async def retrieve_decrypted(
        self,
        *,
        s3_key: str,
        document_id: str,
        wrapped_dek_bytes: bytes,
        org_master_key: bytes,
        expected_blob_sha256: str | None = None,
    ) -> bytes:
        raise NotImplementedError

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
        raise NotImplementedError

    async def delete(self, *, s3_key: str) -> None:
        raise NotImplementedError

    async def ensure_bucket_exists(self) -> None:
        raise NotImplementedError
