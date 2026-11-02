#!/usr/bin/env bash
# Fase 8 — Carga el dataset generado en un contenedor fresco ya migrado y lo hornea en bench.dump.
# Uso: bench/gen/load.sh [perfil] [dir]     (default: medium bench/gen/out)
# Requiere: bench/reset.sh <perfil> hecho (o lo hace), CSVs en <dir>.
set -euo pipefail
PROFILE="${1:-medium}"; DIR="${2:-bench/gen/out}"
case "$PROFILE" in small) PORT=5433 ;; medium) PORT=5434 ;; large) PORT=5435 ;; neon) PORT=5436 ;; *) echo "perfil?" >&2; exit 1 ;; esac
PORT="${BENCH_PG_PORT:-$PORT}"   # otro puerto del host si el del perfil está ocupado
PG="postgresql://postgres:postgres@localhost:$PORT/trading"
cd "$(dirname "$0")/../.."

bench/reset.sh "$PROFILE"

echo "== COPY (trigger e índices fuera durante la carga) =="
time psql "$PG" -v ON_ERROR_STOP=1 -q <<SQL
ALTER TABLE app.orders DISABLE TRIGGER orders_guard;
DROP INDEX app.orders_balance_seq, app.orders_filled_by_user, app.orders_new_by_user;
\\copy app.users       (id,email,accountnumber)                                     FROM '$DIR/users.csv'       CSV HEADER
\\copy app.instruments (id,ticker,name,type)                                        FROM '$DIR/instruments.csv' CSV HEADER
\\copy app.marketdata  (id,instrumentid,high,low,open,close,previousclose,date)     FROM '$DIR/marketdata.csv'  CSV HEADER
\\copy app.orders      (id,instrumentid,userid,size,price,type,side,status,datetime,balance_seq) FROM '$DIR/orders.csv' CSV HEADER
SQL

echo "== índices =="
time psql "$PG" -v ON_ERROR_STOP=1 -q <<'SQL'
SET maintenance_work_mem = '512MB';
CREATE UNIQUE INDEX orders_balance_seq ON app.orders (userid, balance_seq) WHERE balance_seq IS NOT NULL;
CREATE INDEX orders_filled_by_user ON app.orders (userid, balance_seq) INCLUDE (instrumentid, side, size, price) WHERE status = 'FILLED';
CREATE INDEX orders_new_by_user ON app.orders (userid) INCLUDE (instrumentid, side, size, price) WHERE status = 'NEW';
ALTER TABLE app.orders ENABLE TRIGGER orders_guard;
SELECT setval(pg_get_serial_sequence('app.orders','id'), (SELECT max(id) FROM app.orders));
VACUUM (ANALYZE) app.orders; ANALYZE app.marketdata; ANALYZE app.users; ANALYZE app.instruments;
SQL

echo "== verificación en bloque (lo que el trigger habría comprobado fila a fila) =="
psql "$PG" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM app.orders WHERE (status = 'FILLED') <> (balance_seq IS NOT NULL);
  IF n > 0 THEN RAISE EXCEPTION '% filas violan (FILLED) = (seq not null)', n; END IF;
  SELECT count(*) INTO n FROM (
    SELECT userid, balance_seq, lag(balance_seq) OVER (PARTITION BY userid ORDER BY balance_seq) AS prev
      FROM app.orders WHERE balance_seq IS NOT NULL) x
   WHERE prev IS NULL AND balance_seq <> 1 OR prev IS NOT NULL AND balance_seq <> prev + 1;
  IF n > 0 THEN RAISE EXCEPTION '% huecos o repeticiones en balance_seq', n; END IF;
  RAISE NOTICE 'balance_seq consecutiva por usuario: OK';
END $$;
SELECT count(*) AS orders, pg_size_pretty(pg_database_size('trading')) AS db,
       pg_size_pretty(pg_relation_size('app.orders')) AS orders_heap,
       pg_size_pretty(pg_relation_size('app.orders_filled_by_user')) AS idx_filled,
       pg_size_pretty(pg_relation_size('app.orders_balance_seq')) AS idx_seq,
       pg_size_pretty(pg_relation_size('app.orders_new_by_user')) AS idx_new
  FROM app.orders;
SELECT status, count(*) FROM app.orders GROUP BY 1 ORDER BY 1;
SELECT userid, count(*) FROM app.orders WHERE status = 'FILLED' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
SQL

echo "== dump =="
time pg_dump "$PG" -Fc --no-owner --no-privileges -f bench/dump/bench.dump
ls -lh bench/dump/bench.dump
