# Secret Rotation Runbook

Whereas has several secrets that may need to be rotated:

| Secret | When to rotate | Difficulty |
|---|---|---|
| `POSTGRES_PASSWORD` | After suspected compromise; otherwise yearly | Easy |
| `MINIO_ROOT_PASSWORD` | After suspected compromise; otherwise yearly | Easy |
| `SECRET_KEY` (sessions) | After suspected compromise; otherwise yearly | Medium (invalidates all sessions) |
| `DOCUSEAL_AUTH_BRIDGE_SECRET` | After suspected compromise; otherwise yearly | Easy |
| `DOCUSEAL_SECRET_KEY_BASE` | After suspected compromise | Medium (invalidates DocuSeal sessions) |
| `WHEREAS_INSTANCE_KEY` | After suspected compromise of the host or KMS | **Hard — requires re-wrapping all org master keys** |

## Easy rotations (Postgres, MinIO, DocuSeal bridge)

1. Take a backup before doing anything.
2. Generate the new secret: `openssl rand -hex 32` or `openssl rand -base64 32`.
3. Update `.env` with the new value.
4. For Postgres, update the password in the running database first:
   ```bash
   docker compose exec postgres psql -U whereas -c "ALTER USER whereas WITH PASSWORD 'new-password-here';"
   ```
   Then update `.env` to match.
5. `docker compose up -d` to restart with the new value.
6. Verify the application still works (login, upload a test document, etc.).
7. Record the rotation as an audit event:
   ```sql
   -- Use the application-level rotation endpoint (admin only) so the audit log
   -- entry has the full chain context. Don't insert directly.
   ```

## Medium rotation: SECRET_KEY (session signing)

1. Generate new value: `openssl rand -hex 32`.
2. Update `.env`.
3. `docker compose restart backend`. All active sessions are invalidated; users must log in again. Communicate this in advance.

## Medium rotation: DOCUSEAL_SECRET_KEY_BASE

1. Generate new value: `openssl rand -hex 64`.
2. Update `.env`.
3. `docker compose restart docuseal`. DocuSeal sessions invalidate; in-progress signing flows may break and need to be re-sent. Plan a maintenance window.

## Hard rotation: WHEREAS_INSTANCE_KEY

This is the most complex operation in the system because the instance key wraps every org master key. Rotation requires unwrapping each org master key with the old instance key and re-wrapping with the new one. The plaintext document content is never touched; only the key hierarchy is rebuilt.

### Prerequisites

- A complete, verified backup of Postgres.
- A maintenance window. The application must be in read-only mode during rotation.
- The OLD `WHEREAS_INSTANCE_KEY` is still available. **You cannot rotate without it.** If the old key is lost, every encrypted document is permanently unrecoverable; rotation will not save you.

### Procedure

1. Take a fresh Postgres backup. Tag it `pre-instance-key-rotation-YYYYMMDD`.

2. Put the application in read-only mode (admin-only feature; planned for v0.1.5).

3. Generate the new instance key:
   ```bash
   NEW_KEY=$(openssl rand -hex 32)
   echo "Backup this immediately: $NEW_KEY"
   ```
   Back it up to your offline storage *before* proceeding. If the rotation crashes mid-flight, you need both the old and the new key to recover.

4. Run the rotation script:
   ```bash
   docker compose exec backend python -m app.scripts.rotate_instance_key \
       --old-key "$OLD_WHEREAS_INSTANCE_KEY" \
       --new-key "$NEW_KEY"
   ```
   (Script not yet shipped; planned for v0.1.)

   The script:
   - Iterates over every Organization row.
   - Unwraps the org master key with the old instance key.
   - Re-wraps it with the new instance key.
   - Writes back the new wrapped form in a single transaction per org.
   - Records audit events for each org.

5. Verify a sample document decrypts successfully under the new key:
   ```bash
   docker compose exec backend python -m app.scripts.verify_decryption --sample-size 10
   ```

6. Update `.env`:
   ```
   WHEREAS_INSTANCE_KEY=<new key>
   ```

7. `docker compose restart backend`. The application now uses the new key.

8. Verify again: log in, view a contract, confirm extracted fields render with their spans.

9. Take the application out of read-only mode.

10. After verification (recommend 24-48 hours), securely delete the old instance key. **Do not delete it earlier.** If something is wrong and you discover it 12 hours after rotation, the old key is your only path to recovery.

### Recovery from failed rotation

If the script crashes partway through:

1. Stop. Do not restart the application. Do not run the script again.
2. Restore Postgres from the `pre-instance-key-rotation-YYYYMMDD` backup.
3. Restore the old `WHEREAS_INSTANCE_KEY` in `.env`.
4. Restart and verify the application works.
5. Investigate why the rotation failed before retrying.

The script is designed to be idempotent at the per-org level, but a half-rotated database state is dangerous and the recovery path is "restore, don't replay."
