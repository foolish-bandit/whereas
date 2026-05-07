"""Tests for the encrypted storage adapter.

Exhaustive coverage matching test_encryption.py — anything that calls into
app.security.encryption deserves the same rigor. The load-bearing security
properties tested here are: tamper detection, AAD-binding survival across
the storage round-trip, and integrity-hash short-circuiting before
cryptographic decryption.
"""
from __future__ import annotations

import logging
import secrets
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError

pytest.importorskip("moto")
from moto import mock_aws

from app.security.encryption import (
    EncryptionError,
    create_org_master_key,
    load_org_master_key,
)
from app.services.storage import (
    DocumentStorage,
    StorageIntegrityError,
    StoredDocument,
)

# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

_BUCKET = "whereas-test-bucket"


class _FakeSettings:
    S3_ENDPOINT: str | None = None  # let boto3 default; moto patches it
    S3_ACCESS_KEY: str = "testing"
    S3_SECRET_KEY: str = "testing"
    S3_BUCKET: str = _BUCKET
    S3_REGION: str = "us-east-1"


@pytest.fixture(autouse=True)
def _aws_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin moto onto fake creds so a misconfigured test never reaches AWS."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")


@pytest.fixture
def mocked_s3() -> Iterator[None]:
    with mock_aws():
        yield


@pytest.fixture
def settings() -> _FakeSettings:
    return _FakeSettings()


@pytest.fixture
async def storage(
    mocked_s3: None, settings: _FakeSettings
) -> DocumentStorage:
    s = DocumentStorage(settings)  # type: ignore[arg-type]
    await s.ensure_bucket_exists()
    return s


@pytest.fixture
def admin_client(mocked_s3: None) -> Any:
    """Raw boto3 client for inspecting/mutating S3 directly in tests."""
    return boto3.client("s3", region_name="us-east-1")


@pytest.fixture
def instance_key() -> bytes:
    return secrets.token_bytes(32)


@pytest.fixture
def org_master_key(instance_key: bytes) -> bytes:
    wrapped = create_org_master_key(
        organization_id="org-a", instance_key=instance_key
    )
    return load_org_master_key(
        wrapped_master_key=wrapped,
        organization_id="org-a",
        instance_key=instance_key,
    )


@pytest.fixture
def org_master_key_b(instance_key: bytes) -> bytes:
    wrapped = create_org_master_key(
        organization_id="org-b", instance_key=instance_key
    )
    return load_org_master_key(
        wrapped_master_key=wrapped,
        organization_id="org-b",
        instance_key=instance_key,
    )


# --------------------------------------------------------------------------
# Roundtrip
# --------------------------------------------------------------------------


class TestRoundtrip:
    async def test_store_and_retrieve_returns_exact_bytes(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        plaintext = b"This is a confidential agreement signed Jan 1, 2025."
        result = await storage.store_encrypted(
            plaintext_bytes=plaintext,
            document_id="doc-1",
            org_master_key=org_master_key,
        )
        recovered = await storage.retrieve_decrypted(
            s3_key=result.s3_key,
            document_id="doc-1",
            wrapped_dek_bytes=result.wrapped_dek_bytes,
            org_master_key=org_master_key,
        )
        assert recovered == plaintext

    async def test_stored_document_has_expected_shape(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        plaintext = b"hello world"
        result = await storage.store_encrypted(
            plaintext_bytes=plaintext,
            document_id="abc-123",
            org_master_key=org_master_key,
        )
        assert isinstance(result, StoredDocument)
        assert result.s3_key == "documents/abc-123.enc"
        assert isinstance(result.wrapped_dek_bytes, bytes)
        assert len(result.wrapped_dek_bytes) > 0
        assert len(result.encrypted_blob_sha256) == 64  # sha256 hex
        assert all(c in "0123456789abcdef" for c in result.encrypted_blob_sha256)
        assert result.size_bytes == len(plaintext) + 28

    async def test_retrieve_after_metadata_persistence_boundary(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        plaintext = b"terms survive process restart"
        result = await storage.store_encrypted(
            plaintext_bytes=plaintext,
            document_id="persisted-doc",
            org_master_key=org_master_key,
        )
        persisted_s3_key = bytes(result.s3_key, "utf-8").decode("utf-8")
        persisted_wrapped_dek = bytes(result.wrapped_dek_bytes)
        persisted_document_id = "persisted-doc"
        persisted_blob_hash = result.encrypted_blob_sha256

        recovered = await storage.retrieve_decrypted(
            s3_key=persisted_s3_key,
            document_id=persisted_document_id,
            wrapped_dek_bytes=persisted_wrapped_dek,
            org_master_key=org_master_key,
            expected_blob_sha256=persisted_blob_hash,
        )

        assert recovered == plaintext

    async def test_blob_in_s3_is_ciphertext_not_plaintext(
        self,
        storage: DocumentStorage,
        admin_client: Any,
        org_master_key: bytes,
    ) -> None:
        plaintext = b"PLAINTEXT_SENTINEL_UNIQUE_STRING_001"
        result = await storage.store_encrypted(
            plaintext_bytes=plaintext,
            document_id="d",
            org_master_key=org_master_key,
        )
        body = admin_client.get_object(Bucket=_BUCKET, Key=result.s3_key)[
            "Body"
        ].read()
        assert plaintext not in body


# --------------------------------------------------------------------------
# Tampering at rest
# --------------------------------------------------------------------------


class TestTamperingAtRest:
    async def test_flipped_byte_in_ciphertext_rejected(
        self,
        storage: DocumentStorage,
        admin_client: Any,
        org_master_key: bytes,
    ) -> None:
        result = await storage.store_encrypted(
            plaintext_bytes=b"important contract terms",
            document_id="doc-x",
            org_master_key=org_master_key,
        )
        body = admin_client.get_object(Bucket=_BUCKET, Key=result.s3_key)[
            "Body"
        ].read()
        mutated = bytearray(body)
        mutated[len(mutated) // 2] ^= 0x01
        admin_client.put_object(
            Bucket=_BUCKET, Key=result.s3_key, Body=bytes(mutated)
        )

        with pytest.raises(EncryptionError):
            await storage.retrieve_decrypted(
                s3_key=result.s3_key,
                document_id="doc-x",
                wrapped_dek_bytes=result.wrapped_dek_bytes,
                org_master_key=org_master_key,
            )


# --------------------------------------------------------------------------
# Swap attacks (AAD bindings must survive serialization + storage)
# --------------------------------------------------------------------------


class TestSwapAttacks:
    async def test_wrong_document_id_rejected(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        result = await storage.store_encrypted(
            plaintext_bytes=b"secret-A",
            document_id="doc-A",
            org_master_key=org_master_key,
        )
        with pytest.raises(EncryptionError):
            await storage.retrieve_decrypted(
                s3_key=result.s3_key,
                document_id="doc-B",  # wrong id
                wrapped_dek_bytes=result.wrapped_dek_bytes,
                org_master_key=org_master_key,
            )

    async def test_wrong_org_master_key_rejected(
        self,
        storage: DocumentStorage,
        org_master_key: bytes,
        org_master_key_b: bytes,
    ) -> None:
        result = await storage.store_encrypted(
            plaintext_bytes=b"org-a only",
            document_id="doc-1",
            org_master_key=org_master_key,
        )
        with pytest.raises(EncryptionError):
            await storage.retrieve_decrypted(
                s3_key=result.s3_key,
                document_id="doc-1",
                wrapped_dek_bytes=result.wrapped_dek_bytes,
                org_master_key=org_master_key_b,  # wrong org
            )

    async def test_wrong_wrapped_dek_rejected(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        result_a = await storage.store_encrypted(
            plaintext_bytes=b"first",
            document_id="doc-1",
            org_master_key=org_master_key,
        )
        result_b = await storage.store_encrypted(
            plaintext_bytes=b"second",
            document_id="doc-2",
            org_master_key=org_master_key,
        )
        with pytest.raises(EncryptionError):
            await storage.retrieve_decrypted(
                s3_key=result_a.s3_key,
                document_id="doc-1",
                wrapped_dek_bytes=result_b.wrapped_dek_bytes,  # wrong DEK
                org_master_key=org_master_key,
            )


# --------------------------------------------------------------------------
# Integrity (expected_blob_sha256)
# --------------------------------------------------------------------------


class TestIntegrity:
    async def test_correct_expected_sha256_passes(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        plaintext = b"matches its hash"
        result = await storage.store_encrypted(
            plaintext_bytes=plaintext,
            document_id="d",
            org_master_key=org_master_key,
        )
        recovered = await storage.retrieve_decrypted(
            s3_key=result.s3_key,
            document_id="d",
            wrapped_dek_bytes=result.wrapped_dek_bytes,
            org_master_key=org_master_key,
            expected_blob_sha256=result.encrypted_blob_sha256,
        )
        assert recovered == plaintext

    async def test_wrong_expected_sha256_raises_storage_error(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        result = await storage.store_encrypted(
            plaintext_bytes=b"x",
            document_id="d",
            org_master_key=org_master_key,
        )
        with pytest.raises(StorageIntegrityError) as exc_info:
            await storage.retrieve_decrypted(
                s3_key=result.s3_key,
                document_id="d",
                wrapped_dek_bytes=result.wrapped_dek_bytes,
                org_master_key=org_master_key,
                expected_blob_sha256="0" * 64,
            )
        # Message should help incident response distinguish from EncryptionError.
        assert "sha256 mismatch" in str(exc_info.value).lower()

    async def test_sha256_not_computed_when_default(
        self,
        storage: DocumentStorage,
        org_master_key: bytes,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Guards against a future 'improvement' that always computes the
        ciphertext hash. When expected_blob_sha256 is None the cheap-read
        path stays cheap.
        """
        result = await storage.store_encrypted(
            plaintext_bytes=b"ciphertext",
            document_id="d",
            org_master_key=org_master_key,
        )

        from app.services import storage as storage_module

        call_count = {"n": 0}
        original_sha256 = storage_module.hashlib.sha256

        def counting_sha256(data: bytes = b"") -> Any:
            call_count["n"] += 1
            return original_sha256(data)

        monkeypatch.setattr(storage_module.hashlib, "sha256", counting_sha256)

        await storage.retrieve_decrypted(
            s3_key=result.s3_key,
            document_id="d",
            wrapped_dek_bytes=result.wrapped_dek_bytes,
            org_master_key=org_master_key,
        )
        assert call_count["n"] == 0


# --------------------------------------------------------------------------
# Presigned URL
# --------------------------------------------------------------------------


class TestPresignedUrl:
    def test_returns_url_targeting_correct_key(
        self, storage: DocumentStorage
    ) -> None:
        url = storage.presigned_download_url(s3_key="documents/d.enc")
        assert isinstance(url, str)
        assert len(url) > 0
        assert "documents/d.enc" in url

    def test_includes_expiry_parameter(
        self, storage: DocumentStorage
    ) -> None:
        url = storage.presigned_download_url(
            s3_key="documents/d.enc", ttl_seconds=120
        )
        # SigV4 uses X-Amz-Expires; legacy v2 uses Expires=. Match either.
        assert ("X-Amz-Expires=" in url) or ("Expires=" in url)


# --------------------------------------------------------------------------
# Delete
# --------------------------------------------------------------------------


class TestDelete:
    async def test_delete_then_retrieve_raises_clienterror(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        result = await storage.store_encrypted(
            plaintext_bytes=b"goodbye",
            document_id="d",
            org_master_key=org_master_key,
        )
        await storage.delete(s3_key=result.s3_key)
        # boto3 raises ClientError NoSuchKey, NOT EncryptionError.
        with pytest.raises(ClientError) as exc_info:
            await storage.retrieve_decrypted(
                s3_key=result.s3_key,
                document_id="d",
                wrapped_dek_bytes=result.wrapped_dek_bytes,
                org_master_key=org_master_key,
            )
        assert exc_info.value.response["Error"]["Code"] == "NoSuchKey"

    async def test_delete_is_idempotent(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        result = await storage.store_encrypted(
            plaintext_bytes=b"x",
            document_id="d",
            org_master_key=org_master_key,
        )
        await storage.delete(s3_key=result.s3_key)
        # Second delete on the now-missing key must not raise.
        await storage.delete(s3_key=result.s3_key)


# --------------------------------------------------------------------------
# Bucket idempotency
# --------------------------------------------------------------------------


class TestBucketIdempotency:
    async def test_ensure_bucket_exists_twice(
        self, storage: DocumentStorage
    ) -> None:
        # The storage fixture already invoked ensure_bucket_exists once;
        # a second call must not raise.
        await storage.ensure_bucket_exists()


# --------------------------------------------------------------------------
# Size overhead
# --------------------------------------------------------------------------


class TestSizeOverhead:
    async def test_overhead_is_exactly_28_bytes(
        self, storage: DocumentStorage, org_master_key: bytes
    ) -> None:
        plaintext = secrets.token_bytes(10 * 1024 * 1024)  # 10 MiB
        result = await storage.store_encrypted(
            plaintext_bytes=plaintext,
            document_id="big",
            org_master_key=org_master_key,
        )
        # nonce (12) + GCM tag (16) = 28 bytes total overhead.
        assert result.size_bytes == len(plaintext) + 28


# --------------------------------------------------------------------------
# No leakage in logs
# --------------------------------------------------------------------------


_PLAINTEXT_SENTINEL = b"PLAINTEXT_SENTINEL_DO_NOT_LOG_42"


class TestNoLeakageInLogs:
    async def test_logs_never_contain_plaintext_or_master_key(
        self,
        storage: DocumentStorage,
        org_master_key: bytes,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.DEBUG):
            result = await storage.store_encrypted(
                plaintext_bytes=_PLAINTEXT_SENTINEL,
                document_id="d",
                org_master_key=org_master_key,
            )
            await storage.retrieve_decrypted(
                s3_key=result.s3_key,
                document_id="d",
                wrapped_dek_bytes=result.wrapped_dek_bytes,
                org_master_key=org_master_key,
            )

        # Treat every record attribute as fair game in the leak check; the
        # adapter shouldn't be putting key material or plaintext anywhere.
        master_key_hex = org_master_key.hex()
        plaintext_str = _PLAINTEXT_SENTINEL.decode()
        for record in caplog.records:
            text = " ".join(
                str(v)
                for v in (record.getMessage(), *vars(record).values())
            )
            assert plaintext_str not in text, (
                f"Plaintext leaked into log record: {record.name} {record.levelname}"
            )
            assert master_key_hex not in text, (
                f"Master key leaked into log record: {record.name} {record.levelname}"
            )
