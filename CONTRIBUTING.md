# Contributing to Whereas

Whereas is community-driven. PRs are welcome from anyone. This document explains how to contribute productively.

## Before you open a PR

1. **Read [docs/design-principles.md](docs/design-principles.md).** Whereas has opinions about how it should work. Significant changes that contradict those principles will be rejected, regardless of how clean the code is.
2. **Open an issue first for non-trivial changes.** This saves you time. If we're not going to merge it, we'd rather tell you before you write the code.
3. **Run the test suite locally.** `cd backend && pytest`. If you're touching the frontend, `cd frontend && npm test`.

## What we look for in PRs

- **A linked issue or written-out rationale.** Tell us what problem you're solving.
- **Tests.** New features need tests. Bug fixes need a regression test.
- **Span citation discipline.** Any feature that surfaces information extracted from a contract must include a span citation back to the source. This is non-negotiable. Hallucinated metadata in legal software is a malpractice issue, not a UX bug.
- **Don't break self-host.** Whereas must remain runnable on a single machine with `docker compose up`. If your feature requires a managed service, it needs an offline fallback or it's a no.

## What we won't merge

- Telemetry that calls home by default.
- Hard dependencies on a specific LLM provider. We use LiteLLM for a reason.
- Cloud-only features without a self-host story.
- Features that materially weaken the AGPL posture (e.g., loadable proprietary modules with privileged hooks).
- Sycophantic or AI-slop generated PRs. We can tell. We will close them.

## Contributor License Agreement

By contributing, you agree that your contributions are licensed under AGPL-3.0-or-later, the same license as the project. We do not require a separate CLA at this time. If that changes, we'll be transparent about why.

## Code of Conduct

Be a professional. Disagree on technical merits, not on people. We don't have a long CoC document because we trust contributors to behave like adults. If you can't, you'll be asked to leave.

## Maintainers

Whereas is maintained by Zachary Brenner ([@zackbrenner](https://github.com/zackbrenner)) and the contributors listed in [MAINTAINERS.md](MAINTAINERS.md). Maintainership is earned, not appointed: consistent quality contributions and good judgment over time.

## Getting help

- **Issues:** for bugs and feature requests.
- **Discussions:** for design questions and "is this in scope" conversations.
- **Security:** see [SECURITY.md](SECURITY.md). Do not file security issues in the public tracker.
