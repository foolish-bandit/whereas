"""Tests for document encryption.

This is the most security-critical code in Whereas. If it breaks silently,
documents become readable to anyone with database access. Test thoroughly.
"""
import os
import secrets

import pytest

from app.security.encryption import (
    EncryptionError,
    WrappedKey,
    create_org_master_key,
    decrypt_document,
    encrypt_document,
    generate_key,
    load_instance_key,
    load_org_master_key,
    unwrap_key,
    wrap_key,
)


@pytest.fixture
def instance_key() -> bytes:
    return secrets.token_bytes(32)


@pytest.fixture
def org_master_key(instance_key: bytes) -> bytes:
    wrapped = create_org_master_key(organization_id="test-org", instance_key=instance_key)
    return load_org_master_key(
        wrapped_master_key=wrapped,
        organization_id="test-org",
        instance_key=instance_key,
    )


class TestInstanceKeyLoading:
    def test_loads_valid_hex_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        key_hex = secrets.token_hex(32)
        monkeypatch.setenv("WHEREAS_INSTANCE_KEY", key_hex)
        loaded = load_instance_key()
        assert len(loaded) == 32
        assert loaded == bytes.fromhex(key_hex)

    def test_rejects_missing_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("WHEREAS_INSTANCE_KEY", raising=False)
        with pytest.raises(EncryptionError, match="not set"):
            load_instance_key()

    def test_rejects_non_hex(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("WHEREAS_INSTANCE_KEY", "not-hex-at-all-zzzzzzz")
        with pytest.raises(EncryptionError, match="hex"):
            load_instance_key()

    def test_rejects_wrong_length(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("WHEREAS_INSTANCE_KEY", "deadbeef")
        with pytest.raises(EncryptionError, match="bytes"):
            load_instance_key()


class TestKeyWrapping:
    def test_roundtrip(self) -> None:
        wrapping = generate_key()
        target = generate_key()
        wrapped = wrap_key(key_to_wrap=target, wrapping_key=wrapping, aad=b"context")
        recovered = unwrap_key(wrapped=wrapped, wrapping_key=wrapping, aad=b"context")
        assert recovered == target

    def test_wrong_aad_rejected(self) -> None:
        wrapping = generate_key()
        target = generate_key()
        wrapped = wrap_key(key_to_wrap=target, wrapping_key=wrapping, aad=b"correct")
        with pytest.raises(EncryptionError):
            unwrap_key(wrapped=wrapped, wrapping_key=wrapping, aad=b"wrong")

    def test_wrong_wrapping_key_rejected(self) -> None:
        target = generate_key()
        wrapped = wrap_key(key_to_wrap=target, wrapping_key=generate_key(), aad=b"x")
        with pytest.raises(EncryptionError):
            unwrap_key(wrapped=wrapped, wrapping_key=generate_key(), aad=b"x")

    def test_tampered_wrapped_key_rejected(self) -> None:
        wrapping = generate_key()
        target = generate_key()
        wrapped = wrap_key(key_to_wrap=target, wrapping_key=wrapping, aad=b"x")
        tampered = WrappedKey(
            nonce=wrapped.nonce,
            ciphertext=bytes([wrapped.ciphertext[0] ^ 1]) + wrapped.ciphertext[1:],
        )
        with pytest.raises(EncryptionError):
            unwrap_key(wrapped=tampered, wrapping_key=wrapping, aad=b"x")

    def test_wrong_size_key_rejected(self) -> None:
        with pytest.raises(EncryptionError):
            wrap_key(key_to_wrap=b"too-short", wrapping_key=generate_key(), aad=b"x")
        with pytest.raises(EncryptionError):
            wrap_key(key_to_wrap=generate_key(), wrapping_key=b"too-short", aad=b"x")


class TestWrappedKeySerialization:
    def test_roundtrip_bytes(self) -> None:
        wrapping = generate_key()
        wrapped = wrap_key(key_to_wrap=generate_key(), wrapping_key=wrapping, aad=b"x")
        as_bytes = wrapped.to_bytes()
        restored = WrappedKey.from_bytes(as_bytes)
        assert restored.nonce == wrapped.nonce
        assert restored.ciphertext == wrapped.ciphertext

    def test_rejects_short_blob(self) -> None:
        with pytest.raises(ValueError):
            WrappedKey.from_bytes(b"too-short")


class TestDocumentEncryption:
    def test_roundtrip_small_doc(self, org_master_key: bytes) -> None:
        plaintext = b"This is a confidential agreement."
        enc, wrapped_dek = encrypt_document(
            plaintext=plaintext, document_id="doc-1", org_master_key=org_master_key
        )
        recovered = decrypt_document(
            encrypted_blob=enc.to_bytes(),
            document_id="doc-1",
            wrapped_dek=wrapped_dek,
            org_master_key=org_master_key,
        )
        assert recovered == plaintext

    def test_roundtrip_large_doc(self, org_master_key: bytes) -> None:
        plaintext = secrets.token_bytes(5 * 1024 * 1024)  # 5MB
        enc, wrapped_dek = encrypt_document(
            plaintext=plaintext, document_id="big-doc", org_master_key=org_master_key
        )
        recovered = decrypt_document(
            encrypted_blob=enc.to_bytes(),
            document_id="big-doc",
            wrapped_dek=wrapped_dek,
            org_master_key=org_master_key,
        )
        assert recovered == plaintext

    def test_empty_document_works(self, org_master_key: bytes) -> None:
        enc, wrapped_dek = encrypt_document(
            plaintext=b"", document_id="empty", org_master_key=org_master_key
        )
        recovered = decrypt_document(
            encrypted_blob=enc.to_bytes(),
            document_id="empty",
            wrapped_dek=wrapped_dek,
            org_master_key=org_master_key,
        )
        assert recovered == b""

    def test_swapped_document_id_rejected(self, org_master_key: bytes) -> None:
        """Critical: the document_id is bound into the AAD, so an attacker who
        swaps wrapped DEKs between document records gets caught."""
        enc, wrapped_dek = encrypt_document(
            plaintext=b"secret", document_id="doc-A", org_master_key=org_master_key
        )
        with pytest.raises(EncryptionError):
            decrypt_document(
                encrypted_blob=enc.to_bytes(),
                document_id="doc-B",  # different from what was encrypted
                wrapped_dek=wrapped_dek,
                org_master_key=org_master_key,
            )

    def test_tampered_ciphertext_rejected(self, org_master_key: bytes) -> None:
        enc, wrapped_dek = encrypt_document(
            plaintext=b"important contract terms",
            document_id="doc-X",
            org_master_key=org_master_key,
        )
        blob = bytearray(enc.to_bytes())
        # Flip a byte in the middle of the ciphertext
        blob[len(blob) // 2] ^= 0x01
        with pytest.raises(EncryptionError):
            decrypt_document(
                encrypted_blob=bytes(blob),
                document_id="doc-X",
                wrapped_dek=wrapped_dek,
                org_master_key=org_master_key,
            )

    def test_wrong_org_master_key_rejected(self, instance_key: bytes) -> None:
        wrapped_a = create_org_master_key(organization_id="org-a", instance_key=instance_key)
        wrapped_b = create_org_master_key(organization_id="org-b", instance_key=instance_key)
        master_a = load_org_master_key(
            wrapped_master_key=wrapped_a, organization_id="org-a", instance_key=instance_key
        )
        master_b = load_org_master_key(
            wrapped_master_key=wrapped_b, organization_id="org-b", instance_key=instance_key
        )

        enc, wrapped_dek = encrypt_document(
            plaintext=b"org-a secret", document_id="doc-1", org_master_key=master_a
        )
        with pytest.raises(EncryptionError):
            decrypt_document(
                encrypted_blob=enc.to_bytes(),
                document_id="doc-1",
                wrapped_dek=wrapped_dek,
                org_master_key=master_b,  # cross-org attempt
            )

    def test_each_encryption_produces_different_ciphertext(self, org_master_key: bytes) -> None:
        """Same plaintext, same key, different output - confirms nonce randomness."""
        plaintext = b"identical document"
        enc1, _ = encrypt_document(
            plaintext=plaintext, document_id="d", org_master_key=org_master_key
        )
        enc2, _ = encrypt_document(
            plaintext=plaintext, document_id="d", org_master_key=org_master_key
        )
        assert enc1.ciphertext != enc2.ciphertext
        assert enc1.nonce != enc2.nonce


class TestOrgMasterKeyLifecycle:
    def test_swapped_org_id_rejected(self, instance_key: bytes) -> None:
        """The org master key wrap binds the org id; can't be moved between orgs."""
        wrapped = create_org_master_key(organization_id="org-real", instance_key=instance_key)
        with pytest.raises(EncryptionError):
            load_org_master_key(
                wrapped_master_key=wrapped,
                organization_id="org-fake",
                instance_key=instance_key,
            )

    def test_wrong_instance_key_rejected(self) -> None:
        wrapped = create_org_master_key(organization_id="org-x", instance_key=secrets.token_bytes(32))
        with pytest.raises(EncryptionError):
            load_org_master_key(
                wrapped_master_key=wrapped,
                organization_id="org-x",
                instance_key=secrets.token_bytes(32),
            )
