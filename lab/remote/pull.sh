#!/usr/bin/env bash
# Baja de GHCR la imagen de A en la instancia del lab (issue #72), por digest, como el deploy del
# entregable (deploy/lightsail/remote.sh pull): el token llega por stdin y se usa con un
# DOCKER_CONFIG temporal que se borra al salir, así que no queda en el servidor.
#
#   <token> | pull.sh <ref> <usuario de GitHub>        (ref: ghcr.io/<repo>@sha256:<64 hex>)
#
# Lo corre lab/deploy.sh; el token es el de `gh auth token` de la Mac, con read:packages.
set -euo pipefail

fail() { echo "PULL FRENADO: $*" >&2; exit 1; }
ref="${1:-}"
user="${2:-}"
[[ "$ref" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || fail "la imagen tiene que ir por digest: '$ref'"
[ -n "$user" ] || fail "falta el usuario de GHCR"
DOCKER_TMP="$(mktemp -d)"
trap 'rm -rf "$DOCKER_TMP"' EXIT
DOCKER_CONFIG="$DOCKER_TMP" docker login ghcr.io -u "$user" --password-stdin >/dev/null \
  || fail "docker login en ghcr.io falló (¿el token tiene read:packages?)"
DOCKER_CONFIG="$DOCKER_TMP" docker pull -q "$ref" || fail "no se pudo bajar $ref"
