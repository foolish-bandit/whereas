from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

# pytest resolves fixtures by name in the consumer module's namespace,
# so re-exporting these four (``client``, ``db_session``, ``engine``,
# ``postgres_container``) from ``test_findings_api`` is what wires up
# the async ``httpx`` client + sqlite/postgres engine used below.
# Without this import the tests collected here error with
# "fixture 'client' not found". The helper functions
# ``_create_workspace`` / ``_headers`` are imported for use directly.
# F401: imported-but-unused — pytest *does* use them, by name lookup.
# F811: shadow of imported name by the test's parameter — that is the
# whole point of pytest fixture parameters.
from .test_findings_api import (  # noqa: F401
    _create_workspace,
    _headers,
    client,
    db_session,
    engine,
    postgres_container,
)


def _url(template_id: uuid.UUID | None = None) -> str:
    base = "/api/clause-templates"
    return f"{base}/{template_id}" if template_id else base


@pytest.mark.asyncio
async def test_create_and_list_clause_template(client: httpx.AsyncClient, db_session: AsyncSession) -> None:  # noqa: F811
    ws = await _create_workspace(db_session)
    resp = await client.post(_url(), headers=_headers(ws.user), json={"name": "Assignment", "clause_type": "assignment", "text": "Neither party may assign...", "tags": ["core"]})
    assert resp.status_code == 201
    assert resp.json()["name"] == "Assignment"

    list_resp = await client.get(_url(), headers=_headers(ws.user))
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1


@pytest.mark.asyncio
async def test_soft_delete_excludes_by_default(client: httpx.AsyncClient, db_session: AsyncSession) -> None:  # noqa: F811
    ws = await _create_workspace(db_session)
    created = await client.post(_url(), headers=_headers(ws.user), json={"name": "GL", "clause_type": "governing_law", "text": "CA law"})
    cid = created.json()["id"]
    deleted = await client.delete(f"/api/clause-templates/{cid}", headers=_headers(ws.user))
    assert deleted.status_code == 204
    assert (await client.get(_url(), headers=_headers(ws.user))).json() == []
    assert len((await client.get(f"{_url()}?include_inactive=true", headers=_headers(ws.user))).json()) == 1


@pytest.mark.asyncio
async def test_cross_org_404(client: httpx.AsyncClient, db_session: AsyncSession) -> None:  # noqa: F811
    ws1 = await _create_workspace(db_session)
    ws2 = await _create_workspace(db_session)
    created = await client.post(_url(), headers=_headers(ws1.user), json={"name": "GL", "clause_type": "governing_law", "text": "CA law"})
    cid = created.json()["id"]
    resp = await client.get(f"/api/clause-templates/{cid}", headers=_headers(ws2.user))
    assert resp.status_code == 404
