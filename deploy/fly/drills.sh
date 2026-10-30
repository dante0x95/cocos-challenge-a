#!/usr/bin/env bash
# Ensayos del deploy en Fly.io (D-29; issue #12, puntos 4 a 7 del plan de pruebas y el volumen
# de Postgres; issue #30, deploy por release). Dependen de Fly y de GitHub, así que NO corren en
# el CI: se corren a mano, con flyctl y gh autenticados y la API ya desplegada.
#
#   deploy/fly/drills.sh                 # release, bootstrap, health y rerun
#   deploy/fly/drills.sh release [tag]   # 4: el release (por defecto, el último publicado) pasó
#                                        #    por el workflow de deploy y /health lo atiende
#   deploy/fly/drills.sh bootstrap       # 5: release cuyo bootstrap falla
#   deploy/fly/drills.sh health          # 6: release cuyo /health no responde 2xx
#   deploy/fly/drills.sh rerun           # 7: reejecutar el deploy de un release viejo no despliega
#   deploy/fly/drills.sh persistence     # los datos de Postgres sobreviven a redesplegar su
#                                        #    máquina (corta la API mientras la base reinicia)
#
# bootstrap y health despliegan a propósito una versión rota, armada en una copia temporal del
# commit actual, y exigen que el deploy falle por la falla inyectada (no por un error de
# autenticación, configuración o build) y que siga atendiendo el release anterior con ok: true.
# rerun reejecuta con gh el workflow de deploy de un release anterior al desplegado y exige que
# se frene en el gate de ancestría, sin cambiar lo que atiende.
#
# No hay nada que restaurar: un deploy fallido no cambia las máquinas que atienden, y el
# bootstrap que falla no deja nada aplicado en la base (una transacción, D-24). El próximo
# release despliega normalmente.
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

# Punto 7. Reejecutar el workflow de deploy de un release anterior al desplegado: el gate de
# ancestría (release-check.sh before) lo frena y /health sigue igual. Sin el gate, ese release
# viejo se desplegaría encima del actual.
drill_rerun() {
  local before old id attempt i conclusion
  need_gh
  before="$(serving rerun)"
  echo "== rerun: atiende $before"
  git fetch -q origin main
  git cat-file -e "$before^{commit}" 2>/dev/null || fail "rerun: el release $before no está en la historia de origin/main"

  # Un deploy terminado de un release anterior al desplegado (en un evento release, headSha es
  # el commit del tag).
  old=""
  while read -r rid sha; do
    if [ "$sha" != "$before" ] && git merge-base --is-ancestor "$sha" "$before"; then
      id="$rid"; old="$sha"; break
    fi
  done < <(gh run list --workflow deploy --event release --status completed --json databaseId,headSha --limit 50 \
             | jq -r '.[] | "\(.databaseId) \(.headSha)"')
  [ -n "$old" ] || fail "rerun: no hay un deploy terminado de un release anterior a $before para reejecutar"
  echo "== rerun: reejecuta el deploy $id del commit $old"

  # Un re-run es otro intento de la misma corrida: espera a que empiece antes de mirarla.
  attempt="$(gh run view "$id" --json attempt --jq .attempt)"
  gh run rerun "$id"
  for ((i = 1; i <= 60; i++)); do
    [ "$(gh run view "$id" --json attempt --jq .attempt)" -gt "$attempt" ] && break
    sleep 5
  done
  gh run watch "$id" --exit-status >/dev/null && fail "rerun: el deploy del release viejo terminó bien"
  conclusion="$(gh run view "$id" --json conclusion --jq .conclusion)"
  [ "$conclusion" = "failure" ] || fail "rerun: el deploy terminó en $conclusion, no en failure"
  gh run view "$id" --log 2>/dev/null | grep -q 'no desciende del release actual' \
    || fail "rerun: el deploy $id falló por otro motivo (gh run view $id --log)"

  still_serving rerun "$before"
  echo "== rerun: OK, el deploy del release viejo se frenó en el gate y sigue atendiendo $before"
}

# Punto 4. Un release publicado recorre todo el camino: el workflow de deploy que dispara, en
# verde (el gate del release, staging y, con la aprobación, producción, con el gate de ancestría
# y el check de /health sobre su commit), y /health de producción atendiéndolo desde afuera. Se
# corre después de publicar el release (espera la corrida, también la aprobación de producción).
drill_release() {
  local tag sha deploy i
  need_gh
  tag="${1:-$(gh release view --json tagName --jq .tagName)}"
  git fetch -q --tags origin
  sha="$(git rev-parse -q --verify "refs/tags/$tag^{commit}")" || fail "release: no está el tag $tag"
  echo "== release: $tag ($sha)"

  deploy=""
  for ((i = 1; i <= 30; i++)); do
    deploy="$(gh run list --workflow deploy --event release --commit "$sha" --json databaseId --limit 1 --jq '.[0].databaseId // empty')"
    [ -n "$deploy" ] && break
    sleep 10
  done
  [ -n "$deploy" ] || fail "release: $tag no disparó el workflow de deploy en 5 minutos"
  echo "== release: deploy $deploy"
  gh run watch "$deploy" --exit-status >/dev/null || fail "release: el deploy $deploy no terminó en verde (gh run view $deploy --log)"
  gh run view "$deploy" --log 2>/dev/null | grep -q "atiende $sha con ok: true" \
    || fail "release: el deploy $deploy no verificó /health sobre $sha (gh run view $deploy --log)"

  still_serving release "$sha"
  echo "== release: OK, $tag pasó por el deploy $deploy y /health atiende $sha"
}

# Postgres 18 con volumen (D-29). El directorio de datos efectivo está dentro del montaje de
# deploy/fly/db.toml, y un dato escrito antes de redesplegar la máquina de la base (otra imagen
# o configuración la reemplaza igual) sigue después. Mientras la base reinicia, la API responde
# 503; al final tiene que volver a atender el mismo release con ok: true.
drill_persistence() {
  local db mount dir token before n i
  need_fly
  db="$(sed -n 's/^app = "\(.*\)"$/\1/p' deploy/fly/db.toml)"
  mount="$(sed -n 's/^ *destination = "\(.*\)"$/\1/p' deploy/fly/db.toml)"
  [ -n "$db" ] && [ -n "$mount" ] || fail "persistence: no se pudo leer app y destination de deploy/fly/db.toml"
  sql() { fly ssh console --app "$db" -C "psql -U postgres -d cocos -Atc '$1'" 2>/dev/null | tr -d '\r'; }
  before="$(serving persistence)"

  dir="$(sql 'SHOW data_directory')"
  case "$dir" in
    "$mount"/*) echo "== persistence: datos en $dir, dentro del volumen ($mount)" ;;
    *) fail "persistence: el directorio de datos ($dir) no está dentro del volumen ($mount)" ;;
  esac

  token="$(date +%s)"
  sql "CREATE TABLE IF NOT EXISTS public.drill_persistence (token bigint); INSERT INTO public.drill_persistence VALUES ($token)" >/dev/null
  [ "$(sql "SELECT count(*) FROM public.drill_persistence WHERE token = $token")" = "1" ] \
    || fail "persistence: no se pudo escribir el dato de prueba"
  echo "== persistence: escrito $token; redespliega $db"
  fly deploy --config deploy/fly/db.toml --app "$db" --ha=false || fail "persistence: falló el redeploy de $db"

  n=""
  for ((i = 1; i <= 30; i++)); do
    n="$(sql "SELECT count(*) FROM public.drill_persistence WHERE token = $token" || true)"
    [ -n "$n" ] && break
    sleep 5
  done
  [ "$n" = "1" ] || fail "persistence: después del redeploy el dato $token no está (count: ${n:-sin respuesta})"
  sql 'DROP TABLE public.drill_persistence' >/dev/null

  for ((i = 1; i <= 30; i++)); do
    health | jq -e '.ok == true' >/dev/null 2>&1 && break
    sleep 5
  done
  still_serving persistence "$before"
  echo "== persistence: OK, el dato sobrevivió al redeploy de la base y la API atiende $before"
}

case "${1:-all}" in
  release)     drill_release "${2:-}" ;;
  bootstrap)   drill bootstrap break_bootstrap bootstrap_failed ;;
  health)      drill health break_health health_failed ;;
  rerun)       drill_rerun ;;
  persistence) drill_persistence ;;
  all)         drill_release; drill bootstrap break_bootstrap bootstrap_failed; drill health break_health health_failed; drill_rerun ;;
  *)           echo "uso: $0 [release [tag]|bootstrap|health|rerun|persistence]" >&2; exit 2 ;;
esac
