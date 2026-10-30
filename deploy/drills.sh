#!/usr/bin/env bash
# Ensayos del deploy (D-29; issues #30 y #34) contra GitHub y el servidor de Lightsail, así que
# NO corren en el CI: se corren a mano, con gh autenticado y la API ya desplegada. URL es el
# entorno que se mira (por defecto, producción).
#
#   deploy/drills.sh                 # release y rerun
#   deploy/drills.sh release [tag]   # el release (por defecto, el último publicado) pasó por el
#                                    # workflow de deploy y /health lo atiende
#   deploy/drills.sh rerun           # reejecutar el deploy de un release viejo no despliega
#
# rerun reejecuta con gh el workflow de deploy de un release anterior al desplegado y exige que
# se frene en el gate de ancestría, sin cambiar lo que atiende.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${URL:-https://18-227-203-30.sslip.io}"

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

need_gh() { gh auth status >/dev/null 2>&1 || fail "gh no está autenticado (gh auth login)"; }

# Reejecutar el workflow de deploy de un release anterior al desplegado: el gate de
# ancestría (release-check.sh before) lo frena y /health sigue igual. Sin el gate, ese release
# viejo se desplegaría encima del actual.
drill_rerun() {
  local before old id attempt next now i conclusion log
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

  # Un re-run es otro intento de la misma corrida: el resultado y el log que valen son los de
  # ese intento, no los del anterior (que pudo haber fallado igual). Si no empieza, falla.
  attempt="$(gh run view "$id" --json attempt --jq .attempt)"
  gh run rerun "$id"
  next=""
  for ((i = 1; i <= 60; i++)); do
    now="$(gh run view "$id" --json attempt --jq .attempt)"
    if [ "$now" -gt "$attempt" ] 2>/dev/null; then next="$now"; break; fi
    sleep 5
  done
  [ -n "$next" ] || fail "rerun: el intento nuevo del deploy $id no empezó en 5 minutos (sigue en el $attempt)"
  echo "== rerun: espera el intento $next del deploy $id"
  gh run watch "$id" --exit-status >/dev/null && fail "rerun: el deploy del release viejo terminó bien"
  conclusion="$(gh run view "$id" --attempt "$next" --json conclusion --jq .conclusion)"
  [ "$conclusion" = "failure" ] || fail "rerun: el intento $next terminó en $conclusion, no en failure"
  log="$(gh run view "$id" --attempt "$next" --log 2>/dev/null)" || true
  grep -q 'no desciende del release actual' <<<"$log" \
    || fail "rerun: el intento $next del deploy $id falló por otro motivo (gh run view $id --attempt $next --log)"

  still_serving rerun "$before"
  echo "== rerun: OK, el deploy del release viejo se frenó en el gate y sigue atendiendo $before"
}

# Un release publicado recorre todo el camino: el workflow de deploy que dispara, en verde (el
# gate del release, staging y producción, con el gate de ancestría y el check de /health sobre
# su commit), y /health atendiéndolo desde afuera. Se corre después de publicar el release
# (espera la corrida).
drill_release() {
  local tag sha deploy i log
  need_gh
  tag="${1:-$(gh release view --json tagName --jq .tagName)}"
  git fetch -q --tags origin
  sha="$(git rev-parse -q --verify "refs/tags/$tag^{commit}")" || fail "release: no está el tag $tag"
  echo "== release: $tag ($sha)"

  # La corrida de este tag, no solo de este commit: otro tag sobre el mismo commit tiene la suya.
  # En un evento release, headBranch es el tag y headSha su commit; además, el gate del release
  # nombra el tag en el log.
  deploy=""
  for ((i = 1; i <= 30; i++)); do
    deploy="$(gh run list --workflow deploy --event release --branch "$tag" --commit "$sha" --json databaseId --limit 1 --jq '.[0].databaseId // empty')"
    [ -n "$deploy" ] && break
    sleep 10
  done
  [ -n "$deploy" ] || fail "release: $tag no disparó el workflow de deploy en 5 minutos"
  echo "== release: deploy $deploy"
  gh run watch "$deploy" --exit-status >/dev/null || fail "release: el deploy $deploy no terminó en verde (gh run view $deploy --log)"
  log="$(gh run view "$deploy" --log 2>/dev/null)" || true
  grep -qF "== $tag ($sha): vX.Y.Z, en main y con ci en verde" <<<"$log" \
    || fail "release: el deploy $deploy no es el de $tag: su gate no lo nombra (gh run view $deploy --log)"
  grep -qF "atiende $sha con ok: true" <<<"$log" \
    || fail "release: el deploy $deploy no verificó /health sobre $sha (gh run view $deploy --log)"

  still_serving release "$sha"
  echo "== release: OK, $tag pasó por el deploy $deploy y /health atiende $sha"
}

case "${1:-all}" in
  release) drill_release "${2:-}" ;;
  rerun)   drill_rerun ;;
  all)     drill_release; drill_rerun ;;
  *)       echo "uso: $0 [release [tag]|rerun]" >&2; exit 2 ;;
esac
