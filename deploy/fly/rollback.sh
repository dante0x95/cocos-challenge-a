#!/usr/bin/env bash
# Vuelta a la imagen anterior cuando /health deja de atender el commit después de conmutar
# (D-29, issue #13). bluegreen solo protege antes de pasar el tráfico: si las máquinas nuevas
# pasaron el check de Fly y después el dominio público no atiende el commit con ok: true
# (release-check.sh after agota sus intentos), el entorno quedaría con la versión rechazada.
#
#   CONFIG=<fly.toml del entorno> deploy/fly/rollback.sh record
#       Antes del deploy: la imagen que corren las máquinas de la API (grupo `app`). Tiene que
#       ser una sola. Escribe image=<ref> en $GITHUB_OUTPUT (si está definido) y en stdout.
#
#   CONFIG=... URL=https://<app>.fly.dev PREVIOUS_IMAGE=<ref> PREVIOUS_RELEASE=<sha> \
#     deploy/fly/rollback.sh restore
#       Vuelve cada máquina de la API a PREVIOUS_IMAGE con RELEASE=PREVIOUS_RELEASE y exige que
#       /health atienda ese release con ok: true (release-check.sh after).
#
# restore cambia la imagen de las máquinas con `flyctl machine update` y no con `flyctl deploy`,
# para no correr el release_command de la versión anterior: sus funciones reemplazarían a las
# nuevas sobre un esquema ya migrado. La base queda con las migraciones y funciones nuevas,
# que es con lo que la versión anterior atiende durante cualquier deploy bluegreen hasta que se
# conmuta (D-23, D-24). Cada máquina se reinicia al cambiar de imagen: un corte breve.
#
# Lo corre .github/workflows/deploy.yml en staging y en producción; test/unit/deploy-workflow.test.ts
# lo ejercita con `flyctl` y `curl` simulados.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${CONFIG:?falta CONFIG (fly.toml del entorno)}"
APP="$(sed -n 's/^app = "\(.*\)"$/\1/p' "$CONFIG")"
[ -n "$APP" ] || { echo "$CONFIG no define app" >&2; exit 1; }

fail() { echo "VUELTA ATRÁS FALLIDA: $*" >&2; exit 1; }
# Las máquinas de la API (las del grupo de procesos `app`; el release_command corre aparte),
# sin las que se están destruyendo: id e imagen, una por línea.
machines() {
  flyctl machines list --app "$APP" --json \
    | jq -r '.[] | select(.config.metadata.fly_process_group == "app")
                 | select(.state != "destroyed" and .state != "destroying")
                 | "\(.id) \(.config.image)"'
}

record() {
  local images
  images="$(machines | awk '{print $2}' | sort -u)"
  [ -n "$images" ] || fail "$APP no tiene máquinas de la API"
  [ "$(wc -l <<<"$images")" -eq 1 ] || fail "$APP corre más de una imagen: $(tr '\n' ' ' <<<"$images")"
  echo "$images"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "image=$images" >> "$GITHUB_OUTPUT"; fi
}

restore() {
  : "${URL:?falta URL}"
  [ -n "${PREVIOUS_IMAGE:-}" ] || fail "no hay imagen anterior registrada"
  [ -n "${PREVIOUS_RELEASE:-}" ] || fail "no hay release anterior registrado"
  local list id image
  list="$(machines)"
  [ -n "$list" ] || fail "$APP no tiene máquinas de la API"
  echo "== $APP vuelve a $PREVIOUS_IMAGE (release $PREVIOUS_RELEASE)"
  while read -r id image; do
    echo "== máquina $id: $image → $PREVIOUS_IMAGE"
    flyctl machine update "$id" --app "$APP" --image "$PREVIOUS_IMAGE" --env "RELEASE=$PREVIOUS_RELEASE" --yes </dev/null \
      || fail "no se pudo actualizar la máquina $id"
  done <<<"$list"
  SHA="$PREVIOUS_RELEASE" URL="$URL" deploy/fly/release-check.sh after \
    || fail "después de volver a $PREVIOUS_IMAGE, /health no atiende $PREVIOUS_RELEASE"
  echo "== $APP atiende otra vez $PREVIOUS_RELEASE"
}

case "${1:-}" in
  record)  record ;;
  restore) restore ;;
  *)       echo "uso: CONFIG=<fly.toml> $0 record|restore" >&2; exit 2 ;;
esac
