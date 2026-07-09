"""End-to-end tests for `POST /api/qa/ask`.

Covers: auth, org scoping, the no-hits refusal path (no LLM call), citation
verbatim-span validation (valid/invalid/mixed), malformed LLM JSON, and LLM
errors surfacing as a clean 503 rather than a raw provider exception.

Runs against an in-memory sqlite engine (see `app.services.retrieval`'s
dialect-aware fallback), with `litellm.acompletion` mocked — this suite
never makes a real network call. `EMBEDDINGS_ENABLED` is turned off for
the whole module so the question-embedding step never touches
`litellm.aembedding` either; the vector retrieval leg is Postgres-only
and is covered separately in `test_retrieval.py`.

The sqlite retrieval fallback is a plain `ILIKE` *substring* match (no
tokenization, no ranking — see `app.services.retrieval._search_clauses_sqlite`),
so questions here are deliberately phrased to contain a literal
substring of the clause they're meant to retrieve, rather than reading
like a natural question. That's a testing-fallback quirk, not a product
constraint: real deployments retrieve via the Postgres hybrid legs
(full-text + trigram + vector), which don't require literal substring
overlap.
"""
from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.api import qa as qa_api
from app.core.database import Base, get_db
from app.main import app
from app.models import Clause, Contract, Organization, User


@pytest.fixture(autouse=True)
def _disable_embeddings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep this suite off the network: no `litellm.aembedding` calls.

    The vector retrieval leg only runs on Postgres anyway (see
    `app.services.retrieval`); disabling embeddings here just means
    `_embed_question_best_effort` short-circuits instead of invoking a
    real embedding provider.
    """
    monkeypatch.setattr(qa_api.settings, "EMBEDDINGS_ENABLED", False)


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    tables = [
        Organization.__table__,
        User.__table__,
        Contract.__table__,
        Clause.__table__,
    ]
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=tables)
    try:
        yield engine
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await engine.dispose()


@pytest.fixture
async def db_session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    async with maker() as session:
        yield session


@pytest.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    async def override_get_db() -> AsyncIterator[AsyncSession]:
        try:
            yield db_session
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


async def _create_org_user(session: AsyncSession, *, email: str | None = None) -> tuple[Organization, User]:
    org = Organization(id=uuid.uuid4(), name=f"Org {uuid.uuid4()}")
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=email or f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test User",
        is_active=True,
    )
    session.add_all([org, user])
    await session.flush()
    return org, user


async def _create_contract(session: AsyncSession, org: Organization, user: User, *, title: str = "Vendor MSA") -> Contract:
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=org.id,
        uploaded_by=user.id,
        title=title,
        status="ready",
        s3_key=f"contracts/{uuid.uuid4()}.pdf",
        mime_type="application/pdf",
        file_hash_sha256="a" * 64,
    )
    session.add(contract)
    await session.flush()
    return contract


async def _create_clause(
    session: AsyncSession,
    contract: Contract,
    *,
    ordinal: int,
    text: str,
    heading: str | None = None,
) -> Clause:
    clause = Clause(
        id=uuid.uuid4(),
        organization_id=contract.organization_id,
        contract_id=contract.id,
        ordinal=ordinal,
        heading=heading,
        text=text,
        span_start=0,
        span_end=len(text),
        segmentation_method="heuristic_v1",
    )
    session.add(clause)
    await session.flush()
    return clause


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


def _litellm_json_response(payload: dict[str, Any]) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))]
    )


class TestNoRetrievalHits:
    async def test_no_hits_is_answerable_false_without_calling_llm(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract = await _create_contract(db_session, org, user)
        await _create_clause(
            db_session, contract, ordinal=0, text="Confidentiality obligations survive termination."
        )

        litellm_calls = 0

        async def fake_acompletion(**kwargs: Any) -> Any:
            nonlocal litellm_calls
            litellm_calls += 1
            raise AssertionError("must not be called when retrieval has no hits")

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "something totally unrelated to indemnification xyzzy"},
            headers=_headers(user),
        )

        assert response.status_code == 200
        body = response.json()
        assert body["answerable"] is False
        assert body["citations"] == []
        assert body["confidence"] == 0.0
        assert litellm_calls == 0


class TestHappyPath:
    async def test_valid_citation_is_returned(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract = await _create_contract(db_session, org, user, title="Vendor MSA")
        clause = await _create_clause(
            db_session,
            contract,
            ordinal=0,
            text="This Agreement is governed by the laws of the State of Delaware.",
            heading="Governing Law",
        )

        async def fake_acompletion(**kwargs: Any) -> Any:
            return _litellm_json_response(
                {
                    "answer": "The governing law is Delaware.",
                    "citations": [{"index": 1, "quote": "the laws of the State of Delaware"}],
                    "confidence": 0.9,
                }
            )

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "State of Delaware"},
            headers=_headers(user),
        )

        assert response.status_code == 200
        body = response.json()
        assert body["answerable"] is True
        assert body["answer"] == "The governing law is Delaware."
        assert body["confidence"] == 0.9
        assert len(body["citations"]) == 1
        citation = body["citations"][0]
        assert citation["clause_id"] == str(clause.id)
        assert citation["contract_id"] == str(contract.id)
        assert citation["contract_title"] == "Vendor MSA"
        assert citation["heading"] == "Governing Law"
        assert citation["quote"] == "the laws of the State of Delaware"
        assert (
            clause.text[citation["start_offset"] : citation["end_offset"]]
            == "the laws of the State of Delaware"
        )
        assert body["model"]

    async def test_scoped_to_a_single_contract_when_given(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract_1 = await _create_contract(db_session, org, user, title="Contract One")
        contract_2 = await _create_contract(db_session, org, user, title="Contract Two")
        await _create_clause(
            db_session, contract_1, ordinal=0, text="Termination requires thirty days notice."
        )
        clause_2 = await _create_clause(
            db_session, contract_2, ordinal=0, text="Termination requires sixty days notice."
        )

        async def fake_acompletion(**kwargs: Any) -> Any:
            return _litellm_json_response(
                {
                    "answer": "Sixty days notice is required.",
                    "citations": [{"index": 1, "quote": "sixty days notice"}],
                    "confidence": 0.8,
                }
            )

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "sixty days notice", "contract_id": str(contract_2.id)},
            headers=_headers(user),
        )

        assert response.status_code == 200
        body = response.json()
        assert body["answerable"] is True
        assert body["citations"][0]["clause_id"] == str(clause_2.id)

    async def test_unknown_contract_id_scope_is_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        org, user = await _create_org_user(db_session)
        await _create_contract(db_session, org, user)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "anything", "contract_id": str(uuid.uuid4())},
            headers=_headers(user),
        )

        assert response.status_code == 404


class TestCitationValidation:
    async def test_citation_quote_not_found_is_dropped_but_others_survive(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract = await _create_contract(db_session, org, user)
        clause = await _create_clause(
            db_session,
            contract,
            ordinal=0,
            text="Liability is capped at the fees paid in the preceding twelve months.",
            heading="Limitation of Liability",
        )

        async def fake_acompletion(**kwargs: Any) -> Any:
            return _litellm_json_response(
                {
                    "answer": "Liability is capped at twelve months of fees.",
                    "citations": [
                        # Hallucinated — not present verbatim in the clause.
                        {"index": 1, "quote": "liability is unlimited"},
                        # Real, verbatim.
                        {"index": 1, "quote": "capped at the fees paid"},
                    ],
                    "confidence": 0.85,
                }
            )

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "capped at the fees paid"},
            headers=_headers(user),
        )

        assert response.status_code == 200
        body = response.json()
        assert body["answerable"] is True
        assert len(body["citations"]) == 1
        assert body["citations"][0]["quote"] == "capped at the fees paid"
        assert body["citations"][0]["clause_id"] == str(clause.id)

    async def test_all_citations_invalid_is_answerable_false(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract = await _create_contract(db_session, org, user)
        await _create_clause(
            db_session, contract, ordinal=0, text="Payment is due within thirty days of invoice."
        )

        litellm_calls = 0

        async def fake_acompletion(**kwargs: Any) -> Any:
            nonlocal litellm_calls
            litellm_calls += 1
            return _litellm_json_response(
                {
                    "answer": "Payment is due immediately.",
                    "citations": [{"index": 1, "quote": "payment is due immediately"}],
                    "confidence": 0.6,
                }
            )

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "payment is due within thirty days"},
            headers=_headers(user),
        )

        assert response.status_code == 200
        body = response.json()
        assert body["answerable"] is False
        assert body["citations"] == []
        assert body["confidence"] == 0.0
        # Model is still reported: the LLM *was* called, it just didn't
        # produce anything we could verify.
        assert body["model"]
        assert litellm_calls == 1


class TestMalformedLlmOutput:
    async def test_malformed_json_degrades_gracefully(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract = await _create_contract(db_session, org, user)
        await _create_clause(db_session, contract, ordinal=0, text="Confidentiality survives termination.")

        from types import SimpleNamespace

        litellm_calls = 0

        async def fake_acompletion(**kwargs: Any) -> Any:
            nonlocal litellm_calls
            litellm_calls += 1
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="not valid json {{{"))]
            )

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "confidentiality survives termination"},
            headers=_headers(user),
        )

        assert response.status_code == 200
        body = response.json()
        assert body["answerable"] is False
        assert body["citations"] == []
        # Guards against a false pass via the "no retrieval hits" path —
        # this test is only meaningful if the LLM was actually called and
        # its malformed output is what triggered the refusal.
        assert litellm_calls == 1

    async def test_code_fenced_json_is_parsed(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract = await _create_contract(db_session, org, user)
        clause = await _create_clause(
            db_session, contract, ordinal=0, text="Confidentiality survives termination for five years."
        )

        from types import SimpleNamespace

        payload = {
            "answer": "Confidentiality survives for five years.",
            "citations": [{"index": 1, "quote": "survives termination for five years"}],
            "confidence": 0.75,
        }

        async def fake_acompletion(**kwargs: Any) -> Any:
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=f"```json\n{json.dumps(payload)}\n```")
                    )
                ]
            )

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "confidentiality survives termination for five years"},
            headers=_headers(user),
        )

        assert response.status_code == 200
        body = response.json()
        assert body["answerable"] is True
        assert body["citations"][0]["clause_id"] == str(clause.id)


class TestLlmFailure:
    async def test_llm_error_is_503(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org, user = await _create_org_user(db_session)
        contract = await _create_contract(db_session, org, user)
        await _create_clause(db_session, contract, ordinal=0, text="Some clause text about liability.")

        async def fake_acompletion(**kwargs: Any) -> Any:
            raise ConnectionError("ollama unreachable")

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)
        # Skip the retry backoff (up to ~30s) so this test stays fast.
        monkeypatch.setattr(
            qa_api._call_litellm_with_retry.retry, "wait", lambda *_a, **_kw: 0
        )

        response = await client.post(
            "/api/qa/ask",
            json={"question": "clause text about liability"},
            headers=_headers(user),
        )

        assert response.status_code == 503
        assert "detail" in response.json()
        # No raw provider exception text leaked to the client.
        assert "ollama unreachable" not in response.text


class TestOrgScoping:
    async def test_user_in_org_a_cannot_get_citations_from_org_b(
        self, client: httpx.AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        org_a, user_a = await _create_org_user(db_session, email="a@example.com")
        org_b, user_b = await _create_org_user(db_session, email="b@example.com")
        contract_a = await _create_contract(db_session, org_a, user_a, title="Org A Contract")
        contract_b = await _create_contract(db_session, org_b, user_b, title="Org B Contract")
        await _create_clause(
            db_session, contract_a, ordinal=0, text="Org A confidential clause about liability caps."
        )
        clause_b = await _create_clause(
            db_session, contract_b, ordinal=0, text="Org B confidential clause about liability caps."
        )

        seen_context_blocks: list[str] = []

        async def fake_acompletion(**kwargs: Any) -> Any:
            seen_context_blocks.append(kwargs["messages"][1]["content"])
            return _litellm_json_response(
                {
                    "answer": "Liability caps apply.",
                    "citations": [{"index": 1, "quote": "confidential clause about liability caps"}],
                    "confidence": 0.7,
                }
            )

        monkeypatch.setattr(qa_api.litellm, "acompletion", fake_acompletion)

        response = await client.post(
            "/api/qa/ask",
            json={"question": "liability caps"},
            headers=_headers(user_a),
        )

        assert response.status_code == 200
        body = response.json()
        # Org A's user must only ever see Org A's contract as a citation.
        assert body["citations"][0]["contract_id"] == str(contract_a.id)
        assert body["citations"][0]["contract_id"] != str(contract_b.id)
        assert str(clause_b.id) not in json.dumps(body)
        # And Org B's clause text must never even reach the LLM prompt.
        assert "Org B confidential clause" not in seen_context_blocks[0]
