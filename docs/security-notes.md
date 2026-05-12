# Security notes (pre-v0.1)

A focused list of the security-relevant behaviors a self-host
evaluator should verify before exposing Whereas to anything beyond a
single developer's machine. This page describes shipped behavior; it
is **not** the full threat model.

> Pre-v0.1: Whereas does not yet have real authentication. The local
> dev `X-Whereas-Dev-User` header is a temporary bridge; the
> `/api/setup/dev` endpoint that creates the dev user is rejected
> when `ENVIRONMENT=production`. Do not expose a Whereas instance to
> the public internet without first solving the auth problem.

## Encryption at rest

- Every uploaded document is encrypted with a per-tenant wrapped
  master key (held in the `Organization` row) and a per-artifact
  data-encryption key. Signed PDFs from DocuSeal materialize with a
  fresh per-artifact wrapped DEK (migration `0011`).
- The backend requires `WHEREAS_INSTANCE_KEY` (exactly 32 bytes / 64
  hex chars) at startup. Startup fails fast if the key is missing or
  malformed — encryption is configured or the app does not run.
- `storage_key` and `wrapped_dek` are never returned by any API
  response. The frontend's API client has a defensive
  `scrubSecrets()` pass that strips them anyway, in case the backend
  regresses.

## No `/api/*` service-worker caching

- `vite.config.ts` sets `navigateFallbackDenylist: [/^\/api\//]` and
  `runtimeCaching: []`. The built `dist/sw.js` retains
  `denylist:[/^\/api\//]`; CI verifies this on every build.
- Result: contract data always flows through the live request path,
  with org-scoped auth on every call. Stale `/api/*` responses cannot
  be served from an old session cache.

## No storage internals in public responses

- The frontend `FORBIDDEN_DOM_TOKENS` list (`src/test/forbiddenTokens.ts`)
  enumerates substrings that must never reach the rendered DOM:
  `storage_key`, `wrapped_dek`, `wrapped_master_key`, `s3_key`,
  `presigned_url`, `presigned_uri`, `private_url`, the raw artifact
  slot tokens (`original_upload`, `generated_docx`, `signed_pdf`,
  `redline_docx`), `metadata_json`, `docuseal_webhook_secret`, and
  `docuseal_api_token`.
- The cross-route audit test (`src/__tests__/MvpReadiness.test.tsx`)
  mounts every top-level route and asserts none of those substrings
  appear in `document.body.textContent`.

## Audit log discipline

- Every state-changing operation appends an `AuditEvent` row via
  `record_event(...)` with **allowlisted** detail fields only.
- Disallowed in audit details: `storage_key`, `wrapped_dek`, `s3_key`,
  raw `metadata_json`, document bytes, plaintext variable values
  (from template generation), DocuSeal secrets, signer PII.
- Adding a new audit event requires extending the
  `AuditEventType` enum and choosing the allowlisted detail fields
  explicitly — there is no "log the whole payload" path.

## DocuSeal webhook verification

- `POST /api/docuseal/webhook` is the public completion endpoint.
- Header format: `X-Docuseal-Signature: {timestamp}.{hex_hmac}` where
  the HMAC-SHA256 is computed over `"{timestamp}.{raw_body}"` keyed
  on `DOCUSEAL_WEBHOOK_SECRET`. Header lookup is case-insensitive.
- Timestamps older or further-future than 5 minutes are rejected,
  closing the replay window.
- Interim path (for DocuSeal versions that don't emit signed
  webhooks): the literal value of `DOCUSEAL_WEBHOOK_SECRET` may be
  sent in `X-Whereas-Docuseal-Webhook-Secret`, but **only** when no
  `X-Docuseal-Signature` is present. Both paths require the secret
  to be configured.
- Production: every webhook is rejected if `DOCUSEAL_WEBHOOK_SECRET`
  is unset. Development: unsigned bodies are accepted with a warning
  — this is the only place that path exists.
- Token-shaped fields in any DocuSeal upstream response are scrubbed
  before being echoed back to the client.
- Idempotent: a duplicate completion event for the same
  `(contract_id, docuseal_submission_id)` is a no-op. Irrelevant
  events (`viewed`, `created`, etc.) and unknown submission ids
  return 202 without mutating state.

## Per-organization scoping

- Every authenticated request resolves an `organization_id` from the
  caller's `User`. Repository / Requests / Approvals / Templates /
  Artifacts / Audit queries are filtered by that org id at the
  SQLAlchemy layer — there is no global list endpoint.
- Cross-org access returns 404, not 403, so an attacker cannot
  enumerate which ids exist in other orgs.

## Defense-in-depth checks the CI gate enforces

- Frontend `vitest` includes per-page forbidden-string DOM scans
  **and** the cross-route audit (PR #107).
- Backend `pytest` includes tampering scenarios, malformed input, and
  authorization edge cases for everything under
  `backend/app/security/` — per `CLAUDE.md`, that surface is the
  one we deliberately over-test.

## What this page does NOT cover

- **Production deployment hardening.** TLS termination, reverse-proxy
  config, rate-limiting, secret rotation, backup encryption, and the
  decision of which auth provider replaces the dev-user bridge are
  out of scope here.
- **Threat model.** A full STRIDE-style write-up is planned; this
  page is the shipped-behavior reference, not the threat analysis.
- **Penetration testing results.** None yet — Whereas is pre-v0.1.

If you spot a leak — sensitive data in a response, an unscoped
query, a missing audit event — please open an issue tagged
`security`.
