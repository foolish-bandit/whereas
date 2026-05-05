#!/bin/bash
# Creates multiple databases in a single Postgres instance.
# Used by docker-compose to provision separate DBs for Whereas and DocuSeal.
set -e
set -u

if [ -n "${POSTGRES_MULTIPLE_DATABASES:-}" ]; then
    echo "Creating multiple databases: $POSTGRES_MULTIPLE_DATABASES"
    for db in $(echo "$POSTGRES_MULTIPLE_DATABASES" | tr ',' ' '); do
        echo "  -> $db"
        psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
            CREATE DATABASE "$db";
            GRANT ALL PRIVILEGES ON DATABASE "$db" TO "$POSTGRES_USER";
EOSQL
    done
    # Enable pgvector on the whereas database only.
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "whereas" <<-EOSQL
        CREATE EXTENSION IF NOT EXISTS vector;
EOSQL
    echo "Databases created."
fi
