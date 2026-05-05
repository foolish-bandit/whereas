# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email `security@whereas.law` (placeholder until domain is configured) with:
  - A description of the vulnerability
  - Steps to reproduce
  - Affected versions
  - Your assessment of severity

We will acknowledge receipt within 72 hours and provide a status update within 7 days.

## Supported versions

Whereas is pre-v0.1. There are no supported versions yet. Once v0.1 ships, we will document a support policy here.

## Threat model (informational, will evolve)

Whereas is designed to run inside a tenant's infrastructure. The threat model assumes:
  - The deployment is operated by the tenant (a law firm or in-house legal team).
  - End users are authenticated employees of the tenant.
  - The LLM provider is either local (Ollama) or a remote provider configured by the tenant.
  - Documents may contain sensitive client information.

What Whereas defends against:
  - Cross-organization data leakage (multi-tenant isolation, even though most deployments are single-tenant).
  - Hallucinated metadata leaking into critical workflows (span validation).
  - Unauthorized document access (permission checks on every read).

What Whereas does **not** defend against:
  - A malicious tenant administrator.
  - A compromised LLM provider (mitigation: keep extraction local).
  - Side-channel attacks on the host OS.

If you find a gap in this threat model, please report it the same way as a vulnerability.
