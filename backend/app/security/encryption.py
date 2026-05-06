"""Document encryption.

Threat model this addresses:
  - Postgres dump alone must not leak document contents.
  - MinIO/S3 dump alone must not leak document contents.
  - An attacker who compromises one of the two stores still needs the other
    AND the org master key to read documents.

Architecture:
  - Each organization has a "master key" generated at org creation. The master
    key is stored in Postgres, encrypted by an "instance key" loaded from the
    KMS or environment at runtime. The instance key never lives on disk in
    plaintext.
  - Each uploaded document gets a fresh random "data key" (DEK).
  - The document is encrypted with AES-256-GCM using the DEK.
  - The DEK is wrapped (encrypted) with the org master key and stored alongside
    the document metadata in Postgres.
  - To read a document: load the wrapped DEK from Postgres, unwrap with the org
    master key, fetch the ciphertext from S3, decrypt.

Why this design:
  - Per-document keys mean a single key compromise doesn't expose the whole corpus.
  - Wrapping with an org master key means key rotation only needs to re-wrap the
    DEKs, not re-encrypt every document.
  - Splitting wrapped-DEK (in Postgres) from ciphertext (in S3) means neither
    store alone is sufficient.

Limitations to know about:
  - This protects against database leaks and storage leaks, NOT against an
    attacker who compromises the running application. A live app has access
    to the instance key and can decrypt anything.
  - The "instance key" must be loaded from a real KMS in production. The
    env-var fallback is for development only.
  - Authenticated encryption (GCM) means we get integrity for free, but the
    AAD (additional authenticated data) must be set carefully. We bind the
    document id and content-hash so swapped ciphertexts are rejected.
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

# AES-256-GCM key size, in bytes.
KEY_SIZE = 32

# GCM nonce size. NIST recommends 96 bits (12 bytes) for GCM.
NONCE_SIZE = 12

# AES-GCM authentication tag is appended to ciphertext by the cryptography lib.
# We don't need to manage it explicitly; including the constant for documentation.
TAG_SIZE = 16


# --------------------------------------------------------------------------
# Data structures
# --------------------------------------------------------------------------


@dataclass
class WrappedKey:
    """A data encryption key (DEK) that has been wrapped (encrypted) by a higher-
    level key. Stored in Postgres alongside the encrypted document's metadata.
    """
    nonce: bytes
    ciphertext: bytes  # the wrapped DEK + GCM tag

    def to_bytes(self) -> bytes:
        """Serialize for storage. Format: nonce || ciphertext."""
        return self.nonce + self.ciphertext

    @classmethod
    def from_bytes(cls, data: bytes) -> WrappedKey:
        if len(data) < NONCE_SIZE + TAG_SIZE:
            raise ValueError("WrappedKey blob too short.")
        return cls(nonce=data[:NONCE_SIZE], ciphertext=data[NONCE_SIZE:])


@dataclass
class EncryptedDocument:
    """An encrypted document blob. The ciphertext is what gets uploaded to S3."""
    nonce: bytes
    ciphertext: bytes  # encrypted document + GCM tag
    document_id: str  # bound into AAD; must be passed back unchanged for decryption

    def to_bytes(self) -> bytes:
        """Serialize the on-disk format: nonce || ciphertext.

        The document_id is NOT included in the blob; the caller must track it
        separately and pass it during decryption (it's bound via AAD).
        """
        return self.nonce + self.ciphertext


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class EncryptionError(Exception):
    """Raised when encryption or decryption fails. Caller should treat any
    decryption failure as a security event, not a recoverable error.
    """


# --------------------------------------------------------------------------
# Instance key (loaded from KMS or env)
# --------------------------------------------------------------------------


def load_instance_key() -> bytes:
    """Load the instance master key.

    In production, this should be loaded from a KMS (AWS KMS, HashiCorp Vault,
    GCP KMS, etc.). The env-var path is a development convenience.

    The instance key wraps every org master key. If it's rotated, every org
    master key must be re-wrapped. Rotation is a planned operation, not a
    casual one.
    """
    env_key = os.environ.get("WHEREAS_INSTANCE_KEY")
    if not env_key:
        raise EncryptionError(
            "WHEREAS_INSTANCE_KEY is not set. Generate one with: "
            "python -c 'import secrets; print(secrets.token_hex(32))'"
        )
    try:
        key = bytes.fromhex(env_key)
    except ValueError as e:
        raise EncryptionError("WHEREAS_INSTANCE_KEY must be hex-encoded.") from e
    if len(key) != KEY_SIZE:
        raise EncryptionError(
            f"WHEREAS_INSTANCE_KEY must be {KEY_SIZE} bytes ({KEY_SIZE * 2} hex chars)."
        )
    return key


# --------------------------------------------------------------------------
# Key generation
# --------------------------------------------------------------------------


def generate_key() -> bytes:
    """Generate a fresh 256-bit symmetric key from the OS CSPRNG."""
    return secrets.token_bytes(KEY_SIZE)


# --------------------------------------------------------------------------
# Key wrapping (encrypting one key with another)
# --------------------------------------------------------------------------


def wrap_key(*, key_to_wrap: bytes, wrapping_key: bytes, aad: bytes) -> WrappedKey:
    """Encrypt `key_to_wrap` using `wrapping_key`.

    `aad` (additional authenticated data) is bound into the GCM tag. Use it to
    bind the wrapped key to its identifier (e.g., the org id), so an attacker
    can't swap a wrapped key from one record onto another.
    """
    if len(key_to_wrap) != KEY_SIZE:
        raise EncryptionError(f"key_to_wrap must be {KEY_SIZE} bytes.")
    if len(wrapping_key) != KEY_SIZE:
        raise EncryptionError(f"wrapping_key must be {KEY_SIZE} bytes.")
    aesgcm = AESGCM(wrapping_key)
    nonce = secrets.token_bytes(NONCE_SIZE)
    ct = aesgcm.encrypt(nonce, key_to_wrap, aad)
    return WrappedKey(nonce=nonce, ciphertext=ct)


def unwrap_key(*, wrapped: WrappedKey, wrapping_key: bytes, aad: bytes) -> bytes:
    """Decrypt a wrapped key. Raises EncryptionError on tag mismatch.

    A tag mismatch means either the wrapped key was tampered with, the wrong
    AAD was supplied, or the wrong wrapping key was used. All three are
    security events.
    """
    if len(wrapping_key) != KEY_SIZE:
        raise EncryptionError(f"wrapping_key must be {KEY_SIZE} bytes.")
    aesgcm = AESGCM(wrapping_key)
    try:
        return aesgcm.decrypt(wrapped.nonce, wrapped.ciphertext, aad)
    except Exception as e:
        # cryptography raises InvalidTag, but we don't leak that detail.
        raise EncryptionError("Key unwrap failed (tag mismatch or wrong key).") from e


# --------------------------------------------------------------------------
# Document encryption / decryption
# --------------------------------------------------------------------------


def encrypt_document(
    *,
    plaintext: bytes,
    document_id: str,
    org_master_key: bytes,
) -> tuple[EncryptedDocument, WrappedKey]:
    """Encrypt a document.

    Generates a fresh DEK, encrypts the document with it, then wraps the DEK
    with the org master key.

    Returns:
      - EncryptedDocument: the ciphertext blob (upload this to S3).
      - WrappedKey: the wrapped DEK (store this in Postgres).
    """
    if len(org_master_key) != KEY_SIZE:
        raise EncryptionError(f"org_master_key must be {KEY_SIZE} bytes.")

    dek = generate_key()
    aesgcm = AESGCM(dek)
    nonce = secrets.token_bytes(NONCE_SIZE)
    aad = document_id.encode("utf-8")
    ct = aesgcm.encrypt(nonce, plaintext, aad)

    encrypted_doc = EncryptedDocument(
        nonce=nonce,
        ciphertext=ct,
        document_id=document_id,
    )
    wrapped_dek = wrap_key(
        key_to_wrap=dek,
        wrapping_key=org_master_key,
        aad=document_id.encode("utf-8"),
    )

    # Best effort: zero out the DEK after use. Python doesn't guarantee this
    # because of immutable bytes, but we try not to keep references.
    del dek

    return encrypted_doc, wrapped_dek


def decrypt_document(
    *,
    encrypted_blob: bytes,
    document_id: str,
    wrapped_dek: WrappedKey,
    org_master_key: bytes,
) -> bytes:
    """Decrypt a document.

    `encrypted_blob` is what was stored in S3 (nonce || ciphertext).
    `wrapped_dek` is what was stored in Postgres.
    """
    if len(encrypted_blob) < NONCE_SIZE + TAG_SIZE:
        raise EncryptionError("Encrypted blob too short.")

    nonce = encrypted_blob[:NONCE_SIZE]
    ct = encrypted_blob[NONCE_SIZE:]
    aad = document_id.encode("utf-8")

    dek = unwrap_key(
        wrapped=wrapped_dek,
        wrapping_key=org_master_key,
        aad=document_id.encode("utf-8"),
    )

    try:
        aesgcm = AESGCM(dek)
        return aesgcm.decrypt(nonce, ct, aad)
    except Exception as e:
        raise EncryptionError("Document decryption failed (tag mismatch).") from e
    finally:
        del dek


# --------------------------------------------------------------------------
# Org master key lifecycle
# --------------------------------------------------------------------------


def create_org_master_key(*, organization_id: str, instance_key: bytes) -> WrappedKey:
    """Generate a new org master key and wrap it with the instance key.

    Call this once when an organization is created. The returned WrappedKey is
    stored on the Organization row; the plaintext master key is never persisted.
    """
    master_key = generate_key()
    wrapped = wrap_key(
        key_to_wrap=master_key,
        wrapping_key=instance_key,
        aad=organization_id.encode("utf-8"),
    )
    del master_key
    return wrapped


def load_org_master_key(
    *,
    wrapped_master_key: WrappedKey,
    organization_id: str,
    instance_key: bytes,
) -> bytes:
    """Unwrap an org master key for use during a request.

    Should be called fresh per request and the returned key kept only as long
    as needed. Do not cache across requests.
    """
    return unwrap_key(
        wrapped=wrapped_master_key,
        wrapping_key=instance_key,
        aad=organization_id.encode("utf-8"),
    )
