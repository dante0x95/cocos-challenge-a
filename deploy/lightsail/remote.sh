#!/usr/bin/env bash
# La parte del deploy que corre en el servidor de Lightsail (D-29). No se instala: cada llamada
# de deploy/lightsail/deploy.sh la manda por SSH, desde el commit del release, y la corre con
# bash -c, así que siempre es la versión del commit que se despliega. Corre como el usuario
# deploy, sobre /opt/cocos/<entorno> (lo prepara deploy/lightsail/setup.sh):
#
#   compose.yml, release.env              lo que atiende (release.env: IMAGE, RELEASE, ENVIRONMENT)
#   compose.next.yml, release.next.env    lo que se va a desplegar (los escribe bootstrap)
#   compose.previous.yml, release.previous.env
#                                         lo que atendía antes del último cambio (switch)
#   db.env, migrate.env, api.env          secretos (setup.sh, 600)
#
#   remote.sh current <entorno>
#       release=<sha> e image=<ref> de lo que atiende; vacíos si el entorno nunca se desplegó.
#   remote.sh pull <entorno> <ref> <usuario>        (stdin: el token de GHCR)
#       Baja la imagen con una configuración de docker temporal, que se borra al salir: el token
#       no queda en el servidor (ni en ~/.docker ni en los argumentos de ningún proceso).
#   remote.sh bootstrap <entorno> <ref> <sha>      (stdin: el compose.yml del release)
#       Con la imagen nueva y la API anterior todavía atendiendo: levanta la base (con el compose
#       nuevo) y corre el bootstrap. Si falla, sale con 1 y no cambió de versión.
#   remote.sh switch <entorno> <ref> <sha>
#       Exige el bootstrap de esa misma imagen y commit, guarda lo que atiende como previous y
#       recrea la API con la imagen nueva; espera su healthcheck.
#   remote.sh rollback <entorno> <ref anterior> <sha anterior>
#       Vuelve a lo que atendía antes del deploy, sin correr el bootstrap anterior. Sin release
#       anterior (el primer deploy), saca la API y deja el entorno sin release.
set -euo pipefail

ROOT="${COCOS_ROOT:-/opt/cocos}"
WAIT="${COMPOSE_WAIT_TIMEOUT:-120}"

fail() { echo "SERVIDOR: $*" >&2; exit 1; }

# El entorno, validado, y su directorio preparado por setup.sh.
use_env() {
  case "${1:-}" in
    staging | production) ENV="$1" ;;
    *) fail "entorno desconocido: '${1:-}' (staging o production)" ;;
  esac
  DIR="$ROOT/$ENV"
  for f in db.env migrate.env api.env; do
    [ -f "$DIR/$f" ] || fail "falta $DIR/$f: el servidor no está preparado (deploy/lightsail/setup.sh)"
  done
}
valid_ref() { [[ "$1" =~ ^[a-z0-9.:/_-]+@sha256:[0-9a-f]{64}$ ]] || fail "la imagen '$1' no es una referencia por digest"; }
valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "'$1' no es el SHA de un commit"; }

# docker compose sobre el proyecto del entorno, con el compose y el release.env de un estado:
# "" (lo que atiende), "next" o "previous".
compose() {
  local state="$1"; shift
  local suffix="${state:+.$state}"
  docker compose -p "cocos-$ENV" --project-directory "$DIR" \
    -f "$DIR/compose$suffix.yml" --env-file "$DIR/release$suffix.env" "$@"
}
field() { sed -n "s/^$1=//p" "$2"; }
same_release() {   # archivo, ref, sha
  [ -f "$1" ] && [ "$(field IMAGE "$1")" = "$2" ] && [ "$(field RELEASE "$1")" = "$3" ]
}

current() {
  use_env "$1"
  if [ -f "$DIR/release.env" ]; then
    echo "release=$(field RELEASE "$DIR/release.env")"
    echo "image=$(field IMAGE "$DIR/release.env")"
  else
    echo "release="
    echo "image="
  fi
}

pull() {
  use_env "$1"
  local ref="$2" user="$3"
  valid_ref "$ref"
  [ -n "$user" ] || fail "falta el usuario de GHCR"
  # Global y no local: el trap corre al salir del script, cuando las variables de la función ya
  # no existen.
  DOCKER_TMP="$(mktemp -d)"
  trap 'rm -rf "$DOCKER_TMP"' EXIT
  DOCKER_CONFIG="$DOCKER_TMP" docker login ghcr.io -u "$user" --password-stdin >/dev/null \
    || fail "docker login en ghcr.io falló"
  DOCKER_CONFIG="$DOCKER_TMP" docker pull -q "$ref" || fail "no se pudo bajar $ref"
  echo "== $ENV: imagen $ref"
}

bootstrap() {
  use_env "$1"
  local ref="$2" sha="$3"
  valid_ref "$ref"
  valid_sha "$sha"
  docker image inspect "$ref" >/dev/null 2>&1 || fail "no está la imagen $ref (falta el paso pull)"
  rm -f "$DIR/compose.next.yml" "$DIR/release.next.env"
  cat > "$DIR/compose.next.yml"
  [ -s "$DIR/compose.next.yml" ] || fail "no llegó el compose.yml del release"
  printf 'IMAGE=%s\nRELEASE=%s\nENVIRONMENT=%s\n' "$ref" "$sha" "$ENV" > "$DIR/release.next.env"
  echo "== $ENV: base"
  compose next up -d --wait --wait-timeout "$WAIT" db || fail "la base de $ENV no quedó sana"
  echo "== $ENV: bootstrap con $ref"
  compose next run --rm -T --no-deps migrate || fail "el bootstrap falló: no se cambió de versión"
}

switch() {
  use_env "$1"
  local ref="$2" sha="$3"
  valid_ref "$ref"
  valid_sha "$sha"
  same_release "$DIR/release.next.env" "$ref" "$sha" \
    || fail "el bootstrap de $ref ($sha) no corrió en $ENV: no se cambia de versión"
  rm -f "$DIR/compose.previous.yml" "$DIR/release.previous.env"
  if [ -f "$DIR/release.env" ]; then
    cp -p "$DIR/compose.yml" "$DIR/compose.previous.yml"
    cp -p "$DIR/release.env" "$DIR/release.previous.env"
  fi
  mv "$DIR/compose.next.yml" "$DIR/compose.yml"
  mv "$DIR/release.next.env" "$DIR/release.env"
  echo "== $ENV: API con $ref ($sha)"
  compose "" up -d --wait --wait-timeout "$WAIT" --no-deps api || fail "la API de $sha no quedó sana"
}

rollback() {
  use_env "$1"
  local ref="$2" sha="$3"
  if [ -z "$sha" ]; then
    # Primer deploy del entorno: no hay a qué volver. Sale la API y el entorno queda sin
    # release, así el próximo deploy vuelve a ser el primero.
    if [ -f "$DIR/release.env" ]; then
      compose "" rm -s -f api || fail "no se pudo sacar la API de $ENV"
      rm -f "$DIR/compose.yml" "$DIR/release.env"
    fi
    echo "== $ENV: sin release anterior; la API quedó afuera"
    return 0
  fi
  valid_ref "$ref"
  valid_sha "$sha"
  if same_release "$DIR/release.env" "$ref" "$sha"; then
    # El deploy falló antes de cambiar: lo que atiende ya es lo anterior.
    echo "== $ENV: sigue en $ref ($sha)"
  elif same_release "$DIR/release.previous.env" "$ref" "$sha"; then
    mv "$DIR/compose.previous.yml" "$DIR/compose.yml"
    mv "$DIR/release.previous.env" "$DIR/release.env"
    echo "== $ENV: vuelve a $ref ($sha)"
  else
    fail "ni lo que atiende ni lo guardado como anterior es $ref ($sha): no se toca nada"
  fi
  compose "" up -d --wait --wait-timeout "$WAIT" --no-deps api || fail "la API de $sha no quedó sana"
}

case "${1:-}" in
  current)   current "${2:-}" ;;
  pull)      pull "${2:-}" "${3:-}" "${4:-}" ;;
  bootstrap) bootstrap "${2:-}" "${3:-}" "${4:-}" ;;
  switch)    switch "${2:-}" "${3:-}" "${4:-}" ;;
  rollback)  rollback "${2:-}" "${3:-}" "${4:-}" ;;
  *)         echo "uso: $0 current|pull|bootstrap|switch|rollback <entorno> ..." >&2; exit 2 ;;
esac
