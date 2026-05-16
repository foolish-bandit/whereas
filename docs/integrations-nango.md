# Third-party integrations (Nango)

Whereas pulls contracts in from Google Drive, OneDrive, SharePoint,
Gmail, and Outlook through a self-hosted
[Nango](https://github.com/NangoHQ/nango) deployment that runs as a
peer service in `docker-compose.yml` — same shape as DocuSeal.

Tokens stay in Nango; the Whereas backend only holds the opaque
`connection_id` Nango hands back after the OAuth dance. Documents
imported through an integration land in Whereas through the same
encrypted-at-rest, span-cited pipeline as direct uploads.

## Architecture at a glance

```
   ┌────────────┐    Connect UI / OAuth      ┌─────────────────┐
   │ Whereas UI │────────────────────────────▶  Provider OAuth │
   └─────┬──────┘                             └─────────────────┘
         │ session token                              │
         ▼                                            ▼
   ┌────────────┐    REST API + webhooks       ┌─────────────┐
   │  Whereas   │◀────────────────────────────▶│    Nango    │
   │  backend   │                              │  (peer svc) │
   └─────┬──────┘                              └─────┬───────┘
         │                                           │ provider syncs
         │ Contract + InboxItem rows                 ▼
         ▼                                     ┌─────────────┐
   ┌────────────┐                              │   Provider  │
   │  Postgres  │                              │ (Drive etc.)│
   └────────────┘                              └─────────────┘
```

## Operator setup

1. **Generate Nango secrets** (one-time, before `docker compose up`):

   ```
   NANGO_ENCRYPTION_KEY=$(openssl rand -base64 32)
   NANGO_SECRET_KEY=$(openssl rand -hex 32)
   NANGO_WEBHOOK_SECRET=$(openssl rand -hex 32)
   NANGO_DASHBOARD_PASSWORD=$(openssl rand -hex 16)
   ```

   Add these to your `.env`. Also set
   `NANGO_PUBLIC_URL=http://localhost:3003` (or whatever URL the
   Nango dashboard is reachable at) so providers can redirect back.

2. **Bring the stack up**:

   ```
   docker compose up -d postgres minio nango-server nango-jobs backend frontend
   ```

   `init-multiple-dbs.sh` creates the `nango` database alongside
   `whereas` and `docuseal` on first boot.

3. **Configure providers in the Nango dashboard** at
   `http://localhost:3003`:
   - Add the OAuth client id / secret for each provider you want
     (Google Cloud project, Microsoft Entra app registration).
   - Create a sync named `documents` per provider that returns rows
     of the shape the Whereas Nango client expects (see
     `backend/app/services/nango_client.py::NangoFile`).
   - Point the outbound webhook at
     `http://backend:8000/api/integrations/webhook` using
     `NANGO_WEBHOOK_SECRET` as the signing secret.

4. **List enabled providers** so the Whereas UI hides Connect
   buttons for providers you haven't configured:

   ```
   NANGO_ENABLED_PROVIDERS=google-drive,microsoft-onedrive
   ```

## End-user flow (per organization, admin only)

1. Admin opens the Integrations settings page.
2. Clicks **Connect Google Drive**, which calls
   `POST /api/integrations/connect-sessions` and launches Nango's
   Connect widget with the returned token.
3. After the OAuth dance the widget hands back a `connection_id`;
   the frontend posts it to `POST /api/integrations/connections`.
4. Files start flowing in via Nango's outbound webhook
   (`POST /api/integrations/webhook`); the admin can also click
   **Sync now** to call `POST /api/integrations/connections/{id}/sync`.

## Ingest modes

Each connection has an `ingest_mode`:

- `inbox_review` (default): every imported file becomes a `Contract`
  in the standard pipeline AND an `InboxItem` of type
  `imported_document_review` so a human confirms it is a contract.
- `direct`: imported files go straight through with no inbox item.
  Use this when a connection points at a tightly curated folder that
  only ever contains contracts.

## Idempotency

Each imported file is recorded in `integration_imported_files` keyed
on `(connection_id, provider_file_id)`. A second delivery (webhook
re-fire, manual sync re-run) finds the row, sees `contract_id` is
already set, and short-circuits without creating duplicates.

## Security posture

- Tokens live in Nango's encrypted store (`NANGO_ENCRYPTION_KEY`),
  not in our Postgres.
- The webhook receiver verifies `X-Nango-Signature` (HMAC-SHA256 over
  `"{timestamp}.{body}"` keyed on `NANGO_WEBHOOK_SECRET`) with a
  5-minute replay tolerance.
- `NANGO_WEBHOOK_SECRET` unset in any non-`development` environment
  causes the receiver to fail closed (503).
- The proxy download path refuses URLs that don't share the
  configured Nango base host, so a misbehaving sync record can't
  redirect Whereas to fetch arbitrary URLs.
- Audit events: `integration.connection.created`,
  `integration.connection.updated`, `integration.connection.deleted`,
  `integration.sync.triggered`, `integration.file.imported`.

## Disabling integrations

Leave `NANGO_SECRET_KEY` unset. The `/api/integrations/connect-sessions`
endpoint surfaces a clean 503, the providers list shows everything as
`available=false`, and no other code path is affected.
