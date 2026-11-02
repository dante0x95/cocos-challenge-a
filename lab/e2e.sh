#!/usr/bin/env bash
# Prueba local del lab de punta a punta (issue #72), con Docker, sin la instancia: levanta
# lab/compose.yml en un proyecto propio (cocos-lab-e2e, puertos 8072 y 8473), corre lab/check.ts
# contra http://localhost:8072 y lo baja con sus volúmenes. Desde la raíz del repo:
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
