#!/usr/bin/env bash
# Ensayos del deploy en Fly.io (D-29; issue #12, puntos 5, 6 y 7 del plan de pruebas). Dependen
# de Fly y de GitHub, así que NO corren en el CI: se corren a mano, con flyctl y gh
# autenticados y la API ya desplegada desde main.
#
#   deploy/fly/drills.sh             # los tres
#   deploy/fly/drills.sh bootstrap   # 5: release cuyo bootstrap falla
#   deploy/fly/drills.sh health      # 6: release cuyo /health no responde 2xx
#   deploy/fly/drills.sh rerun       # 7: reejecutar el ci de un commit viejo no despliega
#
# bootstrap y health despliegan a propósito una versión rota, armada en una copia temporal del
# commit actual, y exigen que el deploy falle por la falla inyectada (no por un error de
# autenticación, configuración o build) y que siga atendiendo el release anterior con ok: true.
# rerun reejecuta con gh el ci de un commit de main anterior al desplegado y exige que el
# workflow de deploy que eso dispara se frene en el gate, sin cambiar lo que atiende.
#
# No hay nada que restaurar: un deploy fallido no cambia las máquinas que atienden, y el
# bootstrap que falla no deja nada aplicado en la base (una transacción, D-24). El próximo
# merge a main despliega normalmente.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="$(sed -n 's/^app = "\(.*\)"$/\1/p' fly.toml)"
URL="https://$APP.fly.dev"

fail() { echo "ENSAYO FALLIDO: $*" >&2; exit 1; }
health() { curl -sS "$URL/health"; }
serving() {   # el release que atiende con ok: true, o falla
  local r
  r="$(health | jq -r 'select(.ok == true) | .release // empty')"
  [ -n "$r" ] || fail "$1: /health no responde ok con un release: $(health)"
  echo "$r"
}
still_serving() {   # nombre, release esperado
  local after
  after="$(health)"
  echo "$after"
  jq -e --arg r "$2" '.ok == true and .release == $r' <<<"$after" >/dev/null \
    || fail "$1: después del ensayo no atiende $2 con ok: true"
}

# Antes de romper nada: autenticado y con la app accesible. Un error acá no es un ensayo aprobado.
need_fly() {
  fly auth whoami >/dev/null || fail "flyctl no está autenticado (fly auth login)"
  fly status --app "$APP" >/dev/null || fail "no se puede leer la app $APP"
}
need_gh() { gh auth status >/dev/null 2>&1 || fail "gh no está autenticado (gh auth login)"; }

drill() {   # nombre, función que rompe la copia, función que reconoce la falla inyectada
  local name="$1" breakit="$2" reason="$3" before dir out
  need_fly
  before="$(serving "$name")"
  echo "== $name: atiende $before"

  dir="$(mktemp -d)"
  out="$dir.log"
  git archive HEAD | tar -x -C "$dir"
  "$breakit" "$dir"
  if (cd "$dir" && fly deploy --config fly.toml --remote-only --env "RELEASE=drill-$name") 2>&1 | tee "$out"; then
    rm -rf "$dir" "$out"
    fail "$name: el deploy roto terminó bien"
  fi
  rm -rf "$dir"
  # Falló, pero tiene que ser por lo que se rompió: la imagen se construyó y el deploy llegó a
  # la fase que se ensaya.
  "$reason" "$out" || fail "$name: el deploy falló por otro motivo (ver $out)"
  rm -f "$out"

  still_serving "$name" "$before"
  echo "== $name: OK, el deploy falló y sigue atendiendo $before"
}

# Punto 5. Una migración nueva que aborta. Si release_command no corriera el bootstrap, el
# deploy terminaría bien y atendería drill-bootstrap.
break_bootstrap() {
  printf '%s\n' "DO \$\$ BEGIN RAISE EXCEPTION 'ensayo: bootstrap fallido'; END \$\$;" \
    > "$1/db/migrations/999_drill_bootstrap.sql"
}
# Falló el release_command con la excepción de la migración: en la salida del deploy o en los
# logs de la máquina del release.
bootstrap_failed() {
  grep -qi 'release.command' "$1" || return 1
  { cat "$1"; fly logs --app "$APP" --no-tail 2>/dev/null; } | grep -q 'ensayo: bootstrap fallido'
}

# Punto 6. La versión nueva arranca y la base sigue sana, pero /health responde 503. Con
# strategy = "immediate" en vez de "bluegreen", atendería drill-health.
break_health() {
  local f="$1/src/routes/internal.routes.ts"
  sed -i.orig "s/res\.json({ ok: true, db: 'up',/res.status(503).json({ ok: false, db: 'up',/" "$f"
  cmp -s "$f" "$f.orig" && fail "health: no se encontró la respuesta de /health para romperla"
  rm "$f.orig"
}
# El bootstrap pasó y las máquinas nuevas no pasaron el check de salud.
health_failed() {
  ! grep -qi 'release.command failed' "$1" && grep -Eqi 'health ?check' "$1"
}

# Punto 7. Reejecutar el ci de un commit de main anterior al desplegado dispara el workflow de
# deploy; el gate (release-check.sh before) lo frena y /health sigue igual. Sin el gate, ese
# commit viejo se desplegaría encima del actual.
drill_rerun() {
  local before old id started run conclusion i
  need_gh
  before="$(serving rerun)"
  echo "== rerun: atiende $before"
  git fetch -q origin main
  git cat-file -e "$before^{commit}" 2>/dev/null || fail "rerun: el release $before no está en la historia de origin/main"

  # Un commit de main anterior al desplegado, con un ci en verde que se pueda reejecutar.
  old=""
  while read -r rid sha; do
    if [ "$sha" != "$before" ] && git merge-base --is-ancestor "$sha" "$before"; then
      id="$rid"; old="$sha"; break
    fi
  done < <(gh run list --workflow ci --branch main --event push --status success --json databaseId,headSha --limit 50 \
             | jq -r '.[] | "\(.databaseId) \(.headSha)"')
  [ -n "$old" ] || fail "rerun: no hay un ci en verde de un commit anterior a $before para reejecutar"
  echo "== rerun: reejecuta el ci $id del commit $old"

  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gh run rerun "$id"
  # El deploy que dispara esa corrida: el primero del workflow creado después de ahora. (Su
  # headSha no sirve para reconocerlo: en un workflow_run es el último commit de main.)
  run=""
  for ((i = 1; i <= 120; i++)); do
    run="$(gh run list --workflow deploy --event workflow_run --json databaseId,createdAt --limit 5 \
             | jq -r --arg t "$started" '[.[] | select(.createdAt >= $t)] | last // empty | .databaseId')"
    [ -n "$run" ] && break
    sleep 10
  done
  [ -n "$run" ] || fail "rerun: el ci reejecutado no disparó el workflow de deploy en 20 minutos"
  echo "== rerun: espera el deploy $run"
  gh run watch "$run" --exit-status >/dev/null && fail "rerun: el deploy del commit viejo terminó bien"
  conclusion="$(gh run view "$run" --json conclusion --jq .conclusion)"
  [ "$conclusion" = "failure" ] || fail "rerun: el deploy terminó en $conclusion, no en failure"
  gh run view "$run" --log 2>/dev/null | grep -q 'no desciende del release actual' \
    || fail "rerun: el deploy $run falló por otro motivo (gh run view $run --log)"

  still_serving rerun "$before"
  echo "== rerun: OK, el deploy del commit viejo se frenó en el gate y sigue atendiendo $before"
}

case "${1:-all}" in
  bootstrap) drill bootstrap break_bootstrap bootstrap_failed ;;
  health)    drill health break_health health_failed ;;
  rerun)     drill_rerun ;;
  all)       drill bootstrap break_bootstrap bootstrap_failed; drill health break_health health_failed; drill_rerun ;;
  *)         echo "uso: $0 [bootstrap|health|rerun]" >&2; exit 2 ;;
esac
