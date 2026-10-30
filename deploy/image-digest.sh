#!/usr/bin/env bash
# La referencia inmutable de la imagen publicada (D-29, issue #13): <IMAGE>@sha256:<digest>, la
# que despliegan staging y producción. La etiqueta <IMAGE>:<SHA> se puede sobrescribir: una
# reejecución del deploy del mismo release, u otro release del mismo commit, reconstruye y vuelve
# a publicar, y la imagen base (node:22-alpine) no garantiza los mismos bytes. Si producción
# resolviera la etiqueta después de staging, podría desplegar una imagen que su staging no probó;
# con el digest despliega exactamente la que construyó y publicó su corrida.
#
#   IMAGE=ghcr.io/<repo> SHA=<commit> deploy/image-digest.sh
#       Después de `docker push "$IMAGE:$SHA"`: escribe ref=<IMAGE>@sha256:<64 hex> en
#       $GITHUB_OUTPUT (si está definido) y en stdout. Falla si no hay un digest de ese repo.
#
# Lo corre el job image de .github/workflows/deploy.yml; test/unit/deploy-workflow.test.ts lo
# ejercita con un `docker` simulado.
set -euo pipefail

: "${IMAGE:?falta IMAGE (ghcr.io/<repo>)}"
: "${SHA:?falta SHA (el commit de la imagen)}"

# La imagen local con esa etiqueta es la que construyó este job; `docker push` le agrega el
# digest del registro a RepoDigests. Puede haber digests de otros repos: vale el de IMAGE.
digests="$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE:$SHA")" \
  || { echo "no se pudo inspeccionar $IMAGE:$SHA" >&2; exit 1; }
ref=""
while read -r d; do
  if [ "${d%@*}" = "$IMAGE" ] && [[ "${d#*@}" =~ ^sha256:[0-9a-f]{64}$ ]]; then ref="$d"; break; fi
done <<<"$digests"
[ -n "$ref" ] || { echo "$IMAGE:$SHA no tiene un digest de $IMAGE (¿se publicó?): ${digests:-ninguno}" >&2; exit 1; }

echo "$ref"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "ref=$ref" >> "$GITHUB_OUTPUT"; fi
