#!/usr/bin/env bash
# Control de bench/run.sh (issue #70): una celda solo termina "completa" con una medición nueva.
# Corre run.sh de verdad con docker, psql y curl simulados en el PATH (sin Docker ni Postgres) y un
# k6 simulado que, en la medida, termina como se le pida:
#   ok          sale con 0 y escribe el JSON              → run.sh termina bien
#   umbrales    sale con 99 (no cumplió los umbrales)     → run.sh termina bien: es un resultado
#   falla       sale con 1 sin JSON, con uno viejo en RESULTS → run.sh falla y borra el viejo
#   sin-json    sale con 0 sin escribir el JSON          → run.sh falla
#   cero        sale con 99 y un JSON con 0 iteraciones  → run.sh falla y lo borra: no hubo medición
# No corre en el CI. Uso: bench/test/run-guard.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Solo `compose ... run --rm k6 run ...` hace algo: escribe el JSON como lo haría handleSummary.
[ "${1:-}" = "compose" ] || exit 0
case " $* " in *" k6 run "*) ;; *) exit 0 ;; esac
for a in "$@"; do
  case "$a" in RPS=*|PROFILE=*|VARIANT=*) declare "$a" ;; /k6/*.js) SCENARIO="$(basename "$a" .js)" ;; esac
done
FILE="$BENCH_RESULTS/$PROFILE-$SCENARIO-$RPS-$VARIANT.json"
MODE="${STUB_K6:-ok}"; case "$VARIANT" in *-warmup) MODE=ok ;; esac
echo "== $PROFILE / $SCENARIO / $RPS rps / $VARIANT (k6 simulado: $MODE) =="
case "$MODE" in
  ok)       echo '{"metrics":{"iterations":{"values":{"count":10}}}}' > "$FILE" ;;
  umbrales) echo '{"metrics":{"iterations":{"values":{"count":10}}}}' > "$FILE"; exit 99 ;;
  falla)    exit 1 ;;
  sin-json) exit 0 ;;
  cero)     echo '{"metrics":{"iterations":{"values":{"count":0}}}}' > "$FILE"; exit 99 ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/psql"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/curl"
chmod +x "$WORK/bin/"*

FAILED=0
# caso <modo> <exit esperado: 0 | no-0>
caso() {
  local mode="$1" want="$2" out="$WORK/results-$1" json status=0
  mkdir -p "$out"; json="$out/medium-whale-2-A.json"
  # Un JSON de una corrida anterior: no puede sobrevivir a una medida fallida.
  echo '{"metrics":{"iterations":{"values":{"count":999}}}}' > "$json"
  PATH="$WORK/bin:$PATH" STUB_K6="$mode" VARIANT=A SCENARIOS=whale RPS_WHALE=2 DURATION=1s WARMUP=1s \
    STATS_EVERY=1 RESULTS="$out" bench/run.sh > "$WORK/log-$mode" 2>&1 || status=$?
  local ok=1
  if [ "$want" = 0 ]; then
    [ "$status" = 0 ] && grep -q "corrida completa" "$WORK/log-$mode" \
      && jq -e '.metrics.iterations.values.count == 10' "$json" >/dev/null || ok=0
  else
    [ "$status" != 0 ] && ! grep -q "corrida completa" "$WORK/log-$mode" && [ ! -e "$json" ] || ok=0
  fi
  if [ "$ok" = 1 ]; then echo "✓ $mode: run.sh salió con $status"
  else echo "✗ $mode: run.sh salió con $status"; sed 's/^/    /' "$WORK/log-$mode" | tail -5; FAILED=1; fi
}
caso ok 0
caso umbrales 0
caso falla no-0
caso sin-json no-0
caso cero no-0
exit "$FAILED"
