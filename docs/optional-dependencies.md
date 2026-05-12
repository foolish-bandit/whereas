# Optional dependencies

Whereas's backend and frontend have a small required core. Most of the
contract-handling features layer on top of optional system or
third-party services. This page lists what each one is, what feature
it unlocks, and what happens when it's missing — so a new evaluator
can decide what to install upfront and what to defer.

> Required for the core to run at all: Python 3.11, Postgres 16 with
> `pgvector`, an S3-compatible object store, Node 22.x. Everything on
> this page is in addition to those.

## LibreOffice / `soffice` — required for DOCX preview

**Unlocks:** rendering an uploaded DOCX as a PDF preview in the
Repository workspace.

The DOCX → PDF conversion path shells out to `libreoffice --headless`
(or `soffice`, equivalently). The backend gates the path at runtime
with `shutil.which("libreoffice")` / `shutil.which("soffice")`, so the
service starts cleanly whether or not LibreOffice is on `PATH`.

**When it's missing:**

- DOCX uploads still succeed; the original file is still stored,
  encrypted, downloadable, and searchable via the Text-preview snapshot.
- The Repository workspace falls back to the Text-preview / "View
  original" plain-text view. The "PDF preview" surface is unavailable.
- The unit tests for the preview service stub the converter, so
  `pytest` does **not** require a local `libreoffice` binary.

**Install:**

- macOS: `brew install --cask libreoffice`
- Debian / Ubuntu: `sudo apt install libreoffice`
- Windows: download the LibreOffice installer from libreoffice.org;
  ensure `soffice.exe` is on `PATH`.

## Microsoft MarkItDown — optional for Text preview

**Unlocks:** higher-fidelity DOCX / PDF → Markdown conversion for the
Text-preview working snapshot.

The Text-preview pipeline tries [Microsoft
MarkItDown](https://github.com/microsoft/markitdown) first and falls
back to the existing extracted plain text when MarkItDown is not
installed or conversion fails. Conversion failure is non-fatal — the
upload still succeeds and the original remains downloadable.

**When it's missing:**

- Uploads still create a Text-preview snapshot, but the body is the
  extracted plain text (no headings, no list/table structure).
- All Repository search, snapshot-OR-title `q` matching, and clause
  segmentation continue to work against the plain-text body.
- No backend feature is gated on MarkItDown; nothing is hidden in the
  UI.

**Install:**

```sh
uv pip install markitdown
# or, with plain pip
pip install markitdown
```

## DocuSeal — optional unless you exercise signing

**Unlocks:** sending a generated DOCX out for signature collection and
materializing a `signed_pdf` artifact when the submission completes.

DocuSeal is a peer service. The Whereas Docker Compose file includes a
DocuSeal container; you can also run DocuSeal anywhere else and point
Whereas at it.

**When it's missing:**

- Repository, Requests, Approvals, templates, generation, search,
  clause analysis, and document download all work normally.
- The "Send to DocuSeal" action on a Contract surfaces a clear error
  instead of silently failing.
- No webhook traffic to `/api/docuseal/webhook` is expected; the
  endpoint still rejects unsigned bodies in production and warns in
  development.

**Configure:**

| Env var                       | Required when               | Purpose                                                          |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `DOCUSEAL_BASE_URL`           | Sending for signature       | Where Whereas reaches DocuSeal's API.                            |
| `DOCUSEAL_API_TOKEN`          | Sending for signature       | API token Whereas uses to call DocuSeal.                         |
| `DOCUSEAL_WEBHOOK_SECRET`     | Receiving signing callbacks | HMAC secret. **Production rejects every webhook without it.**    |
| `DOCUSEAL_AUTH_BRIDGE_SECRET` | Local Compose only          | Local auth bridge between Whereas and DocuSeal.                  |

See [docs/security-notes.md](security-notes.md) for the DocuSeal
webhook verification model.

## Ollama / LiteLLM-compatible LLM — optional for extraction

**Unlocks:** LLM-driven metadata extraction (parties, effective date,
governing law, etc.) with span citations.

Whereas talks to the LLM through [LiteLLM](https://github.com/BerriAI/litellm),
so any OpenAI-compatible provider works. The default deployment
targets a local Ollama. Default extraction model is `llama3.1:70b`,
which is large — override `EXTRACTION_MODEL` to `llama3.1:8b` (or
smaller) for development machines.

**When it's missing or unreachable:**

- Uploads still succeed; the contract lands with status `failed` and a
  visible "metadata extraction failed" warning on the workspace.
- The document is still stored, encrypted, searchable, and
  downloadable; only the extraction step failed.
- No other backend feature depends on the LLM being reachable.

## Quick install matrix

| Dependency       | Install command                              | What stops working without it                         |
| ---------------- | -------------------------------------------- | ----------------------------------------------------- |
| LibreOffice      | OS package manager (see above)               | DOCX → PDF preview only                               |
| MarkItDown       | `uv pip install markitdown`                  | High-fidelity Text-preview structure only             |
| DocuSeal         | Compose container or external deployment     | "Send to DocuSeal" + signed-PDF artifact materialization |
| Ollama + model   | `docker exec ... ollama pull llama3.1:8b`    | LLM metadata extraction (uploads still succeed)       |

None of the optional dependencies above are required to evaluate
Repository upload, search, Requests, Approvals, templates, or
generation against a real backend.
