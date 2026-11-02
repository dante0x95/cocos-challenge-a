#!/usr/bin/env bash
# Control negativo de bench/gen/verify.ts (issue #70), contra un Postgres real: verify tiene que
# fallar si app.read_portfolio pierde una posición, aunque el cash siga bien.
#   1. bench/reset.sh medium sobre trading.dump: la base del challenge, migrada, con las funciones de A.
#   2. Una historia para el usuario 2 (sin órdenes en el challenge) por app.place_order: depósito,
#      compras de dos instrumentos, una venta y dos LIMIT pendientes.
#   3. verify sobre ese usuario: 0 diferencias.
#   4. read_portfolio saboteado (las filas de posiciones con AND false): verify tiene que salir con 1
#      y nombrar las posiciones que faltan.
# Usa el proyecto de compose cocos-bench (reset.sh lo borra antes y este script al terminar) y
# BENCH_PG_PORT si el 5434 está ocupado. Necesita Docker, psql y bench/dump/trading.dump
# (bench/dump/seed.sh). No corre en el CI. Uso: bench/test/verify-negative.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${BENCH_PG_PORT:-5434}"
PG="postgresql://postgres:postgres@localhost:$PORT/trading"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; (cd bench/docker && docker compose --profile bench down -v --remove-orphans >/dev/null 2>&1) || true' EXIT
[ -f bench/dump/trading.dump ] || bench/dump/seed.sh

DUMP=trading.dump bench/reset.sh medium > "$WORK/reset.log" 2>&1 || { tail -20 "$WORK/reset.log"; exit 1; }

psql "$PG" -q -v ON_ERROR_STOP=1 -o /dev/null <<'SQL'
SELECT app.place_order(2, 'neg-1', 'h1', 'CASH_IN',  'MARKET', 66, NULL, 100000, NULL);
SELECT app.place_order(2, 'neg-2', 'h2', 'BUY',      'MARKET', 47, 10,   NULL,   NULL);
SELECT app.place_order(2, 'neg-3', 'h3', 'BUY',      'MARKET', 54, 5,    NULL,   NULL);
SELECT app.place_order(2, 'neg-4', 'h4', 'SELL',     'MARKET', 47, 3,    NULL,   NULL);
SELECT app.place_order(2, 'neg-5', 'h5', 'BUY',      'LIMIT',  31, 1,    NULL,   1.00);
SELECT app.place_order(2, 'neg-6', 'h6', 'SELL',     'LIMIT',  54, 2,    NULL,   9999.00);
SQL
echo '{"whale":[],"median":[2],"p90":[],"p99":[],"p999":[],"withNew":[]}' > "$WORK/cohorts.json"

verify() { DATABASE_ADMIN_URL="$PG" pnpm exec tsx bench/gen/verify.ts --out "$WORK" > "$WORK/verify.log" 2>&1; }

FAILED=0
if verify && grep -q "1 usuarios verificados, 0 con diferencias" "$WORK/verify.log"; then
  echo "✓ read_portfolio intacto: verify da 0 diferencias"
else
  echo "✗ read_portfolio intacto: verify no dio 0 diferencias"; sed 's/^/    /' "$WORK/verify.log"; FAILED=1
fi

psql "$PG" -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE def text := pg_get_functiondef('app.read_portfolio(int)'::regprocedure);
DECLARE bad text := replace(def, 'WHERE f.instrumentid IS NOT NULL', 'WHERE f.instrumentid IS NOT NULL AND false');
BEGIN
  IF bad = def THEN RAISE EXCEPTION 'el sabotaje no cambió read_portfolio'; END IF;
  EXECUTE bad;
END $$;
SQL
if ! verify && grep -q "falta en la DB" "$WORK/verify.log"; then
  echo "✓ read_portfolio sin posiciones: verify falla y nombra las que faltan"
else
  echo "✗ read_portfolio sin posiciones: verify no lo detectó"; sed 's/^/    /' "$WORK/verify.log"; FAILED=1
fi
exit "$FAILED"
