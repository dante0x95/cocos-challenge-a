#!/usr/bin/env bash
# C §7 — Calentamiento: publica el snapshot de todos los usuarios con historia (una transacción por
# usuario, en orden de historia descendente). Uso: bench/warm.sh [perfil]
set -euo pipefail
PROFILE="${1:-medium}"
case "$PROFILE" in small) PORT=5433 ;; medium) PORT=5434 ;; large) PORT=5435 ;; neon) PORT=5436 ;; *) echo "perfil?" >&2; exit 1 ;; esac
PORT="${BENCH_PG_PORT:-$PORT}"   # otro puerto del host si el del perfil está ocupado
PG="postgresql://postgres:postgres@localhost:$PORT/trading"
T0=$(date +%s)
psql "$PG" -q -v ON_ERROR_STOP=1 <<'SQL'
\t on
SELECT format('SELECT app.warm_snapshot(%s)', userid)
  FROM (SELECT userid, count(*) AS n FROM app.orders WHERE status = 'FILLED' GROUP BY userid ORDER BY n DESC) u
\gexec
\t off
SELECT count(*) AS snapshots, pg_size_pretty(pg_total_relation_size('app.balance_snapshots') + pg_total_relation_size('app.snapshot_positions')) AS size FROM app.balance_snapshots;
SQL
echo "calentamiento: $(( $(date +%s) - T0 )) s"
