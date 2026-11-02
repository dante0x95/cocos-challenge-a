#!/usr/bin/env bash
# Fase 11/13 — Matriz de corridas. Cada corrida: contenedor fresco (dump de la variante), app,
# calentamiento, medida con k6, docker stats muestreado, pg_stat_statements top 5, EXPLAIN de la
# lectura para un mediano y una ballena. Resultados en bench/results/<perfil>-<escenario>-<rps>-<variante>.*
#
#   VARIANT=A PROFILES=medium SCENARIOS="read-heavy whale" bench/run.sh
#   VARIANT=Z PROFILES=medium SCENARIOS="read-heavy" RPS_READ_HEAVY="1 2" bench/run.sh
#
# Variables: VARIANT (A|Z), PROFILES, SCENARIOS, RPS_<ESCENARIO> (p.ej. RPS_READ_HEAVY, RPS_WHALE),
#            DURATION (5m), WARMUP (2m), STATS_EVERY (10 s), RESULTS (bench/results),
#            BENCH_PG_PORT / BENCH_APP_PORT (puertos del host), SKIP_DONE=1 (salta corridas con .json ya presente:
#            relanzar el mismo comando continúa donde quedó).
set -euo pipefail
cd "$(dirname "$0")/.."
VARIANT="${VARIANT:-A}"
PROFILES="${PROFILES:-medium}"
SCENARIOS="${SCENARIOS:-read-heavy whale}"
DURATION="${DURATION:-5m}"
WARMUP="${WARMUP:-2m}"
STATS_EVERY="${STATS_EVERY:-10}"
RESULTS="${RESULTS:-bench/results}"   # RESULTS=bench/results-local: una corrida nueva no pisa las versionadas
mkdir -p "$RESULTS"
export BENCH_RESULTS; BENCH_RESULTS="$(cd "$RESULTS" && pwd)"

WITH_C=0; WARM=0
case "$VARIANT" in
  A)          DUMP=bench.dump; APP_MODE=a;     DB_USER=api;      DB_PASS=api ;;
  Z)          DUMP=base.dump;  APP_MODE=naive; DB_USER=postgres; DB_PASS=postgres ;;
  C-frio)     DUMP=bench.dump; APP_MODE=a;     DB_USER=api;      DB_PASS=api; WITH_C=1 ;;
  C-caliente) DUMP=bench.dump; APP_MODE=a;     DB_USER=api;      DB_PASS=api; WITH_C=1; WARM=1 ;;
  *) echo "VARIANT debe ser A, Z, C-frio o C-caliente" >&2; exit 1 ;;
esac
export DUMP APP_MODE DB_USER DB_PASS WITH_C SNAPSHOT_K="${SNAPSHOT_K:-500}"

rps_for() {  # escalera por escenario, con defaults distintos por variante
  local var="RPS_$(echo "$1" | tr 'a-z-' 'A-Z_')"
  if [ -n "${!var:-}" ]; then echo "${!var}"; return; fi
  case "$VARIANT-$1" in
    A-read-heavy|A-write-heavy|C-*-read-heavy|C-*-write-heavy) echo "100 200 400" ;;
    A-whale)      echo "2 5 20" ;;
    C-*-whale)    echo "2 5 20 100" ;;
    A-same-user|C-*-same-user)  echo "10 50" ;;
    Z-read-heavy|Z-write-heavy) echo "1 2" ;;
    Z-*)          echo "1" ;;
  esac
}
port_for() { case "$1" in small) echo 5433;; medium) echo 5434;; large) echo 5435;; neon) echo 5436;; esac; }

# k6 sale con 99 cuando la corrida no cumple los umbrales (las celdas que colapsan): eso es un
# resultado. Cualquier otro código es un fallo técnico (Docker, el script, el JSON que no se pudo
# escribir) y corta la matriz. El JSON se borra antes de correr y se exige después, con iteraciones:
# nunca queda uno de una corrida anterior. Uno sin iteraciones se borra, para que SKIP_DONE=1 no tome
# la celda por hecha.
#   k6_ok <código de salida> <json> <qué corrida>
k6_ok() {
  if [ "$1" != 0 ] && [ "$1" != 99 ]; then echo "ERROR: k6 ($3) salió con $1" >&2; rm -f "$2"; return 1; fi
  if ! jq -e '(.metrics.iterations.values.count // 0) > 0' "$2" >/dev/null 2>&1; then
    echo "ERROR: k6 ($3) no dejó $2 con iteraciones" >&2; rm -f "$2"; return 1
  fi
}

for PROFILE in $PROFILES; do
  PORT=${BENCH_PG_PORT:-$(port_for "$PROFILE")}; PG="postgresql://postgres:postgres@localhost:$PORT/trading"
  export PROFILE
  for SCENARIO in $SCENARIOS; do
    for RPS in $(rps_for "$SCENARIO"); do
      NAME="$PROFILE-$SCENARIO-$RPS-$VARIANT"
      if [ "${SKIP_DONE:-0}" = "1" ] && [ -s "$RESULTS/$NAME.json" ]; then echo "(SKIP_DONE) $NAME ya existe, se salta"; continue; fi
      echo; echo "################ $NAME  ($(date +%H:%M:%S)) ################"
      # El JSON de una corrida anterior de esta celda no sobrevive a esta: si algo falla, no queda ninguno.
      rm -f "$RESULTS/$NAME.json" "$RESULTS/$NAME-warmup.json"

      T0=$(date +%s)
      bench/reset.sh "$PROFILE"
      echo "restore+vacuum: $(( $(date +%s) - T0 )) s" | tee "$RESULTS/$NAME-restore.txt"
      if [ "$WARM" = "1" ]; then bench/warm.sh "$PROFILE" | tee -a "$RESULTS/$NAME-restore.txt"; fi
      psql "$PG" -q -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" -c "SELECT pg_stat_statements_reset()" >/dev/null

      ( cd bench/docker && docker compose --profile bench up -d --build app )
      for _ in $(seq 1 60); do curl -sf "localhost:${BENCH_APP_PORT:-3000}/health" >/dev/null && break; sleep 1; done
      curl -sf "localhost:${BENCH_APP_PORT:-3000}/health" >/dev/null || { echo "ERROR: la API no respondió /health" >&2; exit 1; }

      echo "-- calentamiento $WARMUP"
      rm -f "$RESULTS/$NAME-warmup.json"
      ( cd bench/docker; s=0; docker compose --profile bench run --rm k6 run -e RPS="$RPS" -e DURATION="$WARMUP" \
          -e PROFILE="$PROFILE" -e VARIANT="$VARIANT-warmup" "/k6/$SCENARIO.js" > /dev/null 2>&1 || s=$?
        echo "$s" > "$BENCH_RESULTS/.k6-status" )
      k6_ok "$(cat "$BENCH_RESULTS/.k6-status")" "$RESULTS/$NAME-warmup.json" "calentamiento de $NAME"
      psql "$PG" -q -c "SELECT pg_stat_statements_reset()" >/dev/null

      echo "-- medida $DURATION"
      : > "$RESULTS/$NAME-stats.csv"
      ( while true; do
          docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.BlockIO}}" 2>/dev/null \
            | sed "s/^/$(date +%s),/" >> "$RESULTS/$NAME-stats.csv"
          sleep "$STATS_EVERY"
        done ) & STATS_PID=$!
      rm -f "$RESULTS/$NAME.json" "$BENCH_RESULTS/.k6-status"
      ( cd bench/docker; s=0; docker compose --profile bench run --rm k6 run -e RPS="$RPS" -e DURATION="$DURATION" \
          -e PROFILE="$PROFILE" -e VARIANT="$VARIANT" "/k6/$SCENARIO.js" || s=$?
        echo "$s" > "$BENCH_RESULTS/.k6-status" ) 2>&1 | tee "$RESULTS/$NAME-k6.txt" | grep -E "^(==|http_|dropped|iterations)" || true
      kill "$STATS_PID" 2>/dev/null || true; wait "$STATS_PID" 2>/dev/null || true
      k6_ok "$(cat "$BENCH_RESULTS/.k6-status" 2>/dev/null || echo 'sin código')" "$RESULTS/$NAME.json" "medida de $NAME"
      rm -f "$BENCH_RESULTS/.k6-status"

      psql "$PG" -At -c "SELECT round(total_exec_time::numeric)::text || ' ms total | ' || calls || ' calls | ' || round(mean_exec_time::numeric, 2)::text || ' ms mean | ' || left(regexp_replace(query, '\s+', ' ', 'g'), 110)
                          FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC LIMIT 5" > "$RESULTS/$NAME-pgss.txt" 2>&1 || true
      {
        if [ "$APP_MODE" = "a" ]; then
          echo "== mediano (36000) =="; psql "$PG" -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM app.read_portfolio(36000)"
          echo "== ballena (1004) ==";  psql "$PG" -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM app.read_portfolio(1004)"
        else
          echo "== mediano (36000) =="; psql "$PG" -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT instrumentid, SUM(CASE side WHEN 'BUY' THEN size ELSE -size END) FROM orders WHERE userid = 36000 AND status = 'FILLED' AND side IN ('BUY','SELL') GROUP BY 1"
        fi
      } > "$RESULTS/$NAME-explain.txt" 2>&1 || true
      if [ "$WITH_C" = "1" ]; then
        psql "$PG" -c "SELECT count(*) AS snapshots, max(updated_at) AS last_publish, pg_size_pretty(pg_total_relation_size('app.balance_snapshots') + pg_total_relation_size('app.snapshot_positions')) AS size FROM app.balance_snapshots" \
                  -c "SELECT n_tup_ins, n_tup_upd, n_tup_del, n_dead_tup FROM pg_stat_user_tables WHERE relname = 'snapshot_positions'" > "$RESULTS/$NAME-snapshots.txt" 2>&1 || true
      fi
      echo "-- top pg_stat_statements:"; head -3 "$RESULTS/$NAME-pgss.txt"
      echo "corrida completa: $(( $(date +%s) - T0 )) s"
    done
  done
done
( cd bench/docker && docker compose --profile bench down -v --remove-orphans ) || true
echo; echo "listo: pnpm exec tsx bench/summarize.ts --variant $VARIANT"
