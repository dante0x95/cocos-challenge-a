#!/usr/bin/env bash
# Los pasos de deploy en Lightsail de .github/workflows/deploy.yml (D-29), del lado del runner.
# Cada uno es una llamada SSH que corre deploy/lightsail/remote.sh del commit del release en el
# servidor; test/unit/deploy-workflow.test.ts los ejercita con `ssh` y `docker` simulados.
#
# Entorno: ENVIRONMENT (staging o production), IMAGE_REF (la imagen por digest), SHA y
# RUNNER_TEMP (el directorio temporal del job: ahí queda la clave, y GitHub lo vacía al terminar).
#
#   deploy.sh access     Con LIGHTSAIL_HOST, LIGHTSAIL_SSH_KEY y LIGHTSAIL_KNOWN_HOSTS (secretos
#                        del environment): escribe la clave y la configuración de SSH, con la
#                        clave del host fijada (StrictHostKeyChecking yes). Solo este paso los lee.
#   deploy.sh current    release= e image= de lo que atiende el entorno, y first=true si nunca
#                        se desplegó (first=false si no), en $GITHUB_OUTPUT. Lo decide el
#                        servidor (no hay release.env); un release.env inválido frena acá.
#   deploy.sh pull       Baja la imagen en el servidor, con GITHUB_TOKEN por stdin (nunca en un
#                        argumento) y GITHUB_ACTOR.
#   deploy.sh bootstrap  Manda deploy/lightsail/compose.yml del commit y corre el bootstrap con la
#                        imagen nueva, antes de cambiar de versión.
#   deploy.sh smoke-user Solo en staging, después del bootstrap: manda deploy/lightsail/smoke-user.sql
#                        y deja userid= (el usuario del smoke, en cero) en $GITHUB_OUTPUT, para
#                        deploy/smoke.mjs write (issue #51). En production frena sin tocar nada.
#   deploy.sh switch     Cambia la API a la imagen nueva.
#   deploy.sh rollback   Vuelve a PREVIOUS_IMAGE / PREVIOUS_RELEASE (lo que anotó current) y
#                        exige que /health (URL) lo atienda otra vez. En el primer deploy
#                        (FIRST_DEPLOY=true, sin release anterior) saca la API. Sin esa salida de
#                        current, no toca nada.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail() { echo "DEPLOY FRENADO: $*" >&2; exit 1; }
SSH_DIR="${RUNNER_TEMP:?falta RUNNER_TEMP}/lightsail"

remote() {
  [ -f "$SSH_DIR/config" ] || fail "falta la configuración de SSH (el paso access)"
  # El script viaja como argumento de bash -c, citado con %q: stdin queda libre para el token
  # o el compose.yml.
  ssh -F "$SSH_DIR/config" lightsail \
    "bash -c $(printf '%q' "$(cat deploy/lightsail/remote.sh)") remote.sh $(printf '%q ' "$@")"
}

access() {
  local v
  for v in LIGHTSAIL_HOST LIGHTSAIL_SSH_KEY LIGHTSAIL_KNOWN_HOSTS; do
    [ -n "${!v:-}" ] || fail "falta el secreto $v en el environment ${ENVIRONMENT:-}"
  done
  umask 077
  mkdir -p "$SSH_DIR"
  printf '%s\n' "$LIGHTSAIL_SSH_KEY" > "$SSH_DIR/key"
  printf '%s\n' "$LIGHTSAIL_KNOWN_HOSTS" > "$SSH_DIR/known_hosts"
  cat > "$SSH_DIR/config" <<EOF
Host lightsail
  HostName $LIGHTSAIL_HOST
  User deploy
  IdentityFile $SSH_DIR/key
  IdentitiesOnly yes
  UserKnownHostsFile $SSH_DIR/known_hosts
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 15
  ServerAliveInterval 15
EOF
  echo "== acceso SSH a deploy@$LIGHTSAIL_HOST"
}

current() {
  local out release image first
  out="$(remote current "${ENVIRONMENT:?}" </dev/null)" || fail "no se pudo leer qué atiende $ENVIRONMENT"
  first="$(sed -n 's/^first=//p' <<<"$out")"
  release="$(sed -n 's/^release=//p' <<<"$out")"
  image="$(sed -n 's/^image=//p' <<<"$out")"
  # El servidor dice si es el primer deploy; acá solo se exige que lo demás coincida.
  case "$first:$([ -n "$release" ] && echo con || echo sin):$([ -n "$image" ] && echo con || echo sin)" in
    true:sin:sin)  echo "== $ENVIRONMENT no tiene release: es su primer deploy" ;;
    false:con:con) echo "== $ENVIRONMENT atiende $release ($image)" ;;
    *) fail "respuesta inesperada del servidor sobre $ENVIRONMENT: $(tr '\n' ' ' <<<"$out")" ;;
  esac
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    { echo "release=$release"; echo "image=$image"; echo "first=$first"; } >> "$GITHUB_OUTPUT"
  fi
}

pull() {
  printf '%s' "${GITHUB_TOKEN:?falta GITHUB_TOKEN}" \
    | remote pull "${ENVIRONMENT:?}" "${IMAGE_REF:?}" "${GITHUB_ACTOR:?falta GITHUB_ACTOR}"
}

bootstrap() {
  remote bootstrap "${ENVIRONMENT:?}" "${IMAGE_REF:?}" "${SHA:?}" < deploy/lightsail/compose.yml
}

smoke_user() {
  [ "${ENVIRONMENT:?}" = staging ] || fail "el usuario del smoke existe solo en staging, no en $ENVIRONMENT"
  local out userid
  out="$(remote smoke-user "$ENVIRONMENT" < deploy/lightsail/smoke-user.sql)" || fail "no se pudo preparar el usuario del smoke en $ENVIRONMENT"
  userid="$(sed -n 's/^userid=//p' <<<"$out")"
  [[ "$userid" =~ ^[1-9][0-9]*$ ]] || fail "respuesta inesperada del servidor sobre el usuario del smoke: $(tr '\n' ' ' <<<"$out")"
  echo "== usuario del smoke en $ENVIRONMENT: $userid"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "userid=$userid" >> "$GITHUB_OUTPUT"; fi
}

switch() {
  remote switch "${ENVIRONMENT:?}" "${IMAGE_REF:?}" "${SHA:?}" </dev/null
}

rollback() {
  case "${FIRST_DEPLOY:-}:$([ -n "${PREVIOUS_RELEASE:-}" ] && [ -n "${PREVIOUS_IMAGE:-}" ] && echo con || echo sin)" in
    true:sin)
      remote rollback "${ENVIRONMENT:?}" "" "" </dev/null
      return 0 ;;
    false:con) ;;
    *) fail "no se sabe a qué volver (FIRST_DEPLOY='${FIRST_DEPLOY:-}', PREVIOUS_RELEASE='${PREVIOUS_RELEASE:-}'): no se toca nada" ;;
  esac
  remote rollback "${ENVIRONMENT:?}" "$PREVIOUS_IMAGE" "$PREVIOUS_RELEASE" </dev/null
  SHA="$PREVIOUS_RELEASE" deploy/release-check.sh after \
    || fail "después de volver a $PREVIOUS_IMAGE, /health no atiende $PREVIOUS_RELEASE"
  echo "== $ENVIRONMENT atiende otra vez $PREVIOUS_RELEASE"
}

case "${1:-}" in
  access)    access ;;
  current)   current ;;
  pull)      pull ;;
  bootstrap) bootstrap ;;
  smoke-user) smoke_user ;;
  switch)    switch ;;
  rollback)  rollback ;;
  *)         echo "uso: $0 access|current|pull|bootstrap|smoke-user|switch|rollback" >&2; exit 2 ;;
esac
