# Whereas Security Model

This document describes Whereas's security architecture and threat model. It exists so that prospective deployers (and their IT and security teams) can evaluate Whereas without needing to read the source.

If you find a gap or a misstatement, file an issue or follow [SECURITY.md](../SECURITY.md) for vulnerability reports.

## Threat model

### What we defend against

| Threat | Defense |
|---|---|
| Postgres dump leaks document contents | Documents encrypted at rest with per-document keys; Postgres holds only wrapped (encrypted) keys, not plaintext |
| Object storage (MinIO/S3) dump leaks document contents | Same as above; ciphertext is useless without the wrapped key from Postgres AND the org master key |
| Cross-organization data leakage from app-layer bug | Postgres Row-Level Security as belt-and-suspenders behind application-layer org filtering |
| Audit log tampering | Append-only hash-chained audit table; chain verification can be run on demand or on schedule |
| Hallucinated metadata leaking into critical workflows | Span validation: every extracted value must point to verbatim source text or it is dropped |
| Prompt injection via malicious document content | Document content is wrapped in tagged delimiters; system prompt instructs the model to ignore in-document instructions; span validation catches misdirected outputs |
| Credential stuffing against login endpoint | Rate limiting per IP; Argon2id password hashing; planned MFA |
| Clickjacking, MIME sniffing, mixed content | Strict CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff |
| Document content silently exfiltrated to LLM provider | Local LLM (Ollama) is the default; remote provider use requires explicit config and surfaces a warning; pre-LLM hook system supports redaction layer |

### What we explicitly do NOT defend against

These are out of scope. If your deployment requires any of them, you need additional controls outside Whereas.

- **A malicious tenant administrator.** An admin who decides to exfiltrate their own organization's contracts can do so. We protect against accidental cross-org leaks and external attackers, not insider threats from privileged users.
- **A compromised running application.** An attacker who pops the FastAPI process has the instance key in memory and can decrypt any document accessible to that process. Detection and response (intrusion detection, forensic logging) are operational concerns left to the deployer.
- **A compromised LLM provider.** If you configure a remote LLM provider and that provider is compromised or hostile, your document content is exposed. Mitigation: use the local Ollama default. Sub-mitigation: configure a pre-LLM hook (e.g., a PII redaction layer) before sending content remotely.
- **Side-channel attacks on the host OS.** Spectre, RowHammer, hypervisor escape on shared infrastructure — these are deployer responsibilities. Run on hardware you control if your threat model includes nation-state-level attackers.
- **Truncation of the audit chain.** Hash chaining detects modification and reordering of existing entries, but it cannot detect deletion of the most recent N entries. For high-assurance environments, periodically pin the latest hash to an external trusted log.

## Architecture

### Encryption at rest

Three-layer key hierarchy:

```
Instance Key
    │
    ├── wraps ─→ Org A Master Key
    │               │
    │               ├── wraps ─→ Document A1 Key ─→ encrypts ─→ Document A1 in S3
    │               └── wraps ─→ Document A2 Key ─→ encrypts ─→ Document A2 in S3
    │
    └── wraps ─→ Org B Master Key
                    └── wraps ─→ Document B1 Key ─→ encrypts ─→ Document B1 in S3
```

- **Instance Key.** Loaded at runtime from `WHEREAS_INSTANCE_KEY` (env var) or, in production, from a KMS. Never persisted on disk in plaintext. Loss of the instance key without backup makes every encrypted document permanently unrecoverable.
- **Org Master Keys.** One per organization. Generated at org creation, wrapped with the instance key, stored in Postgres. Rotation requires re-wrapping all DEKs but not re-encrypting documents.
- **Document Encryption Keys (DEKs).** One per document. Generated at upload, used once to encrypt the document, then wrapped with the org master key and stored in Postgres alongside the document metadata. Compromise of one DEK exposes one document, not the corpus.

All encryption uses AES-256-GCM with a 96-bit random nonce. The document id is bound into the AAD so swapped ciphertexts and wrapped keys are detected.

Code: [`backend/app/security/encryption.py`](../backend/app/security/encryption.py).

### Authorization

Two layers, in order of authority:

1. **Application-layer.** Every query against tenant-scoped tables filters by the authenticated user's `organization_id`. This is the primary mechanism.
2. **Postgres Row-Level Security.** Every tenant-scoped table has an RLS policy keyed off a session variable set per request. If an application-layer filter is missing due to a bug, RLS still filters.

The Whereas backend connects to Postgres as a non-superuser role (`whereas_app`). RLS policies apply to this role even though the policies don't apply to table owners — this is intentional and important. Never run the application as the `postgres` superuser.

Code: [`backend/app/security/rls.py`](../backend/app/security/rls.py).

### Audit log

Append-only table with hash-chained entries. Each entry stores:

- A monotonic per-org sequence number
- The actor (user, IP, user agent)
- The event type and target
- An opaque details JSON
- The SHA-256 hash of the previous entry
- The SHA-256 hash of this entry's canonical content

Verification is a single pass over the chain, recomputing each hash and comparing. Any modification breaks the chain at the modified entry and at every entry after it.

What gets logged: every login (success and failure), every contract upload/download/delete, every playbook change, every deviation dismissal, every key rotation, every remote LLM provider toggle. The full list is in [`backend/app/security/audit_log.py`](../backend/app/security/audit_log.py) under `AuditEventType`.

### LLM provider safety

The default LLM provider is local Ollama. Document content never leaves the deployment when this default is used.

When a deployer configures a remote provider (OpenAI, Anthropic, Azure, etc.):

1. The first time a remote provider is enabled, an audit event (`security.llm_remote_provider.enabled`) is recorded.
2. The deployment can install a **pre-LLM hook** to redact or block content before it leaves. The hook is a Python callable configured via the `WHEREAS_PRE_LLM_HOOK` environment variable. Built-in options:
   - `identity` (default): no transformation.
   - `block_remote`: aborts any LLM call that would go to a remote provider. Useful as a hard policy enforcement when local LLM is mandated.
   - `module.path:callable`: load a custom hook. This is how third-party tools like Sonomos CLOAK can integrate without Whereas depending on them.

Code: [`backend/app/security/llm_hook.py`](../backend/app/security/llm_hook.py).

### HTTP security headers

The application sets the following on every response:

| Header | Value |
|---|---|
| Strict-Transport-Security | `max-age=31536000; includeSubDomains` (production only) |
| Content-Security-Policy | strict policy, allowlist for DocuSeal iframe |
| X-Frame-Options | `DENY` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | denies camera, microphone, geolocation, payment, USB |
| Cross-Origin-Opener-Policy | `same-origin` |
| Cross-Origin-Resource-Policy | `same-origin` |
| Cache-Control | `no-store` on all `/api/*` responses |

Code: [`backend/app/security/headers.py`](../backend/app/security/headers.py).

### Authentication

- Passwords hashed with Argon2id at the OWASP-recommended parameters.
- Sessions are server-side, stored in Postgres. JWTs are used only for the short-lived (5 minute) handoff to DocuSeal.
- Login endpoint is rate-limited at 5 attempts per IP per 15 minutes.
- MFA is optional in v0.1 (TOTP) and will become mandatory for admins in v0.2.
- Password reset is admin-only in v0.1; self-service reset by email is post-v0.1 because it's the most common compromise vector for SaaS apps and we want to do it right.

### Data deletion

- Soft delete is the default for contracts, with a 30-day grace period. After 30 days, a scheduled job hard-deletes the row, the encrypted blob in S3, and the wrapped DEK.
- Hard delete on demand is supported for compliance with deletion requests (GDPR, CCPA). Hard-deleted records leave a tombstone in the audit log so the deletion itself is auditable.
- The audit log itself is never deleted. It is retained for the lifetime of the deployment and exported separately for compliance archival.

## Cryptographic primitives

| Purpose | Primitive | Library |
|---|---|---|
| Document encryption | AES-256-GCM | `cryptography` (PyCA) |
| Key wrapping | AES-256-GCM | `cryptography` (PyCA) |
| Password hashing | Argon2id | `argon2-cffi` |
| Session token entropy | OS CSPRNG | `secrets` |
| Audit log hashing | SHA-256 | stdlib `hashlib` |
| DocuSeal handoff JWT | HS256 | `python-jose` |

We don't roll our own crypto. If a primitive isn't on this list, we don't use it.

## Compliance posture (informational)

Whereas is not certified against any specific compliance regime. The architecture is designed to support deployers who need to meet:

- **SOC 2 Type II** — audit log, encryption at rest, access controls, change management via Git
- **HIPAA** — encryption at rest and in transit, audit logs; deployer must execute a BAA with their hosting provider and configure access controls appropriately
- **GDPR / CCPA** — hard-delete capability, audit trail, data minimization in logs (we don't log document content)

If you need a deployment certified against one of these, that's an exercise for the deploying organization, not for the Whereas project. We can't certify you on behalf of your firm.
