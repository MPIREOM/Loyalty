#!/bin/sh
# Container entrypoint: if litestream credentials are set, run the Node
# server under `litestream replicate` so every SQLite change is streamed
# to an off-site bucket. Otherwise fall back to plain `node server.js`.
set -e

DB_PATH="${DATA_DIR:-/data}/loyalty.db"
mkdir -p "$(dirname "$DB_PATH")"

if [ -n "$LITESTREAM_BUCKET" ]; then
  # First boot after a volume loss: restore the latest backup before Node
  # opens the DB. -if-replica-exists is a no-op when there's no prior backup.
  if [ ! -f "$DB_PATH" ]; then
    echo "==> No local DB at $DB_PATH — attempting litestream restore from ${LITESTREAM_BUCKET}..."
    litestream restore -if-replica-exists -config /etc/litestream.yml "$DB_PATH" \
      || echo "==> No existing backup found — starting with a fresh database."
  fi
  echo "==> Starting Node under litestream continuous replication."
  exec litestream replicate -config /etc/litestream.yml -exec "node server.js"
else
  echo "==> LITESTREAM_BUCKET not set — running without backup replication."
  exec node server.js
fi
