#!/bin/bash
# The ClickHouse entrypoint sources this file, so a subshell keeps these options out of it.
# (Test fixture: abbreviated copy of appwrite/appwrite@2.4.0 clickhouse-init.sh.)
(
  set -euo pipefail

  client() {
    clickhouse-client --host 127.0.0.1 --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" "$@"
  }

  # Flushing replaces log tables whose definition changed, keeping each old table as <log>_<N>.
  client --query 'SYSTEM FLUSH LOGS'
)
