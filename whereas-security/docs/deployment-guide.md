# Whereas Deployment Guide

This guide walks through deploying Whereas in production. If you only want to try it out, the README's quickstart is enough; come back here when you're ready to put real contracts in it.

## Prerequisites

- A Linux host with at least 8 GB RAM and 50 GB disk. More if you're running the LLM locally with a large model — Llama 3.1 70B in 4-bit quantization needs ~40 GB RAM by itself.
- Docker and Docker Compose v2.
- A domain name pointing at the host (for TLS).
- `openssl` available on the host (for the secret generation script).
- Network egress to GitHub (for the container images and code) and, if you're using Ollama, to model registries.

## Step 1: Get the code

```bash
git clone https://github.com/whereas-clm/whereas.git
cd whereas
git checkout v0.1.0   # or whatever the latest tagged release is
```

Don't run from `main` in production. Pin to a tagged release.

## Step 2: Generate secrets

```bash
./scripts/generate-secrets.sh
```

This creates `.env` with cryptographically random values. The script will refuse to overwrite an existing `.env` — that's intentional.

**Critical.** Back up `WHEREAS_INSTANCE_KEY` immediately. If you lose this value, every encrypted document becomes unrecoverable. There is no recovery path. Store it in a password manager, a hardware token, or an offline encrypted backup. Don't store it in the same place as your database backup — that defeats the purpose.

## Step 3: Configure your LLM provider

The default is local Ollama. Document content never leaves your network with this configuration. For most legal teams, this is the right choice and you can skip to Step 4.

If you need a remote provider for quality reasons:

1. Edit `.env`:
   ```
   LITELLM_PROVIDER=anthropic   # or openai, azure, etc.
   ANTHROPIC_API_KEY=sk-ant-...
   EXTRACTION_MODEL=claude-3-5-sonnet-20241022
   ```
2. Decide whether to install a pre-LLM hook. If you have a PII redaction layer (Sonomos CLOAK, presidio, a custom redactor), set:
   ```
   WHEREAS_PRE_LLM_HOOK=your_module.path:hook_callable
   ```
   See [security-model.md](./security-model.md#llm-provider-safety) for details.

## Step 4: Bring up the stack

```bash
docker compose up -d
docker compose logs -f backend
```

The first run takes a few minutes because it pulls images and runs migrations. Watch for the line `Whereas starting`. If you don't see it, check `docker compose logs postgres` and `docker compose logs backend` for errors.

## Step 5: Put a reverse proxy in front

The Compose stack binds all ports to `127.0.0.1` so the application is not directly reachable from the internet. You need a reverse proxy with TLS in front of it. Caddy is the simplest path; nginx works fine if you already use it.

### Caddy (recommended for new deployments)

`/etc/caddy/Caddyfile`:

```caddy
whereas.example.com {
    reverse_proxy 127.0.0.1:8080  # frontend
    handle_path /api/* {
        reverse_proxy 127.0.0.1:8000  # backend
    }
}

sign.whereas.example.com {
    reverse_proxy 127.0.0.1:8081  # DocuSeal
}
```

Caddy fetches and renews Let's Encrypt certificates automatically. No config needed beyond what's above.

### nginx

You'll need to fetch certs separately (Certbot, Lego, etc.). Sample server block:

```nginx
server {
    listen 443 ssl http2;
    server_name whereas.example.com;
    ssl_certificate     /etc/letsencrypt/live/whereas.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/whereas.example.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:...;
    ssl_prefer_server_ciphers on;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
```

If you use a reverse proxy, **you must** start uvicorn with `--forwarded-allow-ips=<proxy_ip>` so rate-limiting sees real client IPs. Edit the `command` in `docker-compose.yml`'s `backend` service:

```yaml
command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --forwarded-allow-ips=127.0.0.1
```

## Step 6: Initial admin setup

After the stack is running and reachable, hit `https://whereas.example.com/setup` with your browser. The first request to `/setup` creates the initial organization and admin user. Subsequent requests to that endpoint return 404 — there is no second admin bootstrap.

Set a strong password. Enable MFA immediately (TOTP via any standard authenticator).

## Step 7: Backups

You need to back up:

1. **Postgres** — contains all metadata, user data, audit logs, wrapped DEKs.
2. **MinIO/S3** — contains encrypted document blobs.
3. **`.env`** — contains the instance key. **Do not store this in the same backup as Postgres.** If both backups are stolen together, the attacker has everything they need to decrypt.

### Postgres

Daily backup with `pg_dump`, encrypted before leaving the host:

```bash
docker compose exec -T postgres pg_dump -U whereas whereas \
    | gpg --encrypt --recipient your-key-id \
    > /backups/whereas-$(date +%Y%m%d).sql.gpg
```

Schedule via cron or systemd timer. Retain 30 days locally and ship to off-site object storage (S3, B2, R2) with at least a 90-day retention.

For larger deployments, switch to `pgbackrest` which supports point-in-time recovery.

### MinIO

`mc mirror` to off-site object storage:

```bash
mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc alias set offsite https://s3.amazonaws.com "$AWS_ACCESS_KEY" "$AWS_SECRET_KEY"
mc mirror --overwrite local/whereas-documents offsite/whereas-backup-bucket
```

The blobs are already encrypted at the application layer, so you do NOT need to add a second encryption layer for transit — but the offsite bucket should still have its own at-rest encryption enabled (SSE-S3 minimum, SSE-KMS preferred).

### Test restore quarterly

Untested backups are decorative. Every quarter, restore to a staging host and verify you can decrypt at least one document. If you can't, find out why before you need to.

A reference restore script lives at `scripts/test-restore.sh`. (Not yet shipped; planned for v0.1.)

## Step 8: Monitoring

Minimum viable monitoring:

- **Process liveness.** Compose's restart policy handles crashes; you also need to know when something is restart-looping. Any process supervisor (systemd, monit, healthchecks.io) will do.
- **Disk space.** Postgres, MinIO, and Ollama all grow. Alert at 80% full.
- **Failed login spike.** Audit log queries for high `user.login.failure` rates indicate credential stuffing. Set up a daily summary.
- **Audit chain verification.** Run `verify_chain` daily as a cron job. Alert immediately on failure — chain failure is a serious event.
- **TLS certificate expiry.** Caddy handles this automatically; if you're on nginx + Certbot, check your renewal hook.

## Step 9: Updates

When a new Whereas version is released:

1. Read the release notes. Look for breaking changes (database migrations, env var renames).
2. Take a backup *before* updating.
3. `git fetch && git checkout v0.X.Y && docker compose pull && docker compose up -d`
4. Watch the logs for migration completion. The backend won't accept requests until migrations succeed.

If migration fails, restore from backup. Do not run a partially-migrated database in production.

## Hardening checklist

For deployments handling sensitive material, these are non-negotiable:

- [ ] TLS with valid certs, A or A+ on SSL Labs
- [ ] HSTS verified live (try `curl -I https://your-domain | grep Strict`)
- [ ] CSP verified live; check the browser console for violation reports
- [ ] `WHEREAS_INSTANCE_KEY` backed up to an offline location, separate from database backups
- [ ] Postgres bound to localhost or a private network only — never the public internet
- [ ] MinIO console (port 9001) firewalled; admin only
- [ ] SSH on the host: key-only auth, no password, fail2ban or equivalent
- [ ] OS package updates auto-applied for security patches (`unattended-upgrades` on Debian/Ubuntu)
- [ ] Docker daemon not exposed on TCP
- [ ] Audit log retention policy documented and tested
- [ ] At least one tested backup restore per quarter
- [ ] An incident response runbook with named on-call

## Common operational issues

### "uvicorn won't start because WHEREAS_INSTANCE_KEY is not set"

The script `generate-secrets.sh` was not run, or `.env` is not being loaded. Check that `.env` exists and is referenced from `docker-compose.yml` (it is, by default).

### "Documents fail to decrypt with 'tag mismatch' error"

Either the wrong `WHEREAS_INSTANCE_KEY` is loaded, or the wrapped key in Postgres has been tampered with. If you've recently restored from backup, you may have mixed an old database with a new instance key. Check that your backups are in sync.

### "Rate limiter blocks legitimate users"

You're behind a reverse proxy and `--forwarded-allow-ips` is not configured, so all requests look like they come from the proxy IP. Fix the uvicorn command line as shown in Step 5.

### "DocuSeal won't load in the iframe"

The CSP doesn't know about your DocuSeal URL. Set `DOCUSEAL_BASE_URL` correctly in `.env` and restart the backend; the CSP is built from that value.

### "First request to LLM is very slow"

Ollama loads models lazily on first request. Pre-load with `docker compose exec ollama ollama pull llama3.1:70b` after first bring-up.
