#!/usr/bin/env bash
# Deja un perfil en estado "migrado + funciones", desde cero.
# Uso: bench/reset.sh [small|medium|large|neon]   (default: medium)
#   DUMP=trading.dump (default): dump de Neon; corre audit + migrate + functions.
#   DUMP=bench.dump: dataset del benchmark, ya migrado y con funciones; solo restaura.
set -euo pipefail
PROFILE="${1:-medium}"
export DUMP="${DUMP:-trading.dump}"
case "$PROFILE" in
  small) PORT=5433 ;; medium) PORT=5434 ;; large) PORT=5435 ;; neon) PORT=5436 ;;
  *) echo "perfil desconocido: $PROFILE" >&2; exit 1 ;;
esac
PORT="${BENCH_PG_PORT:-$PORT}"   # otro puerto del host si el del perfil está ocupado
PG="postgresql://postgres:postgres@localhost:$PORT/trading"
cd "$(dirname "$0")/docker"
docker compose --profile bench down -v --remove-orphans || true
docker compose up -d --build "pg-$PROFILE"
echo -n "esperando pg-$PROFILE ($DUMP)"
T0=$(date +%s)
for _ in $(seq 1 900); do
  if docker compose exec -T "pg-$PROFILE" pg_isready -U postgres -d trading >/dev/null 2>&1 \
     && psql "$PG" -c 'SELECT 1' >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."; sleep 1
done
echo "restore: $(( $(date +%s) - T0 )) s"
cd ..
if [ "$DUMP" = "trading.dump" ]; then
  psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/00_audit.sql >/dev/null
  psql "$PG" -q -v ON_ERROR_STOP=1 -v ars_id=66 -f sql/10_migrate.sql >/dev/null
  psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/20_schema_roles.sql >/dev/null
  psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/21_functions.sql >/dev/null
  if [ "${WITH_C:-0}" = "1" ]; then
    psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/30_c_tables.sql >/dev/null
    psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/31_c_functions.sql >/dev/null
  fi
  echo "pg-$PROFILE listo en :$PORT (migrado, funciones instaladas${WITH_C:+, C})"
elif [ "$DUMP" = "base.dump" ]; then
  psql "$PG" -c "SELECT count(*) AS orders FROM orders" -c "SELECT pg_size_pretty(pg_database_size('trading')) AS db"
  echo "pg-$PROFILE listo en :$PORT ($DUMP: esquema de Neon tal cual, escenario Z)"
else
  # Las funciones del dump pueden ser viejas: se reaplican siempre (idempotente). WITH_C=1 → C.
  psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/21_functions.sql >/dev/null
  if [ "${WITH_C:-0}" = "1" ]; then
    psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/30_c_tables.sql >/dev/null
    psql "$PG" -q -v ON_ERROR_STOP=1 -f sql/31_c_functions.sql >/dev/null
    psql "$PG" -q -c "UPDATE app.settings SET snapshot_k = ${SNAPSHOT_K:-500}"
  fi
  psql "$PG" -c "SELECT count(*) AS orders FROM app.orders" -c "SELECT pg_size_pretty(pg_database_size('trading')) AS db"
  echo "pg-$PROFILE listo en :$PORT ($DUMP, funciones ${WITH_C:+C }reaplicadas, K=${SNAPSHOT_K:-500})"
fi
