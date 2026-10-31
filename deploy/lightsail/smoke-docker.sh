#!/usr/bin/env bash
# El smoke funcional (deploy/smoke.mjs, D-29, issue #51) contra una imagen levantada como en el
# deploy: Docker Compose con deploy/lightsail/compose.yml, Postgres 18 y el bootstrap, por los
# mismos pasos de deploy/lightsail/remote.sh (bootstrap, smoke-user, switch) sobre un /opt/cocos
# temporal. Lo corre el CI (.github/workflows/ci.yml) con la imagen recién construida; también se
# puede correr a mano, con Docker y su plugin compose, desde la raíz del repo:
#
#   deploy/lightsail/smoke-docker.sh <imagen local>        (por ejemplo cocos:ci)
#
# Publica la imagen en un registro local para tener una referencia por digest (como las de GHCR),
# despliega el entorno staging con el commit actual (HEAD) como release, y exige:
#   1. bootstrap, el usuario del smoke y switch terminan bien: una imagen cuya API no arranca, o
#      no queda sana, frena acá (el healthcheck de compose.yml y `up --wait`).
#   2. deploy/smoke.mjs write pasa dos veces seguidas con el usuario que da smoke-user.sql, el
#      mismo las dos veces: el flujo deja al usuario en cero y se puede repetir.
#   3. deploy/smoke.mjs read pasa.
# El smoke corre dentro de la imagen (tiene Node), en la red interna del proyecto, contra
# http://api:3000: no publica ningún puerto salvo el del registro.
#
# Usa su propio proyecto (SMOKE_PROJECT, por defecto cocos-smoke: el proyecto es
# cocos-smoke-staging) y su registro (cocos-smoke-registry, en SMOKE_REGISTRY_PORT, 5056), así
# que no choca con docker compose (cocos), con el ensayo (drill-docker.sh) ni con un cocos-staging
# local. Si ya hay algo de ese proyecto o ese registro, no empieza ni crea nada: al terminar borra
# todo lo que creó (contenedores, volumen, red, registro e imágenes), y `down -v` borraría un
# volumen que no fuera suyo. La red cocos-edge de compose.yml es externa: si no existe la crea y
# al final la borra.
set -euo pipefail
cd "$(dirname "$0")/../.."

LOCAL_IMAGE="${1:-}"
[ -n "$LOCAL_IMAGE" ] || { echo "uso: $0 <imagen local>" >&2; exit 2; }
PREFIX="${SMOKE_PROJECT:-cocos-smoke}"
PROJECT="$PREFIX-staging"
REGISTRY="$PREFIX-registry"
PORT="${SMOKE_REGISTRY_PORT:-5056}"
REG="localhost:$PORT/$PREFIX"
SHA="$(git rev-parse HEAD)"

fail() { echo "SMOKE CON DOCKER FALLIDO: $*" >&2; exit 1; }
remote() { bash deploy/lightsail/remote.sh "$@"; }

refuse() { echo "NO SE CORRE: $*" >&2; exit 2; }
absent() {   # descripción, comando de docker que lista; vacío = no hay
  local what="$1" out; shift
  out="$("$@")" || refuse "no se pudo consultar Docker ($*)"
  [ -z "$out" ] || refuse "ya hay $what en este Docker ($(tr '\n' ' ' <<<"$out")): no se corre encima"
}
docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1 || refuse "no está la imagen $LOCAL_IMAGE (docker build -t $LOCAL_IMAGE .)"
absent "contenedores del proyecto $PROJECT" docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"
absent "volúmenes del proyecto $PROJECT" docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"
absent "volúmenes ${PROJECT}_*" docker volume ls -q --filter "name=${PROJECT}_"
absent "un contenedor $REGISTRY" docker ps -aq --filter "name=^$REGISTRY\$"

ROOT_DIR="$(mktemp -d)"
NETWORK_CREATED=""
export COCOS_ROOT="$ROOT_DIR" COCOS_PROJECT="$PREFIX" COMPOSE_WAIT_TIMEOUT="${COMPOSE_WAIT_TIMEOUT:-90}"
DIR="$ROOT_DIR/staging"

cleanup() {
  if [ -f "$DIR/compose.yml" ] || [ -f "$DIR/compose.next.yml" ]; then
    local f="$DIR/compose.yml" e="$DIR/release.env"
    [ -f "$f" ] || { f="$DIR/compose.next.yml"; e="$DIR/release.next.env"; }
    docker compose -p "$PROJECT" --project-directory "$DIR" -f "$f" --env-file "$e" down -v >/dev/null 2>&1 || true
  fi
  docker rm -f -v "$REGISTRY" >/dev/null 2>&1 || true   # -v: el volumen anónimo del registro
  [ -z "$NETWORK_CREATED" ] || docker network rm cocos-edge >/dev/null 2>&1 || true
  docker rmi "$REG:smoke" >/dev/null 2>&1 || true
  rm -rf "$ROOT_DIR"
}
trap cleanup EXIT

echo "== imagen $LOCAL_IMAGE por digest"
docker run -d --name "$REGISTRY" -p "127.0.0.1:$PORT:5000" registry:2 >/dev/null
docker tag "$LOCAL_IMAGE" "$REG:smoke"
for ((i = 1; ; i++)); do
  docker push -q "$REG:smoke" >/dev/null 2>&1 && break
  [ "$i" -lt 20 ] || fail "no se pudo publicar la imagen en el registro local"
  sleep 1
done
REF="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REG:smoke" | grep "^$REG@sha256:" | head -1)"
[ -n "$REF" ] || fail "la imagen publicada no tiene digest"

echo "== servidor en $ROOT_DIR"
# Los secretos como los escribe setup.sh (issue #36): un archivo cada uno, sin salto final. Como
# en drill-docker.sh, los que lee node van con el grupo 1000 si se puede y si no, legibles por
# todos (en Linux, node no leería un 640 de otro grupo); sus permisos los ensaya drill-docker.sh.
mkdir -p "$DIR/secrets"
pg="$(openssl rand -hex 24)"; api="$(openssl rand -hex 24)"
(
  umask 077
  cd "$DIR/secrets"
  printf '%s' "$pg" > postgres_password
  printf '%s' "postgresql://postgres:$pg@db:5432/cocos" > database_admin_url
  printf '%s' "$api" > api_db_password
  printf '%s' "postgresql://api:$api@db:5432/cocos" > database_url
  printf '%s' "$(openssl rand -hex 24)" > internal_token
  node_secrets=(database_admin_url api_db_password database_url internal_token)
  if chgrp 1000 "${node_secrets[@]}" 2>/dev/null; then chmod 640 "${node_secrets[@]}"; else chmod 644 "${node_secrets[@]}"; fi
)
docker network inspect cocos-edge >/dev/null 2>&1 || { docker network create cocos-edge >/dev/null; NETWORK_CREATED=1; }

# Lo que en el deploy hace deploy.sh smoke-user: el SQL por stdin y userid= en la salida.
smoke_user() {
  local out
  out="$(remote smoke-user staging < deploy/lightsail/smoke-user.sql)" || fail "$1: smoke-user falló"
  sed -n 's/^userid=//p' <<<"$out"
}
# deploy/smoke.mjs dentro de la imagen, en la red interna del proyecto.
smoke() {   # modo, userid
  docker run --rm --network "${PROJECT}_default" --entrypoint node \
    -v "$PWD/deploy/smoke.mjs:/smoke/smoke.mjs:ro" \
    -e URL=http://api:3000 -e SHA="$SHA" -e SMOKE_USERID="${2:-}" "$REF" /smoke/smoke.mjs "$1"
}

echo "== 1. bootstrap, usuario del smoke y switch con $REF"
remote bootstrap staging "$REF" "$SHA" < deploy/lightsail/compose.yml || fail "1: el bootstrap falló"
USERID="$(smoke_user 1)"
remote switch staging "$REF" "$SHA" || fail "1: el switch falló: la API de la imagen no arrancó o no quedó sana"

echo "== 2. smoke write, dos veces con el mismo usuario ($USERID)"
smoke write "$USERID" || fail "2: la primera corrida de write falló"
# Otro deploy del mismo release: bootstrap otra vez (smoke-user lo exige) y el usuario sigue siendo el mismo.
remote bootstrap staging "$REF" "$SHA" < deploy/lightsail/compose.yml || fail "2: el segundo bootstrap falló"
again="$(smoke_user 2)"
[ "$again" = "$USERID" ] || fail "2: después de una corrida completa, smoke-user dio otro usuario ($again y no $USERID)"
remote switch staging "$REF" "$SHA" || fail "2: el segundo switch falló"
smoke write "$USERID" || fail "2: la segunda corrida de write falló: el flujo no es repetible"

echo "== 3. smoke read"
smoke read || fail "3: read falló"

echo "== SMOKE CON DOCKER OK: $REF atiende $SHA; write dos veces con el usuario $USERID y read"
