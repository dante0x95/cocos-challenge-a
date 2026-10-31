#!/usr/bin/env bash
# La parte del deploy que corre en el servidor de Lightsail (D-29). No se instala: cada llamada
# de deploy/lightsail/deploy.sh la manda por SSH, desde el commit del release, y la corre con
# bash -c, así que siempre es la versión del commit que se despliega. Corre como el usuario
# deploy, sobre /opt/cocos/<entorno> (lo prepara deploy/lightsail/setup.sh):
#
#   compose.yml, release.env              lo que atiende (release.env: IMAGE, RELEASE, ENVIRONMENT)
#   compose.next.yml, release.next.env    lo que se va a desplegar (los escribe bootstrap)
#   bootstrap.ok                          copia de release.next.env, escrita solo cuando el
#                                         bootstrap de esa versión terminó bien: la exige switch
#   compose.previous.yml, release.previous.env
#                                         lo que atendía antes del último cambio (switch)
#   switch.pending                        copia del release.env de un cambio sin confirmar
#                                         (issue #56): la escribe switch y la borran confirm y
#                                         rollback. Mientras exista, release.env es lo último a lo
#                                         que se cambió pero no lo último sano: eso es
#                                         release.previous.env (o ninguno, si no existe).
#   secrets/                              un archivo por secreto (setup.sh), que compose.yml
#                                         monta solo en el servicio que lo usa
#
#   remote.sh current <entorno>
#       first=false, release=<sha> e image=<ref> del último release confirmado (release.env, o
#       release.previous.env con un cambio sin confirmar); first=true (y los dos vacíos) solo si
#       no hay ninguno: el entorno nunca se desplegó, o su primer cambio no se confirmó. pending=
#       el commit del cambio sin confirmar (vacío si no hay). Un archivo sin un RELEASE y una
#       IMAGE válidos (vacío, truncado, editado a mano) frena: no es un primer deploy.
#   remote.sh pull <entorno> <ref> <usuario>        (stdin: el token de GHCR)
#       Baja la imagen con una configuración de docker temporal, que se borra al salir: el token
#       no queda en el servidor (ni en ~/.docker ni en los argumentos de ningún proceso).
#   remote.sh bootstrap <entorno> <ref> <sha>      (stdin: el compose.yml del release)
#       Con la imagen nueva y la API anterior todavía atendiendo: levanta la base (con el compose
#       nuevo) y corre el bootstrap, con RELEASE (el commit nuevo) y SERVING_RELEASE (el último
#       confirmado, el mismo que anuncia current). Si falla, sale con 1 y no cambió de versión.
#       Borra la confirmación anterior al empezar y escribe bootstrap.ok solo si el bootstrap
#       terminó bien.
#   remote.sh switch <entorno> <ref> <sha>
#       Exige el bootstrap terminado de esa misma imagen y commit (bootstrap.ok, que consume: otro
#       cambio necesita otro bootstrap), guarda lo que atiende como previous, deja switch.pending
#       y recrea la API con la imagen nueva; espera su healthcheck. Con un cambio anterior sin
#       confirmar no toca previous: lo que atiende no es sano y lo guardado sí.
#   remote.sh confirm <entorno> <ref> <sha>
#       Después de /health y del smoke: lo que atiende es <ref> (<sha>) y queda confirmado (borra
#       switch.pending). Desde acá, el próximo current lo anuncia y el próximo switch lo guarda.
#   remote.sh rollback <entorno> <ref anterior> <sha anterior>
#       Vuelve al último release confirmado (el que anunció current), sin correr el bootstrap
#       anterior, y borra switch.pending recién con esa API sana. Sin release anterior (el primer
#       deploy), saca la API y deja el entorno sin release.
#   remote.sh smoke-user staging                    (stdin: deploy/lightsail/smoke-user.sql)
#       Solo en staging, después del bootstrap: deja listo el usuario del smoke (issue #51) y
#       escribe userid=<id>. Corre el SQL con psql como superusuario dentro del contenedor de la
#       base (el socket local, sin contraseña: no depende de cómo llegan los secretos), en una
#       transacción. En production frena antes de tocar nada: ahí el usuario no existe.
#
# COCOS_ROOT, COCOS_PROJECT (el prefijo del proyecto de compose, cocos-<entorno>) y
# COMPOSE_WAIT_TIMEOUT existen para los ensayos con Docker (drill-docker.sh, smoke-docker.sh): en
# el servidor no están definidos.
set -euo pipefail

ROOT="${COCOS_ROOT:-/opt/cocos}"
PROJECT="${COCOS_PROJECT:-cocos}"
WAIT="${COMPOSE_WAIT_TIMEOUT:-120}"

fail() { echo "SERVIDOR: $*" >&2; exit 1; }

# El entorno, validado, y su directorio preparado por setup.sh.
use_env() {
  case "${1:-}" in
    staging | production) ENV="$1" ;;
    *) fail "entorno desconocido: '${1:-}' (staging o production)" ;;
  esac
  DIR="$ROOT/$ENV"
  for f in postgres_password database_admin_url api_db_password database_url internal_token; do
    [ -f "$DIR/secrets/$f" ] || fail "falta $DIR/secrets/$f: el servidor no está preparado (deploy/lightsail/setup.sh)"
  done
}
REF_RE='^[a-z0-9.:/_-]+@sha256:[0-9a-f]{64}$'
valid_ref() { [[ "$1" =~ $REF_RE ]] || fail "la imagen '$1' no es una referencia por digest"; }
valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "'$1' no es el SHA de un commit"; }

# docker compose sobre el proyecto del entorno, con el compose y el release.env de un estado:
# "" (lo que atiende), "next" o "previous".
compose() {
  local state="$1"; shift
  local suffix="${state:+.$state}"
  docker compose -p "$PROJECT-$ENV" --project-directory "$DIR" \
    -f "$DIR/compose$suffix.yml" --env-file "$DIR/release$suffix.env" "$@"
}
field() { sed -n "s/^$1=//p" "$2"; }
same_release() {   # archivo, ref, sha
  [ -f "$1" ] && [ "$(field IMAGE "$1")" = "$2" ] && [ "$(field RELEASE "$1")" = "$3" ]
}

valid_file() {   # archivo con IMAGE y RELEASE: frena si no los tiene válidos
  [[ "$(field RELEASE "$1")" =~ ^[0-9a-f]{40}$ ]] && [[ "$(field IMAGE "$1")" =~ $REF_RE ]] \
    || fail "$1 no tiene un RELEASE y una IMAGE válidos: revisarlo a mano (no es un primer deploy)"
}
# El archivo del último release confirmado: release.env, o release.previous.env mientras haya un
# cambio sin confirmar. Vacío si no hay ninguno.
confirmed() {
  if [ -e "$DIR/switch.pending" ]; then
    if [ -e "$DIR/release.previous.env" ]; then echo "$DIR/release.previous.env"; fi
  elif [ -e "$DIR/release.env" ]; then
    echo "$DIR/release.env"
  fi
}

current() {
  use_env "$1"
  local file pending=""
  if [ -e "$DIR/switch.pending" ]; then
    valid_file "$DIR/switch.pending"
    pending="$(field RELEASE "$DIR/switch.pending")"
  fi
  file="$(confirmed)"
  if [ -z "$file" ]; then
    printf 'first=true\nrelease=\nimage=\npending=%s\n' "$pending"
    return 0
  fi
  valid_file "$file"
  printf 'first=false\nrelease=%s\nimage=%s\npending=%s\n' "$(field RELEASE "$file")" "$(field IMAGE "$file")" "$pending"
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
  rm -f "$DIR/bootstrap.ok" "$DIR/compose.next.yml" "$DIR/release.next.env"
  cat > "$DIR/compose.next.yml"
  [ -s "$DIR/compose.next.yml" ] || fail "no llegó el compose.yml del release"
  printf 'IMAGE=%s\nRELEASE=%s\nENVIRONMENT=%s\n' "$ref" "$sha" "$ENV" > "$DIR/release.next.env"
  echo "== $ENV: base"
  compose next up -d --wait --wait-timeout "$WAIT" db || fail "la base de $ENV no quedó sana"
  # El bootstrap verifica el contrato del último release confirmado (vacío si ninguno), que es a
  # donde vuelve la vuelta atrás, y registra el de este con su SHA (D-24, issues #39 y #56): así
  # una vuelta atrás vuelve a un release cuyo contrato el próximo bootstrap sigue exigiendo.
  local serving="" file
  file="$(confirmed)"
  [ -z "$file" ] || serving="$(field RELEASE "$file")"
  echo "== $ENV: bootstrap con $ref (atiende: ${serving:-ninguno})"
  compose next run --rm -T --no-deps -e "RELEASE=$sha" -e "SERVING_RELEASE=$serving" migrate \
    || fail "el bootstrap falló: no se cambió de versión"
  cp "$DIR/release.next.env" "$DIR/bootstrap.ok"
}

switch() {
  use_env "$1"
  local ref="$2" sha="$3"
  valid_ref "$ref"
  valid_sha "$sha"
  same_release "$DIR/release.next.env" "$ref" "$sha" && cmp -s "$DIR/release.next.env" "$DIR/bootstrap.ok" \
    || fail "el bootstrap de $ref ($sha) no terminó bien en $ENV: no se cambia de versión"
  # Con un cambio anterior sin confirmar (un job cortado antes de confirm o de rollback), lo que
  # atiende no es sano: lo guardado como anterior es lo último que sí, y no se pisa (issue #56).
  if [ ! -e "$DIR/switch.pending" ]; then
    rm -f "$DIR/compose.previous.yml" "$DIR/release.previous.env"
    if [ -f "$DIR/release.env" ]; then
      cp -p "$DIR/compose.yml" "$DIR/compose.previous.yml"
      cp -p "$DIR/release.env" "$DIR/release.previous.env"
    fi
  fi
  # Después del respaldo completo: si el cambio se corta antes, release.env sigue siendo lo sano.
  # Por un temporal y un rename: una copia cortada (o sin espacio) no deja una marca a medias, y
  # una marca anterior sigue entera hasta que la nueva está completa.
  cp -p "$DIR/release.next.env" "$DIR/switch.pending.tmp"
  mv -f "$DIR/switch.pending.tmp" "$DIR/switch.pending"
  mv "$DIR/compose.next.yml" "$DIR/compose.yml"
  mv "$DIR/release.next.env" "$DIR/release.env"
  rm -f "$DIR/bootstrap.ok"
  echo "== $ENV: API con $ref ($sha)"
  compose "" up -d --wait --wait-timeout "$WAIT" --no-deps api || fail "la API de $sha no quedó sana"
}

confirm() {
  use_env "$1"
  local ref="$2" sha="$3"
  valid_ref "$ref"
  valid_sha "$sha"
  same_release "$DIR/release.env" "$ref" "$sha" || fail "lo que atiende en $ENV no es $ref ($sha): no se confirma"
  if [ ! -e "$DIR/switch.pending" ]; then
    echo "== $ENV: $ref ($sha) ya estaba confirmado"
    return 0
  fi
  same_release "$DIR/switch.pending" "$ref" "$sha" || fail "el cambio sin confirmar de $ENV no es $ref ($sha): no se confirma"
  rm -f "$DIR/switch.pending"
  echo "== $ENV: confirmado $ref ($sha)"
}

rollback() {
  use_env "$1"
  local ref="$2" sha="$3"
  if [ -z "$sha" ]; then
    # Primer deploy del entorno: no hay a qué volver. Sale la API y el entorno queda sin
    # release, así el próximo deploy vuelve a ser el primero. Con un release confirmado, no es
    # un primer deploy: no se saca nada.
    [ -z "$(confirmed)" ] || fail "$ENV tiene un release confirmado: no se saca la API"
    if [ -f "$DIR/release.env" ]; then
      compose "" rm -s -f api || fail "no se pudo sacar la API de $ENV"
      rm -f "$DIR/compose.yml" "$DIR/release.env"
    fi
    rm -f "$DIR/switch.pending"
    echo "== $ENV: sin release anterior; la API quedó afuera"
    return 0
  fi
  valid_ref "$ref"
  valid_sha "$sha"
  local pending=""
  if [ -e "$DIR/switch.pending" ]; then
    # Un cambio sin confirmar: lo último sano es lo guardado como anterior, aunque release.env
    # sea otra cosa (o ya sea el mismo commit, si un re-run lo volvió a cambiar). Se copia y no
    # se mueve, y la marca se borra recién con la API anterior sana: si esto se corta o la API no
    # levanta, la marca sigue y la próxima vuelta atrás (o el re-run) encuentra lo mismo.
    same_release "$DIR/release.previous.env" "$ref" "$sha" \
      || fail "hay un cambio sin confirmar en $ENV y lo guardado como anterior no es $ref ($sha): no se toca nada"
    pending=1
    cp -p "$DIR/compose.previous.yml" "$DIR/compose.yml"
    cp -p "$DIR/release.previous.env" "$DIR/release.env"
    echo "== $ENV: vuelve a $ref ($sha), sin el cambio sin confirmar"
  elif same_release "$DIR/release.env" "$ref" "$sha"; then
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
  [ -z "$pending" ] || rm -f "$DIR/switch.pending"
}

smoke_user() {
  [ "${1:-}" = staging ] || fail "el usuario del smoke existe solo en staging, no en '${1:-}'"
  use_env "$1"
  [ -f "$DIR/compose.next.yml" ] && [ -f "$DIR/bootstrap.ok" ] \
    || fail "no hay un bootstrap terminado en $ENV: el usuario del smoke va después del paso bootstrap"
  local sql out
  sql="$(cat)"
  [ -n "$sql" ] || fail "no llegó el SQL del usuario del smoke"
  out="$(compose next exec -T db psql -U postgres -d cocos -X -q -A -t -v ON_ERROR_STOP=1 -1 -f - <<<"$sql")" \
    || fail "no se pudo preparar el usuario del smoke en $ENV"
  [[ "$out" =~ ^[1-9][0-9]*$ ]] || fail "el SQL del usuario del smoke no devolvió un id: '$out'"
  echo "userid=$out"
}

case "${1:-}" in
  current)   current "${2:-}" ;;
  pull)      pull "${2:-}" "${3:-}" "${4:-}" ;;
  bootstrap) bootstrap "${2:-}" "${3:-}" "${4:-}" ;;
  switch)    switch "${2:-}" "${3:-}" "${4:-}" ;;
  confirm)   confirm "${2:-}" "${3:-}" "${4:-}" ;;
  rollback)  rollback "${2:-}" "${3:-}" "${4:-}" ;;
  smoke-user) smoke_user "${2:-}" ;;
  *)         echo "uso: $0 current|pull|bootstrap|switch|confirm|rollback|smoke-user <entorno> ..." >&2; exit 2 ;;
esac
