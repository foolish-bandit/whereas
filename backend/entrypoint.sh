#!/bin/sh
# Entrypoint for the backend container.
#
# `docker compose up` must bring up a working schema without a manual
# `alembic upgrade head` step (self-host-first: see docs/design-principles.md
# principle 4). This runs migrations, then execs whatever command was
# passed (uvicorn, with or without --reload), so it stays a transparent
# wrapper rather than a fork of the app's runtime behavior.
set -e

echo "Running database migrations (alembic upgrade head)..."
alembic upgrade head

exec "$@"
