#!/usr/bin/env bash
# El gate del release (D-29, issue #30), antes de construir la imagen: solo se despliega un
# GitHub Release con tag vX.Y.Z sobre un commit de main con el check `ci` en verde. Lo corre el
# job gate de .github/workflows/deploy.yml al publicarse un release; test/unit/deploy-workflow.test.ts
# lo ejercita con `gh` y `sleep` simulados y un repositorio git temporal.
#
#   TAG=vX.Y.Z SHA=<commit> REPO=<owner/repo> deploy/fly/release-gate.sh
#       Frena (sale con 1, con el motivo) si:
#       - el tag no es vX.Y.Z: v seguida de tres números sin ceros a la izquierda, sin sufijos
#         (v1.2.3 sí; 1.2.3, v1.2, v01.2.3 y v1.2.3-rc.1 no);
#       - el tag no apunta a SHA: se movió después de publicar el release (un re-run toma el
#         SHA del evento original);
#       - SHA no está en main (MAIN_REF, por defecto origin/main): un tag sobre otra rama;
#       - el último check `ci` de SHA (de GitHub Actions) no terminó en verde. Si todavía corre,
#         o no empezó (el release se publicó apenas mergeado), espera: CI_ATTEMPTS (40) ×
#         CI_INTERVAL (30 s), más que el timeout del job ci.
#       Necesita la historia completa (tags y MAIN_REF) y `gh` con un token que lea checks.
set -euo pipefail

: "${TAG:?falta TAG (el tag del release)}"
: "${SHA:?falta SHA (el commit del release)}"
: "${REPO:?falta REPO (owner/repo)}"
MAIN_REF="${MAIN_REF:-origin/main}"
ATTEMPTS="${CI_ATTEMPTS:-40}"
INTERVAL="${CI_INTERVAL:-30}"

fail() { echo "DEPLOY FRENADO: $*" >&2; exit 1; }

[[ "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "el tag '$TAG' no es vX.Y.Z (por ejemplo v1.2.3): solo se despliega una versión"

tagged="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")" \
  || fail "el tag $TAG no está en este checkout"
[ "$tagged" = "$SHA" ] \
  || fail "el tag $TAG apunta a $tagged y el release se publicó sobre $SHA: se movió el tag (una versión nueva va con otro tag)"

git rev-parse -q --verify "$MAIN_REF^{commit}" >/dev/null || fail "no está $MAIN_REF en este checkout"
git merge-base --is-ancestor "$SHA" "$MAIN_REF" \
  || fail "$TAG ($SHA) no está en main: solo se despliega un release de un commit de main (gh release create $TAG --target main)"

# El estado del último check `ci` de GitHub Actions sobre SHA (el de id mayor: un re-run del CI
# agrega otro): "sin correr", "corriendo" o su conclusion (success, failure, cancelled, …).
ci_state() {
  gh api "repos/$REPO/commits/$SHA/check-runs?check_name=ci&per_page=100" \
    | jq -r '[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.id) | last
             | if . == null then "sin correr" elif .status != "completed" then "corriendo" else .conclusion end'
}

for ((i = 1; i <= ATTEMPTS; i++)); do
  state="$(ci_state)" || fail "no se pudo leer el check ci de $SHA (gh api)"
  case "$state" in
    success)
      echo "== $TAG ($SHA): vX.Y.Z, en main y con ci en verde: se despliega"
      exit 0 ;;
    "sin correr" | corriendo)
      echo "intento $i de $ATTEMPTS: ci de $SHA: $state" >&2
      if [ "$i" -lt "$ATTEMPTS" ]; then sleep "$INTERVAL"; fi ;;
    *)
      fail "el ci de $SHA terminó en $state: solo se despliega un commit con ci en verde" ;;
  esac
done
fail "después de $ATTEMPTS intentos el ci de $SHA no terminó en verde (sigue $state)"
