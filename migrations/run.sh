#!/bin/sh
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL missing}"

# Standard: nur UP anwenden (lexikografisch sortiert)
if [ "${ROLLBACK:-0}" = "0" ]; then
  for f in /migrations/*_up.sql /migrations/[0-9]*.sql /migrations/*run_tracking.sql; do
    [ -f "$f" ] || continue
    echo "==> Applying $f"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
else
  # Rollback: nur *_down.sql (in umgekehrter Reihenfolge)
  for f in $(ls -r /migrations/*_down.sql 2>/dev/null || true); do
    echo "==> Rolling back $f"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
fi
