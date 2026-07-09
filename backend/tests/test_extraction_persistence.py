"""Tests for extraction persistence, pre-LLM policy, and remote-provider audit."""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from typing import Any

import pytest

from app.models import Contract, ExtractedField, Organization, User
from app.security import llm_hook
from app.security.audit_log import AuditEvent, AuditEventType
from app.services import extraction
from app.services.extraction import ExtractionError, extract_and_persist_metadata

HOOKED_TEXT = "HOOKED SOURCE TEXT"


def hook_for_test(text: str, context: llm_hook.LLMCallContext) -> str:
    assert context.purpose == "metadata_extraction"
    assert context.document_id is not None
    assert context.organization_id is not None
    return HOOKED_TEXT


class InMemoryScalarResult:
    def __init__(self, values: list[Any] | None = None) -> None:
        self._values = values or []

    def scalars(self) -> InMemoryScalarResult:
        return self

    def all(self) -> list[Any]:
        return list(self._values)

    def one(self) -> Any:
        if len(self._values) != 1:
            raise AssertionError(f"expected one value, got {len(self._values)}")
        return self._values[0]

    def scalar_one_or_none(self) -> Any | None:
        if len(self._values) > 1:
            raise AssertionError(f"expected at most one value, got {len(self._values)}")
        return self._values[0] if self._values else None


class InMemorySession:
    """Tiny async session double for extraction service tests.

    These tests are not migration tests, so they avoid spinning up Docker.
    The double stores real ORM model instances and implements only the
    operations used by the extraction service and audit-log helper.
    """

    def __init__(self) -> None:
        self.organizations: list[Organization] = []
        self.users: list[User] = []
        self.contracts: list[Contract] = []
        self.extracted_fields: list[ExtractedField] = []
        self.audit_events: list[AuditEvent] = []
        self.flush_count = 0

    def add(self, obj: Any) -> None:
        if isinstance(obj, Organization):
            self.organizations.append(obj)
        elif isinstance(obj, User):
            self.users.append(obj)
        elif isinstance(obj, Contract):
            self.contracts.append(obj)
        elif isinstance(obj, ExtractedField):
            self.extracted_fields.append(obj)
        elif isinstance(obj, AuditEvent):
            self.audit_events.append(obj)
        else:  # pragma: no cover - guardrail for unexpected test use
            raise AssertionError(f"unexpected added object: {obj!r}")

    def add_all(self, objs: list[Any]) -> None:
        for obj in objs:
            self.add(obj)

    async def flush(self) -> None:
        self.flush_count += 1

    async def execute(self, statement: Any) -> InMemoryScalarResult:
        subject = getattr(statement, "column_descriptions", [])
        if subject and subject[0].get("entity") is AuditEvent:
            existing = [
                event
                for event in self.audit_events
                if event.organization_id == self.current_contract.organization_id
                and event.event_type == AuditEventType.LLM_REMOTE_PROVIDER_ENABLED.value
            ]
            if existing:
                return InMemoryScalarResult([existing[-1]])
            return InMemoryScalarResult([])

        table_name = getattr(getattr(statement, "table", None), "name", None)
        if table_name == "extracted_fields":
            self.extracted_fields = [
                field
                for field in self.extracted_fields
                if field.contract_id != self.current_contract.id
            ]
            return InMemoryScalarResult([])

        raise AssertionError(f"unexpected statement: {statement!r}")


@pytest.fixture(autouse=True)
def reset_hook_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    llm_hook._hook = None
    monkeypatch.delenv("WHEREAS_PRE_LLM_HOOK", raising=False)


@pytest.fixture
def session() -> InMemorySession:
    return InMemorySession()


@pytest.fixture
def contract(session: InMemorySession) -> Contract:
    org = Organization(id=uuid.uuid4(), name="Acme Legal")
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email="lawyer@example.com",
        password_hash="hash",
        display_name="Lawyer",
    )
    doc = (
        "MASTER SERVICES AGREEMENT\n"
        "This Agreement is governed by the laws of the State of Delaware.\n"
        "The Effective Date is 2026-01-15.\n"
    )
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=org.id,
        uploaded_by=user.id,
        title="Vendor MSA",
        s3_key="contracts/vendor-msa.pdf",
        mime_type="application/pdf",
        file_hash_sha256="a" * 64,
        full_text=doc,
    )
    session.add(org)
    session.add(user)
    session.add(contract)
    session.current_contract = contract
    return contract


def _litellm_response(payload: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=json.dumps(payload)),
            )
        ]
    )


def _field_payload(
    *,
    value: Any,
    span: str | None,
    confidence: float,
) -> dict[str, Any]:
    return {"value": value, "span": span, "confidence": confidence}


async def test_extract_and_persist_metadata_persists_accepted_fields(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")
    monkeypatch.setattr(extraction.settings, "EXTRACTION_MODEL", "llama3.1:70b")

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        return _litellm_response(
            {
                "governing_law": _field_payload(
                    value="Delaware",
                    span="the State of Delaware",
                    confidence=0.92,
                )
            }
        )

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    rows = await extract_and_persist_metadata(session, contract=contract)

    assert len(rows) == 1
    row = rows[0]
    assert session.extracted_fields == [row]
    assert row.contract_id == contract.id
    assert row.field_name == "governing_law"
    assert row.value_json == "Delaware"
    assert row.span_text == "the State of Delaware"
    assert row.span_start == contract.full_text.find("the State of Delaware")
    assert row.span_end == row.span_start + len("the State of Delaware")
    assert row.confidence == 0.92
    assert row.model_name == "ollama/llama3.1:70b"
    assert row.prompt_version == extraction.PROMPT_VERSION


async def test_extract_and_persist_metadata_rejects_hallucinated_span(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        return _litellm_response(
            {
                "governing_law": _field_payload(
                    value="New York",
                    span="the State of New York",
                    confidence=0.96,
                )
            }
        )

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    rows = await extract_and_persist_metadata(session, contract=contract)

    assert rows == []
    assert session.extracted_fields == []


async def test_extract_and_persist_metadata_replaces_rows_on_rerun(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")
    payloads = [
        {
            "governing_law": _field_payload(
                value="Delaware",
                span="the State of Delaware",
                confidence=0.91,
            )
        },
        {
            "effective_date": _field_payload(
                value="2026-01-15",
                span="2026-01-15",
                confidence=0.97,
            )
        },
    ]

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        return _litellm_response(payloads.pop(0))

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    first_rows = await extract_and_persist_metadata(session, contract=contract)
    second_rows = await extract_and_persist_metadata(session, contract=contract)

    assert [row.field_name for row in first_rows] == ["governing_law"]
    assert [row.field_name for row in second_rows] == ["effective_date"]
    assert [row.field_name for row in session.extracted_fields] == ["effective_date"]


async def test_pre_llm_hook_transformed_text_reaches_litellm(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_user_content: list[str] = []
    monkeypatch.setenv(
        "WHEREAS_PRE_LLM_HOOK",
        "tests.test_extraction_persistence:hook_for_test",
    )
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        messages = kwargs["messages"]
        seen_user_content.append(messages[1]["content"])
        return _litellm_response(
            {
                "governing_law": _field_payload(
                    value="hooked",
                    span=HOOKED_TEXT,
                    confidence=0.92,
                )
            }
        )

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    rows = await extract_and_persist_metadata(session, contract=contract)

    assert rows == []
    assert len(seen_user_content) == 1
    assert HOOKED_TEXT in seen_user_content[0]
    assert contract.full_text not in seen_user_content[0]


async def test_block_remote_hook_blocks_before_litellm_and_is_not_retried(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hook_calls = 0
    litellm_calls = 0

    def counting_block_remote(text: str, context: llm_hook.LLMCallContext) -> str:
        nonlocal hook_calls
        hook_calls += 1
        return llm_hook.block_remote_hook(text, context)

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        nonlocal litellm_calls
        litellm_calls += 1
        return _litellm_response({})

    monkeypatch.setitem(llm_hook._BUILTINS, "block_remote", counting_block_remote)
    monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "block_remote")
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "openai")
    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    with pytest.raises(ExtractionError, match="blocked by policy"):
        await extract_and_persist_metadata(session, contract=contract)

    assert hook_calls == 1
    assert litellm_calls == 0
    assert session.audit_events == []


async def test_remote_provider_audit_is_recorded_once_per_org(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "openai")
    monkeypatch.setattr(extraction.settings, "EXTRACTION_MODEL", "gpt-4o-mini")
    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        return _litellm_response(
            {
                "governing_law": _field_payload(
                    value="Delaware",
                    span="the State of Delaware",
                    confidence=0.93,
                )
            }
        )

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    await extract_and_persist_metadata(session, contract=contract, actor_user_id=contract.uploaded_by)
    await extract_and_persist_metadata(session, contract=contract, actor_user_id=contract.uploaded_by)

    events = [
        event
        for event in session.audit_events
        if event.event_type == AuditEventType.LLM_REMOTE_PROVIDER_ENABLED.value
    ]
    assert len(events) == 1
    event = events[0]
    assert event.organization_id == contract.organization_id
    assert event.actor_user_id == contract.uploaded_by
    assert event.target_type == "organization"
    assert event.target_id == str(contract.organization_id)
    assert event.details["provider"] == "openai"
    assert event.details["model"] == "gpt-4o-mini"
    assert event.details["purpose"] == "metadata_extraction"
    assert event.details["contract_id"] == str(contract.id)


async def test_local_provider_does_not_record_remote_provider_audit(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")
    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        return _litellm_response(
            {
                "governing_law": _field_payload(
                    value="Delaware",
                    span="the State of Delaware",
                    confidence=0.93,
                )
            }
        )

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    await extract_and_persist_metadata(session, contract=contract)

    assert session.audit_events == []


# --------------------------------------------------------------------------
# Validation-error reask loop (Instructor pattern)
# --------------------------------------------------------------------------


async def test_reask_recovers_from_invalid_first_response(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """First response fails schema validation; the reask response is valid."""
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")
    calls: list[list[dict[str, Any]]] = []

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        calls.append(kwargs["messages"])
        if len(calls) == 1:
            # confidence out of range -> fails MetadataExtractionResponse validation
            return _litellm_response(
                {
                    "governing_law": _field_payload(
                        value="Delaware",
                        span="the State of Delaware",
                        confidence=1.7,
                    )
                }
            )
        return _litellm_response(
            {
                "governing_law": _field_payload(
                    value="Delaware",
                    span="the State of Delaware",
                    confidence=0.9,
                )
            }
        )

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    rows = await extract_and_persist_metadata(session, contract=contract)

    assert len(calls) == 2
    # The reask conversation carries the original messages, the model's
    # prior (invalid) reply, and a corrective follow-up.
    reask_messages = calls[1]
    assert len(reask_messages) == len(calls[0]) + 2
    assert reask_messages[-2]["role"] == "assistant"
    assert reask_messages[-1]["role"] == "user"
    assert "failed validation" in reask_messages[-1]["content"]

    assert len(rows) == 1
    assert rows[0].field_name == "governing_law"
    assert rows[0].confidence == 0.9


async def test_reask_failure_raises_after_one_attempt(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both the original response and the reask response are invalid."""
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")
    call_count = 0

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        nonlocal call_count
        call_count += 1
        return _litellm_response(
            {
                "governing_law": _field_payload(
                    value="Delaware",
                    span="the State of Delaware",
                    confidence=1.7,  # always out of range
                )
            }
        )

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    with pytest.raises(ExtractionError, match="failed schema validation after reask"):
        await extract_and_persist_metadata(session, contract=contract)

    # Exactly one reask attempt: the original call plus one retry, no more.
    assert call_count == 2


# --------------------------------------------------------------------------
# Structured output passthrough (EXTRACTION_STRUCTURED_OUTPUT)
# --------------------------------------------------------------------------


async def test_structured_output_flag_off_uses_plain_json_object(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")
    monkeypatch.setattr(extraction.settings, "EXTRACTION_STRUCTURED_OUTPUT", False)
    seen_kwargs: dict[str, Any] = {}

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        seen_kwargs.update(kwargs)
        return _litellm_response({})

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    await extract_and_persist_metadata(session, contract=contract)

    assert seen_kwargs["response_format"] == {"type": "json_object"}


async def test_structured_output_flag_on_passes_json_schema(
    session: InMemorySession,
    contract: Contract,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extraction.settings, "LITELLM_PROVIDER", "ollama")
    monkeypatch.setattr(extraction.settings, "EXTRACTION_STRUCTURED_OUTPUT", True)
    seen_kwargs: dict[str, Any] = {}

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        seen_kwargs.update(kwargs)
        return _litellm_response({})

    monkeypatch.setattr(extraction.litellm, "acompletion", fake_acompletion)

    await extract_and_persist_metadata(session, contract=contract)

    response_format = seen_kwargs["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["name"] == "metadata_extraction_response"
    assert "schema" in response_format["json_schema"]
