#!/usr/bin/env bash
# Control de bench/run.sh (issue #70): una celda solo termina "completa" con una medición nueva.
# Corre run.sh de verdad con docker, psql y curl simulados en el PATH (sin Docker ni Postgres) y un
# k6 simulado que, en la medida (STUB_K6) o en el calentamiento (STUB_K6_WARMUP), termina como se le
# pida. En cada caso hay un JSON de una corrida anterior en RESULTS:
#   ok                   sale con 0 y escribe el JSON           → run.sh termina bien, con el JSON nuevo
#   umbrales             sale con 99 (no cumplió los umbrales)  → ídem: es un resultado
#   falla                escribe el JSON y sale con 1           → run.sh falla y no deja el JSON
#   sin-json             sale con 0 sin escribir el JSON        → ídem
#   cero                 sale con 99 y un JSON de 0 iteraciones → ídem: no hubo medición
#   falla-calentamiento  el calentamiento escribe y sale con 1  → ídem, sin medir ni dejar el suyo
#   sin-health           la API nunca responde /health          → ídem, sin correr k6
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
MODE="${STUB_K6:-ok}"; case "$VARIANT" in *-warmup) MODE="${STUB_K6_WARMUP:-ok}" ;; esac
echo "== $PROFILE / $SCENARIO / $RPS rps / $VARIANT (k6 simulado: $MODE) =="
case "$MODE" in
  ok)       echo '{"metrics":{"iterations":{"values":{"count":10}}}}' > "$FILE" ;;
  umbrales) echo '{"metrics":{"iterations":{"values":{"count":10}}}}' > "$FILE"; exit 99 ;;
  falla)    echo '{"metrics":{"iterations":{"values":{"count":10}}}}' > "$FILE"; exit 1 ;;
  sin-json) exit 0 ;;
  cero)     echo '{"metrics":{"iterations":{"values":{"count":0}}}}' > "$FILE"; exit 99 ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/psql"
printf '#!/usr/bin/env bash\n[ "${STUB_CURL:-ok}" = ok ]\n' > "$WORK/bin/curl"
chmod +x "$WORK/bin/"*

FAILED=0
# caso <nombre> <exit esperado: 0 | no-0> [VAR=valor…]
caso() {
  local mode="$1" want="$2" out="$WORK/results-$1" json status=0; shift 2
  mkdir -p "$out"; json="$out/medium-whale-2-A.json"
  # Un JSON de una corrida anterior: no puede sobrevivir a una celda fallida.
  echo '{"metrics":{"iterations":{"values":{"count":999}}}}' > "$json"
  env PATH="$WORK/bin:$PATH" "$@" VARIANT=A SCENARIOS=whale RPS_WHALE=2 DURATION=1s WARMUP=1s \
    STATS_EVERY=1 RESULTS="$out" bench/run.sh > "$WORK/log-$mode" 2>&1 || status=$?
  local ok=1
  if [ "$want" = 0 ]; then
    [ "$status" = 0 ] && grep -q "corrida completa" "$WORK/log-$mode" \
      && jq -e '.metrics.iterations.values.count == 10' "$json" >/dev/null || ok=0
  else
    # Sin el JSON de la medida (el que SKIP_DONE=1 tomaría por hecho) y, si falló el calentamiento,
    # sin el suyo.
    [ "$status" != 0 ] && ! grep -q "corrida completa" "$WORK/log-$mode" && [ ! -e "$json" ] \
      && { [ "$mode" != falla-calentamiento ] || [ ! -e "$out/medium-whale-2-A-warmup.json" ]; } || ok=0
  fi
  if [ "$ok" = 1 ]; then echo "✓ $mode: run.sh salió con $status"
  else echo "✗ $mode: run.sh salió con $status"; sed 's/^/    /' "$WORK/log-$mode" | tail -5; FAILED=1; fi
}
caso ok 0 STUB_K6=ok
caso umbrales 0 STUB_K6=umbrales
caso falla no-0 STUB_K6=falla
caso sin-json no-0 STUB_K6=sin-json
caso cero no-0 STUB_K6=cero
caso falla-calentamiento no-0 STUB_K6_WARMUP=falla
caso sin-health no-0 STUB_CURL=falla
exit "$FAILED"
