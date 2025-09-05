#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?set DATABASE_URL env var}"
MODE="${MODE:-up}"

psqln() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$1"
}

echo "==> Running migrations (MODE=$MODE)"

if [ "$MODE" = "down" ]; then
  files=$(ls -1 *_down.sql 2>/dev/null | sort -r || true)
  if [ -z "${files}" ]; then
    echo "No *_down.sql files found. Nothing to do."
    exit 0
  fi
  for f in $files; do
    echo "==> Applying DOWN: $f"
    psqln "$f" || { echo "DOWN failed on $f"; exit 1; }
  done
else
  up_files=$(ls -1 *_up.sql 2>/dev/null | sort || true)
  plain_files=$(ls -1 *.sql 2>/dev/null | grep -v '_up\.sql$' | grep -v '_down\.sql$' | sort || true)

  if [ -z "${up_files}${plain_files}" ]; then
    echo "No migration SQL files found."
    exit 0
  fi

  for f in $up_files $plain_files; do
    echo "==> Applying UP: $f"
    psqln "$f" || { echo "UP failed on $f"; exit 1; }
  done
fi

echo "==> Migrations done."
