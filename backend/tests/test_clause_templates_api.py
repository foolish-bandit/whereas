from __future__ import annotations

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ClauseTemplate

from .test_playbooks_api import _create_user_org, _headers


@pytest.mark.asyncio
async def test_create_list_update_delete_clause_template(client: httpx.AsyncClient, db_session: AsyncSession) -> None:
    user_org = await _create_user_org(db_session)
    r = await client.post('/api/clause-templates', headers=_headers(user_org.user), json={"name":"NDA","clause_type":"confidentiality","text":"abc","tags":["nda"]})
    assert r.status_code == 201
    cid = r.json()["id"]

    r = await client.get('/api/clause-templates', headers=_headers(user_org.user))
    assert any(x["id"] == cid for x in r.json())

    r = await client.patch(f'/api/clause-templates/{cid}', headers=_headers(user_org.user), json={"name":"NDA 2"})
    assert r.status_code == 200
    assert r.json()["name"] == "NDA 2"

    r = await client.delete(f'/api/clause-templates/{cid}', headers=_headers(user_org.user))
    assert r.status_code == 200
    assert r.json()["is_active"] is False

    r = await client.get('/api/clause-templates', headers=_headers(user_org.user))
    assert all(x["id"] != cid for x in r.json())

    r = await client.get('/api/clause-templates?include_inactive=true', headers=_headers(user_org.user))
    assert any(x["id"] == cid for x in r.json())


@pytest.mark.asyncio
async def test_cross_org_404(client: httpx.AsyncClient, db_session: AsyncSession) -> None:
    a = await _create_user_org(db_session)
    b = await _create_user_org(db_session)
    row = ClauseTemplate(organization_id=a.org.id, name='x', clause_type='y', text='z')
    db_session.add(row)
    await db_session.commit()
    r = await client.get(f'/api/clause-templates/{row.id}', headers=_headers(b.user))
    assert r.status_code == 404
