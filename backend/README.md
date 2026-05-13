# Whereas — backend

FastAPI + SQLAlchemy 2.0 (async) backend for the Whereas contract
repository. Project-level documentation, design principles, and the
self-host guide live in the [repository root README](../README.md).

This file exists so that `pyproject.toml`'s `readme = "README.md"`
field resolves when developers run `pip install -e .[dev]`
(or `uv pip install -e .[dev]`) inside `backend/`. Without it,
hatchling's metadata validation refuses to build the editable
install and the dev-only test dependencies (pytest, pytest-asyncio,
httpx, aiosqlite, testcontainers, etc.) cannot be installed cleanly.

## Running tests

From `backend/`:

```
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

`asyncio_mode = "auto"` and `asyncio_default_fixture_loop_scope = "function"`
are set in `pyproject.toml`'s `[tool.pytest.ini_options]`; both rely on
pytest-asyncio being installed (it ships in the `dev` extras). Running
`pytest` from a Python that does not have pytest-asyncio installed will
print "Unknown config option: asyncio_mode" and skip async test
discovery. The fix is always to install the dev extras into the active
Python — never to remove the config keys.

## Optional system dependencies

A handful of conversion tests depend on a `libreoffice` / `soffice`
binary being on `PATH` (DOCX → PDF preview). The conversion path is
gated by a runtime `shutil.which` check; the unit tests for the
preview service stub the converter so they do not require LibreOffice
to be installed locally.

## Embeddings status (architecture-only)

The backend includes an internal embeddings abstraction in
`app/services/embeddings.py` to support future semantic features
(similar clause search, related approved clauses, playbook rule
matching, similar repository records, and future text preview search).

Current status:
- Embeddings are **disabled by default**.
- Provider modes are placeholders only: `disabled`,
  `local_command_placeholder`, and
  `future_python_service_placeholder`.
- Planned default local model target is **`BAAI/bge-small-en-v1.5`**,
  but this repository does **not** bundle model files and this module
  does **not** download or execute any model.
- No vectors are persisted yet.
