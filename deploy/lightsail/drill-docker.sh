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
# Después, exige:
#   0. Los permisos de los secretos de setup.sh (issue #36), en un sistema de archivos de Linux de
#      verdad (un volumen de Docker: en Docker Desktop, un bind mount de la Mac no aplica dueños
#      ni modos): con archivos de otro dueño (uid 1001, como deploy), la imagen corre como uid y
#      gid 1000, node lee un 640 del grupo 1000 y no un 600 (el control), y Postgres arranca con
#      un postgres_password 600 (lo lee como root) y esa es la contraseña del superusuario.
# Y sobre un /opt/cocos temporal y el proyecto cocos-staging:
#   1. good: bootstrap, switch y confirm terminan bien y /health atiende su release. Ningún valor
#      secreto aparece en `docker inspect` de db, api y migrate ni en el entorno del proceso
#      principal de db y api, y cada uno monta en /run/secrets solo los suyos.
#   2. bad-boot: el bootstrap falla, y un switch de esa versión se rechaza; sigue good.
#   3. bad-health: el bootstrap pasa, el switch falla (el healthcheck), rollback vuelve a good y
#      /health atiende otra vez su release.
#   4. Un switch cortado (issue #56): el switch de bad-health falla y nadie vuelve atrás; current
#      anuncia good con bad-health pendiente, el re-run vuelve a fallar en el switch y rollback
#      vuelve a good.
# Al final borra todo lo que creó (contenedores, volúmenes, red, registro e imágenes). remote.sh usa
# el proyecto fijo cocos-staging, y `down -v` borraría su volumen aunque no fuera de este ensayo:
# si en este Docker ya hay algo de ese proyecto (contenedores o volúmenes, también sin
# contenedores, como deja un `down` sin -v), el contenedor del registro o lo del paso 0 (su
# volumen y su Postgres), no empieza ni crea nada. Si no puede consultar Docker, tampoco.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${DRILL_REGISTRY_PORT:-5055}"
REG="localhost:$PORT/cocos-drill"
SHA_GOOD="$(printf 'a%.0s' {1..40})"
SHA_BOOT="$(printf 'b%.0s' {1..40})"
SHA_HEALTH="$(printf 'c%.0s' {1..40})"

fail() { echo "ENSAYO FALLIDO: $*" >&2; exit 1; }
remote() { bash deploy/lightsail/remote.sh "$@"; }

# Antes de crear nada: lo que este ensayo borraría al terminar no puede existir antes.
refuse() { echo "NO SE ENSAYA: $*" >&2; exit 2; }
absent() {   # descripción, comando de docker que lista; vacío = no hay
  local what="$1" out; shift
  out="$("$@")" || refuse "no se pudo consultar Docker ($*)"
  [ -z "$out" ] || refuse "ya hay $what en este Docker ($(tr '\n' ' ' <<<"$out")): no se ensaya encima"
}
absent "contenedores del proyecto cocos-staging" docker ps -aq --filter label=com.docker.compose.project=cocos-staging
absent "volúmenes del proyecto cocos-staging" docker volume ls -q --filter label=com.docker.compose.project=cocos-staging
absent "volúmenes cocos-staging_*" docker volume ls -q --filter name=cocos-staging_
absent "un contenedor cocos-drill-registry" docker ps -aq --filter name=cocos-drill-registry
absent "un contenedor cocos-drill-pg" docker ps -aq --filter name=cocos-drill-pg
absent "un volumen cocos-drill-secrets" docker volume ls -q --filter name=cocos-drill-secrets

ROOT_DIR="$(mktemp -d)"
NETWORK_CREATED=""
SECRETS_VOLUME=""
export COCOS_ROOT="$ROOT_DIR" COMPOSE_WAIT_TIMEOUT="${COMPOSE_WAIT_TIMEOUT:-90}"
DIR="$ROOT_DIR/staging"

cleanup() {
  if [ -f "$DIR/compose.yml" ] || [ -f "$DIR/compose.next.yml" ]; then
    local f="$DIR/compose.yml" e="$DIR/release.env"
    [ -f "$f" ] || { f="$DIR/compose.next.yml"; e="$DIR/release.next.env"; }
    docker compose -p cocos-staging --project-directory "$DIR" -f "$f" --env-file "$e" down -v >/dev/null 2>&1 || true
  fi
  docker rm -f cocos-drill-registry cocos-drill-pg >/dev/null 2>&1 || true
  [ -z "$SECRETS_VOLUME" ] || docker volume rm cocos-drill-secrets >/dev/null 2>&1 || true
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

echo "== 0. permisos de los secretos, como los deja setup.sh"
# Los escribe root en un contenedor, en un volumen (un sistema de archivos de Linux en cualquier
# Docker), con otro dueño que node, como deploy en el servidor, y los modos de setup.sh. Se montan
# por la ruta del volumen, como compose monta un secreto de archivo: un bind mount.
p0="$(openssl rand -hex 24)"; t0="$(openssl rand -hex 24)"
SECRETS_VOLUME=1
docker volume create cocos-drill-secrets >/dev/null
docker run --rm -u 0 -v cocos-drill-secrets:/s -e P0="$p0" -e T0="$t0" --entrypoint sh "$GOOD" -ec '
  cd /s
  printf %s "$P0" > postgres_password; printf %s "$T0" > internal_token; printf %s "$T0" > control
  printf %s postgresql://api:x@db:5432/cocos > database_url
  chown 1001:1001 postgres_password control; chmod 600 postgres_password control
  chown 1001:1000 internal_token database_url; chmod 640 internal_token database_url' \
  || fail "0: no se pudieron escribir los secretos de prueba"
VOL="$(docker volume inspect -f '{{.Mountpoint}}' cocos-drill-secrets)"
[ "$(docker run --rm --entrypoint id "$GOOD" -u):$(docker run --rm --entrypoint id "$GOOD" -g)" = 1000:1000 ] \
  || fail "0: la imagen no corre como uid y gid 1000 (node), el grupo al que setup.sh da los secretos"
config() {   # archivo del volumen para INTERNAL_TOKEN_FILE: la configuración de la API lo lee
  docker run --rm -v "$VOL/database_url:/run/secrets/database_url:ro" -v "$VOL/$1:/run/secrets/internal_token:ro" \
    -e DATABASE_URL_FILE=/run/secrets/database_url -e INTERNAL_TOKEN_FILE=/run/secrets/internal_token "$GOOD" \
    node -e "import('/app/dist/config.js').then((m) => process.exit(m.config.INTERNAL_TOKEN === '$t0' ? 0 : 3))"
}
config internal_token || fail "0: node no lee un secreto 640 del grupo 1000"
if config control 2>/dev/null; then fail "0: node leyó un 600 de otro usuario: el ensayo no ve los permisos"; fi
docker run -d --name cocos-drill-pg -v "$VOL/postgres_password:/run/secrets/postgres_password:ro" \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password postgres:18 >/dev/null
ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cocos-drill-pg)"
for ((i = 1; ; i++)); do
  docker exec cocos-drill-pg pg_isready -q -h "$ip" 2>/dev/null && break
  [ "$i" -lt 60 ] || fail "0: Postgres no arrancó con un postgres_password 600 de otro usuario: $(docker logs cocos-drill-pg 2>&1 | tail -3)"
  sleep 1
done
# Por la IP del contenedor y no por el socket (trust): así Postgres pide la contraseña.
docker exec cocos-drill-pg psql -qAt "postgresql://postgres:$p0@$ip/postgres" -c 'SELECT 1' >/dev/null \
  || fail "0: la contraseña de postgres_password no es la del superusuario"
if docker exec cocos-drill-pg psql -qAt "postgresql://postgres:otra@$ip/postgres" -c 'SELECT 1' >/dev/null 2>&1; then
  fail "0: Postgres aceptó otra contraseña: el control no prueba nada"
fi
docker rm -f cocos-drill-pg >/dev/null
echo "   node lee un 640 del grupo 1000 y no un 600 de otro usuario; Postgres arranca con su 600 y esa contraseña"

echo "== servidor en $ROOT_DIR"
# Los secretos como los escribe setup.sh: un archivo cada uno, sin salto final. Sus permisos los
# ensayó el paso 0; acá van con el grupo 1000 si se puede (root, o un usuario de ese grupo) y si
# no, legibles por todos: en Linux, node no leería un 640 de otro grupo.
mkdir -p "$DIR/secrets"
pg="$(openssl rand -hex 24)"; api="$(openssl rand -hex 24)"; token="$(openssl rand -hex 24)"
admin_url="postgresql://postgres:$pg@db:5432/cocos"; api_url="postgresql://api:$api@db:5432/cocos"
SECRET_VALUES=("$pg" "$api" "$token" "$admin_url" "$api_url")
(
  umask 077
  cd "$DIR/secrets"
  printf '%s' "$pg" > postgres_password
  printf '%s' "$admin_url" > database_admin_url
  printf '%s' "$api" > api_db_password
  printf '%s' "$api_url" > database_url
  printf '%s' "$token" > internal_token
  node_secrets=(database_admin_url api_db_password database_url internal_token)
  if chgrp 1000 "${node_secrets[@]}" 2>/dev/null; then chmod 640 "${node_secrets[@]}"; else chmod 644 "${node_secrets[@]}"; fi
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
remote confirm staging "$GOOD" "$SHA_GOOD" || fail "1: confirm de good falló"
# Ningún valor secreto en `docker inspect` ni en el entorno del proceso principal, y cada servicio
# con sus secretos y nada más. migrate corre con `run --rm`: se crea, sin arrancarlo, para mirar
# su configuración.
project() { docker compose -p cocos-staging --project-directory "$DIR" -f "$DIR/compose.yml" --env-file "$DIR/release.env" --profile migrate "$@"; }
project create migrate >/dev/null 2>&1 || fail "1: no se pudo crear el contenedor de migrate"
hidden() {   # texto: falla si contiene algún valor secreto
  local v
  for v in "${SECRET_VALUES[@]}"; do [[ "$1" != *"$v"* ]] || return 1; done
}
for svc in db:postgres_password migrate:api_db_password,database_admin_url api:database_url,internal_token; do
  name="${svc%%:*}"
  c="$(project ps -aq "$name")"
  [ -n "$c" ] || fail "1: no hay contenedor de $name"
  hidden "$(docker inspect "$c")" || fail "1: docker inspect de $name muestra un secreto"
  if [ "$name" != migrate ]; then
    hidden "$(docker exec "$c" cat /proc/1/environ | tr '\0' '\n')" || fail "1: el entorno del proceso principal de $name tiene un secreto"
  fi
  mounts="$(docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$c" | sed -n 's|^/run/secrets/||p' | sort | paste -sd, -)"
  [ "$mounts" = "${svc#*:}" ] || fail "1: $name monta en /run/secrets '$mounts' y no '${svc#*:}'"
done
project rm -f migrate >/dev/null 2>&1 || fail "1: no se pudo borrar el contenedor de migrate"
echo "   db, migrate y api: ningún secreto en docker inspect ni en el entorno; cada uno monta solo los suyos"

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

echo "== 4. switch cortado: el re-run vuelve a fallar y rollback vuelve a good"
remote bootstrap staging "$HEALTH" "$SHA_HEALTH" < deploy/lightsail/compose.yml || fail "4: el bootstrap de bad-health falló"
if remote switch staging "$HEALTH" "$SHA_HEALTH"; then fail "4: el switch a una API que responde 503 terminó bien"; fi
# El job se cortó acá: nadie vuelve atrás. El re-run tiene que ver good como lo último sano.
expected="$(printf 'first=false\nrelease=%s\nimage=%s\npending=%s' "$SHA_GOOD" "$GOOD" "$SHA_HEALTH")"
[ "$(remote current staging)" = "$expected" ] || fail "4: current no anuncia good con bad-health pendiente: $(remote current staging | tr '\n' ' ')"
remote bootstrap staging "$HEALTH" "$SHA_HEALTH" < deploy/lightsail/compose.yml || fail "4: el bootstrap del re-run falló"
if remote switch staging "$HEALTH" "$SHA_HEALTH"; then fail "4: el switch del re-run terminó bien"; fi
remote rollback staging "$GOOD" "$SHA_GOOD" || fail "4: rollback no volvió a good"
serving "$SHA_GOOD" 4
[ ! -e "$DIR/switch.pending" ] || fail "4: la vuelta atrás dejó el cambio sin confirmar"

echo "== ENSAYO OK: bootstrap fallido, API sin salud y switch cortado; atiende $SHA_GOOD"
