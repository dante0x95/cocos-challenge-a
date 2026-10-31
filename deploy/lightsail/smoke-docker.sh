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
# Aislado de lo que haya en este Docker (un docker compose, un staging local con su Caddy, otro
# ensayo), por sus nombres y no por suerte:
#   - Su propio proyecto (SMOKE_PROJECT, por defecto cocos-smoke: el proyecto es
#     cocos-smoke-staging), su registro (cocos-smoke-registry, en SMOKE_REGISTRY_PORT, 5056) y su
#     red externa (cocos-smoke-edge). El compose.yml que instala es el del commit con una sola
#     diferencia: la red edge se llama cocos-smoke-edge y no cocos-edge, así que el alias
#     api-staging de la API del ensayo existe solo ahí y un Caddy en cocos-edge nunca lo resuelve
#     a ella. Después del switch exige que la API esté solo en sus dos redes.
#   - El registro es el candado: lo crea con `docker create --name`, que falla si otro ya tiene
#     ese nombre (otra ejecución que pasó las mismas comprobaciones al mismo tiempo); en ese caso
#     no sigue ni toca nada. Con el registro suyo, comprueba que no haya nada del proyecto ni la
#     red, y si hay, no sigue.
#   - Al terminar borra solo lo que esta ejecución creó, por su id o su nombre único: si llegó al
#     bootstrap, el proyecto (`down -v`, desde su directorio temporal), la etiqueta de la imagen
#     (smoke-<id de la ejecución>, de nadie más), la red y, al final, el registro (con su
#     volumen). El candado se suelta recién ahí: mientras quede algo compartido por borrar, otra
#     ejecución no puede empezar. Si algo no se pudo borrar, el registro queda (las ejecuciones
#     siguientes se rechazan). Todo borrado que falla (también el del registro, y que `down -v`
#     deje contenedores o volúmenes del proyecto, y el del directorio temporal) se informa con qué
#     borrar a mano y la salida no es 0: conserva el código de un error anterior, y si no había,
#     sale con 1.
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
EDGE="$PREFIX-edge"
docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1 || refuse "no está la imagen $LOCAL_IMAGE (docker build -t $LOCAL_IMAGE .)"

# Lo que esta ejecución creó, por id: la limpieza no toca nada más.
ROOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cocos-smoke.XXXXXX")"   # en TMPDIR también en macOS
REGISTRY_ID=""; EDGE_ID=""; TAGGED=""
IMAGE_TAG="$REG:smoke-${ROOT_DIR##*/}"   # única por ejecución: ninguna otra la usa
export COCOS_ROOT="$ROOT_DIR" COCOS_PROJECT="$PREFIX" COMPOSE_WAIT_TIMEOUT="${COMPOSE_WAIT_TIMEOUT:-90}"
DIR="$ROOT_DIR/staging"

# Lo compartido primero y el candado al final: mientras algo quede, otra ejecución se rechaza.
# Sin `set -e` adentro: cada paso se intenta, y lo que falla se anota y cambia la salida.
cleanup() {
  local status=$? left=()
  set +e
  if [ -f "$DIR/compose.yml" ] || [ -f "$DIR/compose.next.yml" ]; then
    local f="$DIR/compose.yml" e="$DIR/release.env"
    [ -f "$f" ] || { f="$DIR/compose.next.yml"; e="$DIR/release.next.env"; }
    if ! docker compose -p "$PROJECT" --project-directory "$DIR" -f "$f" --env-file "$e" down -v >/dev/null 2>&1; then
      left+=("el proyecto $PROJECT (down -v falló)")
    # Que down diga que terminó no alcanza: no tiene que quedar nada con la etiqueta del proyecto.
    elif [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>&1)$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>&1)" ]; then
      left+=("contenedores o volúmenes del proyecto $PROJECT")
    fi
  fi
  if [ -n "$TAGGED" ] && ! docker rmi "$IMAGE_TAG" >/dev/null 2>&1; then left+=("la imagen $IMAGE_TAG"); fi
  if [ -n "$EDGE_ID" ] && ! docker network rm "$EDGE_ID" >/dev/null 2>&1; then left+=("la red $EDGE"); fi
  if [ ${#left[@]} -gt 0 ]; then
    # El registro queda como candado: borrarlo dejaría empezar a otra encima de lo que quedó.
    echo "SMOKE CON DOCKER: no se pudo borrar ${left[*]}; queda el registro $REGISTRY como candado: limpiar a mano y después docker rm -f -v $REGISTRY" >&2
    [ "$status" != 0 ] || status=1
  elif [ -n "$REGISTRY_ID" ] && ! docker rm -f -v "$REGISTRY_ID" >/dev/null 2>&1; then   # -v: su volumen anónimo
    echo "SMOKE CON DOCKER: no se pudo borrar el registro $REGISTRY ($REGISTRY_ID), que sigue siendo el candado: borrarlo a mano con docker rm -f -v $REGISTRY" >&2
    [ "$status" != 0 ] || status=1
  fi
  if ! rm -rf "$ROOT_DIR"; then
    echo "SMOKE CON DOCKER: no se pudo borrar $ROOT_DIR (tiene secretos de prueba): borrarlo a mano" >&2
    [ "$status" != 0 ] || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

# El candado: si otro tiene el registro, no sigue (y no lo borra: no es suyo).
REGISTRY_ID="$(docker create --name "$REGISTRY" -p "127.0.0.1:$PORT:5000" registry:2 2>/dev/null)" \
  || { REGISTRY_ID=""; refuse "ya hay un contenedor $REGISTRY (otra ejecución del smoke?): no se corre encima"; }
absent "contenedores del proyecto $PROJECT" docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"
absent "volúmenes del proyecto $PROJECT" docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"
absent "volúmenes ${PROJECT}_*" docker volume ls -q --filter "name=${PROJECT}_"
absent "la red $EDGE" docker network ls -q --filter "name=^$EDGE\$"

echo "== imagen $LOCAL_IMAGE por digest"
docker start "$REGISTRY_ID" >/dev/null || fail "no arrancó el registro local (¿el puerto $PORT está ocupado?)"
docker tag "$LOCAL_IMAGE" "$IMAGE_TAG"
TAGGED=1
for ((i = 1; ; i++)); do
  docker push -q "$IMAGE_TAG" >/dev/null 2>&1 && break
  [ "$i" -lt 20 ] || fail "no se pudo publicar la imagen en el registro local"
  sleep 1
done
REF="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_TAG" | grep "^$REG@sha256:" | head -1)"
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
EDGE_ID="$(docker network create "$EDGE")" || { EDGE_ID=""; fail "no se pudo crear la red $EDGE"; }

# El compose.yml del commit, con la red edge del ensayo en lugar de cocos-edge: el único cambio.
sed "s/^    name: cocos-edge\$/    name: $EDGE/" deploy/lightsail/compose.yml > "$ROOT_DIR/compose.yml"
[ "$(grep -c "^    name: $EDGE\$" "$ROOT_DIR/compose.yml")" = 1 ] && ! grep -v '^ *#' "$ROOT_DIR/compose.yml" | grep -q cocos-edge \
  || fail "deploy/lightsail/compose.yml ya no declara la red edge como 'name: cocos-edge': actualizar este script"

# Lo que en el deploy hace deploy.sh smoke-user: el SQL por stdin y userid= en la salida.
smoke_user() {
  local out id
  out="$(remote smoke-user staging < deploy/lightsail/smoke-user.sql)" || fail "$1: smoke-user falló"
  id="$(sed -n 's/^userid=//p' <<<"$out")"
  [[ "$id" =~ ^[1-9][0-9]*$ ]] || fail "$1: smoke-user no devolvió un userid: '$out'"
  echo "$id"
}
# deploy/smoke.mjs dentro de la imagen, en la red interna del proyecto.
smoke() {   # modo, userid
  docker run --rm --network "${PROJECT}_default" --entrypoint node \
    -v "$PWD/deploy/smoke.mjs:/smoke/smoke.mjs:ro" \
    -e URL=http://api:3000 -e SHA="$SHA" -e SMOKE_USERID="${2:-}" "$REF" /smoke/smoke.mjs "$1"
}

echo "== 1. bootstrap, usuario del smoke y switch con $REF"
remote bootstrap staging "$REF" "$SHA" < "$ROOT_DIR/compose.yml" || fail "1: el bootstrap falló"
USERID="$(smoke_user 1)"
remote switch staging "$REF" "$SHA" || fail "1: el switch falló: la API de la imagen no arrancó o no quedó sana"
# La API del ensayo, solo en sus redes: ni cocos-edge ni ninguna otra, así que su alias api-staging
# no le llega a un Caddy de este Docker.
api_id="$(docker compose -p "$PROJECT" --project-directory "$DIR" -f "$DIR/compose.yml" --env-file "$DIR/release.env" ps -q api)"
nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$api_id" | sed '/^$/d' | sort | paste -sd, -)"
[ "$nets" = "$(printf '%s\n' "${PROJECT}_default" "$EDGE" | sort | paste -sd, -)" ] \
  || fail "1: la API del ensayo está en las redes '$nets', no solo en ${PROJECT}_default y $EDGE"

echo "== 2. smoke write, dos veces con el mismo usuario ($USERID)"
smoke write "$USERID" || fail "2: la primera corrida de write falló"
# Otro deploy del mismo release: bootstrap otra vez (smoke-user lo exige) y el usuario sigue siendo el mismo.
remote bootstrap staging "$REF" "$SHA" < "$ROOT_DIR/compose.yml" || fail "2: el segundo bootstrap falló"
again="$(smoke_user 2)"
[ "$again" = "$USERID" ] || fail "2: después de una corrida completa, smoke-user dio otro usuario ($again y no $USERID)"
remote switch staging "$REF" "$SHA" || fail "2: el segundo switch falló"
smoke write "$USERID" || fail "2: la segunda corrida de write falló: el flujo no es repetible"

echo "== 3. smoke read"
smoke read || fail "3: read falló"

echo "== SMOKE CON DOCKER OK: $REF atiende $SHA; write dos veces con el usuario $USERID y read"
