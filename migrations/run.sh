#!/bin/sh
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set"; exit 1
fi

echo "db-migrator: applying migrations to ${DATABASE_URL%%\?*} ..."
for f in /migrations/*.sql; do
  echo "==> psql -f $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
echo "db-migrator: all done."
