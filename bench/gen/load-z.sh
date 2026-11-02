#!/usr/bin/env bash
# Escenario Z (línea base) — esquema de Neon tal cual (sin migración, sin funciones, sin índices
# nuestros) + los mismos 22M generados, en el formato original: cash con price = 1 y size en pesos,
# sin balance_seq. Produce bench/dump/base.dump.
# Uso: bench/gen/load-z.sh [perfil] [dir]     (default: medium bench/gen/out)
set -euo pipefail
PROFILE="${1:-medium}"; DIR="${2:-bench/gen/out}"
case "$PROFILE" in small) PORT=5433 ;; medium) PORT=5434 ;; large) PORT=5435 ;; neon) PORT=5436 ;; *) echo "perfil?" >&2; exit 1 ;; esac
PORT="${BENCH_PG_PORT:-$PORT}"   # otro puerto del host si el del perfil está ocupado
PG="postgresql://postgres:postgres@localhost:$PORT/trading"
cd "$(dirname "$0")/../.."

echo "== contenedor fresco con trading.dump, SIN migrar =="
cd bench/docker
export DUMP=trading.dump
docker compose --profile bench down -v --remove-orphans || true
docker compose up -d --build "pg-$PROFILE"
echo -n "esperando pg-$PROFILE"
for _ in $(seq 1 120); do
  if psql "$PG" -c 'SELECT 1' >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."; sleep 1
done
cd ../..

echo "== esquema original: índices y constraints que trae Neon =="
psql "$PG" -c "\di" -c "\d orders"

echo "== COPY en el formato original (staging -> transformación -> orders) =="
time psql "$PG" -v ON_ERROR_STOP=1 -q <<SQL
\\copy users       (id,email,accountnumber)                                 FROM '$DIR/users.csv'       CSV HEADER
\\copy instruments (id,ticker,name,type)                                    FROM '$DIR/instruments.csv' CSV HEADER
\\copy marketdata  (id,instrumentid,high,low,open,close,previousclose,date) FROM '$DIR/marketdata.csv'  CSV HEADER
CREATE UNLOGGED TABLE z_stage (id int, instrumentid int, userid int, size bigint, price numeric, type text, side text, status text, datetime timestamp, balance_seq bigint);
\\copy z_stage FROM '$DIR/orders.csv' CSV HEADER
-- Formato original: cash en pesos enteros a price 1 (el generador emite centavos a 0.01). Sin balance_seq.
INSERT INTO orders (id, instrumentid, userid, size, price, type, side, status, datetime)
SELECT id, instrumentid, userid,
       CASE WHEN side IN ('CASH_IN','CASH_OUT') THEN (size / 100)::int ELSE size::int END,
       CASE WHEN side IN ('CASH_IN','CASH_OUT') THEN 1 ELSE price END,
       type, side, status, datetime
  FROM z_stage;
DROP TABLE z_stage;
SELECT setval(pg_get_serial_sequence('orders','id'), (SELECT max(id) FROM orders));
SELECT setval(pg_get_serial_sequence('users','id'), (SELECT max(id) FROM users));
VACUUM (ANALYZE) orders; ANALYZE marketdata;
SQL

psql "$PG" -c "SELECT count(*) AS orders, pg_size_pretty(pg_database_size('trading')) AS db, pg_size_pretty(pg_relation_size('orders')) AS orders_heap FROM orders" \
          -c "SELECT side, min(price), max(price) FROM orders WHERE side LIKE 'CASH%' GROUP BY 1"

echo "== dump =="
time pg_dump "$PG" -Fc --no-owner --no-privileges -f bench/dump/base.dump
ls -lh bench/dump/base.dump
