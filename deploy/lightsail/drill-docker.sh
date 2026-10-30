#!/usr/bin/env bash
# Ensayo de remote.sh con Docker real (D-29, issue #34), en esta máquina y sin el servidor: lo que
# test/unit/deploy-workflow.test.ts no puede ver con su `docker` simulado, que es si Docker
# Compose de verdad rechaza una API nueva que no queda sana (el healthcheck de
# deploy/lightsail/compose.yml y `up --wait`) y si el bootstrap corre contra la base real. No
# corre en el CI: se corre a mano, con Docker y su plugin compose, desde la raíz del repo.
#
#   deploy/lightsail/drill-docker.sh
#
# Arma tres imágenes desde el commit actual y las publica en un registro local (para tener
# referencias por digest, como las de GHCR):
#   good       la imagen del Dockerfile.
#   bad-boot   la misma con una migración que aborta: su bootstrap falla.
#   bad-health la misma con un proceso que responde /health con 503: su API no queda sana.
# Después, sobre un /opt/cocos temporal y el proyecto cocos-staging, exige:
#   1. good: bootstrap y switch terminan bien y /health atiende su release.
#   2. bad-boot: el bootstrap falla, y un switch de esa versión se rechaza; sigue good.
#   3. bad-health: el bootstrap pasa, el switch falla (el healthcheck), rollback vuelve a good y
#      /health atiende otra vez su release.
# Al final borra todo lo que creó (contenedores, volumen, red, registro e imágenes). Si ya hay un
# proyecto cocos-staging o un contenedor del registro, no empieza.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${DRILL_REGISTRY_PORT:-5055}"
REG="localhost:$PORT/cocos-drill"
ROOT_DIR="$(mktemp -d)"
NETWORK_CREATED=""
export COCOS_ROOT="$ROOT_DIR" COMPOSE_WAIT_TIMEOUT="${COMPOSE_WAIT_TIMEOUT:-90}"
DIR="$ROOT_DIR/staging"
SHA_GOOD="$(printf 'a%.0s' {1..40})"
SHA_BOOT="$(printf 'b%.0s' {1..40})"
SHA_HEALTH="$(printf 'c%.0s' {1..40})"

fail() { echo "ENSAYO FALLIDO: $*" >&2; exit 1; }
remote() { bash deploy/lightsail/remote.sh "$@"; }

[ -z "$(docker ps -aq --filter label=com.docker.compose.project=cocos-staging)" ] \
  || { echo "ya hay un proyecto cocos-staging en este Docker: no se ensaya encima" >&2; exit 2; }
[ -z "$(docker ps -aq --filter name='^cocos-drill-registry$')" ] \
  || { echo "ya hay un contenedor cocos-drill-registry" >&2; exit 2; }

cleanup() {
  if [ -f "$DIR/compose.yml" ] || [ -f "$DIR/compose.next.yml" ]; then
    local f="$DIR/compose.yml" e="$DIR/release.env"
    [ -f "$f" ] || { f="$DIR/compose.next.yml"; e="$DIR/release.next.env"; }
    docker compose -p cocos-staging --project-directory "$DIR" -f "$f" --env-file "$e" down -v >/dev/null 2>&1 || true
  fi
  docker rm -f cocos-drill-registry >/dev/null 2>&1 || true
  [ -z "$NETWORK_CREATED" ] || docker network rm cocos-edge >/dev/null 2>&1 || true
  docker rmi "$REG:good" "$REG:bad-boot" "$REG:bad-health" >/dev/null 2>&1 || true
  rm -rf "$ROOT_DIR"
}
trap cleanup EXIT

echo "== imágenes"
docker run -d --name cocos-drill-registry -p "$PORT:5000" registry:2 >/dev/null
docker build -q -t "$REG:good" . >/dev/null
ctx="$ROOT_DIR/build"
mkdir -p "$ctx"
cat > "$ctx/999_drill.sql" <<'SQL'
DO $$ BEGIN RAISE EXCEPTION 'ensayo: bootstrap fallido'; END $$;
SQL
docker build -q -t "$REG:bad-boot" -f - "$ctx" >/dev/null <<EOF
FROM $REG:good
COPY 999_drill.sql db/migrations/999_drill.sql
EOF
docker build -q -t "$REG:bad-health" - >/dev/null <<EOF
FROM $REG:good
CMD ["node", "-e", "require('http').createServer((q, s) => { s.statusCode = 503; s.end('{}'); }).listen(3000)"]
EOF
digest() {
  docker push -q "$REG:$1" >/dev/null
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REG:$1" | grep "^$REG@sha256:" | head -1
}
GOOD="$(digest good)"; BOOT="$(digest bad-boot)"; HEALTH="$(digest bad-health)"

echo "== servidor en $ROOT_DIR"
mkdir -p "$DIR"
pg="$(openssl rand -hex 24)"; api="$(openssl rand -hex 24)"
(
  umask 077
  printf 'POSTGRES_PASSWORD=%s\n' "$pg" > "$DIR/db.env"
  printf 'DATABASE_ADMIN_URL=postgresql://postgres:%s@db:5432/cocos\nAPI_DB_PASSWORD=%s\n' "$pg" "$api" > "$DIR/migrate.env"
  printf 'DATABASE_URL=postgresql://api:%s@db:5432/cocos\nINTERNAL_TOKEN=%s\n' "$api" "$(openssl rand -hex 24)" > "$DIR/api.env"
)
docker network inspect cocos-edge >/dev/null 2>&1 || { docker network create cocos-edge >/dev/null; NETWORK_CREATED=1; }

# /health de la API del entorno, desde la red del proxy (como la ve Caddy).
health() { docker run --rm --network cocos-edge --entrypoint wget "$GOOD" -qO- http://api-staging:3000/health 2>/dev/null || true; }
serving() {   # release esperado
  local body
  body="$(health)"
  [[ "$body" == *'"ok":true'* && "$body" == *"\"release\":\"$1\""* ]] || fail "$2: /health no atiende $1 con ok: true: ${body:-sin respuesta}"
}

echo "== 1. good: bootstrap y switch"
remote bootstrap staging "$GOOD" "$SHA_GOOD" < deploy/lightsail/compose.yml || fail "1: el bootstrap de good falló"
remote switch staging "$GOOD" "$SHA_GOOD" || fail "1: el switch de good falló"
serving "$SHA_GOOD" 1

echo "== 2. bad-boot: el bootstrap falla y el switch se rechaza"
if remote bootstrap staging "$BOOT" "$SHA_BOOT" < deploy/lightsail/compose.yml; then fail "2: el bootstrap roto terminó bien"; fi
if remote switch staging "$BOOT" "$SHA_BOOT"; then fail "2: el switch de un bootstrap fallido terminó bien"; fi
serving "$SHA_GOOD" 2

echo "== 3. bad-health: el switch falla por el healthcheck y rollback vuelve a good"
remote bootstrap staging "$HEALTH" "$SHA_HEALTH" < deploy/lightsail/compose.yml || fail "3: el bootstrap de bad-health falló"
if remote switch staging "$HEALTH" "$SHA_HEALTH"; then fail "3: el switch a una API que responde 503 terminó bien"; fi
remote rollback staging "$GOOD" "$SHA_GOOD" || fail "3: rollback falló"
serving "$SHA_GOOD" 3
[ "$(sed -n 's/^RELEASE=//p' "$DIR/release.env")" = "$SHA_GOOD" ] || fail "3: release.env no volvió a good"

echo "== ENSAYO OK: bootstrap fallido y API sin salud rechazados; atiende $SHA_GOOD"
