#!/usr/bin/env bash
# Prueba local del lab de punta a punta (issue #72), con Docker, sin la instancia: levanta
# lab/compose.yml en un proyecto propio (cocos-lab-e2e, puertos 8072 y 8473), corre lab/check.ts
# contra http://localhost:8072, lo vuelve a levantar sin borrar las bases (como un redeploy: nada se
# recarga y C sigue siendo C) y corre check.ts otra vez, y lo baja con sus volúmenes. Desde la raíz
# del repo:
#
#   LAB_GENERATOR=<ruta a bench/gen/generate.ts> lab/e2e.sh
#
# La imagen de A: LAB_A_IMAGE si se pasa (por ejemplo la de GHCR ya bajada); si no, se construye
# con el Dockerfile del tag LAB_A_VERSION (v0.2.0), como la construyó su release, con el nombre
# cocos-lab-a:<versión>. KEEP=1 deja el lab levantado para mirarlo (se baja con
# `docker compose -p cocos-lab-e2e down -v`, desde lab/).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${LAB_A_VERSION:-v0.2.0}"
export LAB_PROJECT=cocos-lab-e2e LAB_HTTP_PORT=8072 LAB_HTTPS_PORT=8473 LAB_SITE=:80
export LAB_DATA_DIR="$PWD/lab/.data"
if [ -z "${LAB_A_IMAGE:-}" ]; then
  export LAB_A_IMAGE="cocos-lab-a:${VERSION}"
  echo "== imagen de A desde el tag ${VERSION}"
  git archive "$VERSION" | docker build -q -t "$LAB_A_IMAGE" -
fi

lab/data/generate.sh "$LAB_DATA_DIR"

compose() { docker compose -p "$LAB_PROJECT" --project-directory lab -f lab/compose.yml "$@"; }
cleanup() {
  [ "${KEEP:-}" = 1 ] && { echo "KEEP=1: el lab sigue en http://localhost:${LAB_HTTP_PORT}"; return; }
  compose down -v --remove-orphans >/dev/null 2>&1 || echo "no se pudo bajar ${LAB_PROJECT}: docker compose -p ${LAB_PROJECT} down -v" >&2
}
trap cleanup EXIT

echo "== levantar ${LAB_PROJECT}"
compose down -v --remove-orphans >/dev/null 2>&1
T0=$(date +%s)
compose up -d --build --remove-orphans || { compose logs --tail 40 load-z load-a load-c migrate-a migrate-c; exit 1; }
echo "arriba en $(( $(date +%s) - T0 )) s"
compose logs load-z load-a load-c | grep '\[load-'

node_modules/.bin/tsx lab/check.ts "http://localhost:${LAB_HTTP_PORT}" "$LAB_DATA_DIR"

# Un segundo arranque sin borrar las bases, como un redeploy: ninguna se recarga, el bootstrap
# reinstala las funciones de A y la carga de C vuelve a poner las suyas, y todo sigue igual.
echo "== segundo arranque, con las bases"
compose up -d --remove-orphans || { compose logs --tail 40 load-z load-a load-c migrate-a migrate-c; exit 1; }
for v in z a c; do
  [ "$(compose logs "load-$v" | grep -c 'ya cargado')" = 1 ] || { echo "load-$v: el segundo arranque no encontró el dataset cargado" >&2; exit 1; }
done
[ "$(compose exec -T db-c psql -U postgres -d cocos -Atc "SELECT position('balance_snapshots' IN prosrc) > 0 FROM pg_proc WHERE oid = 'app.c_state(int)'::regprocedure")" = t ] \
  || { echo "db-c: app.c_state no es el de C después del segundo arranque" >&2; exit 1; }
compose exec -T db-a psql -U postgres -d cocos -Atc "SELECT count(*) FROM app.orders WHERE userid >= 1000" | grep -qx "$(sed -n 's/.*"orders": *\([0-9][0-9]*\).*/\1/p' "$LAB_DATA_DIR/manifest.json")" \
  || { echo "db-a: la cantidad de órdenes del dataset cambió en el segundo arranque" >&2; exit 1; }
node_modules/.bin/tsx lab/check.ts "http://localhost:${LAB_HTTP_PORT}" "$LAB_DATA_DIR"
