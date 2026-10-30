#!/usr/bin/env bash
# Las dos verificaciones del deploy (D-29), alrededor del cambio de versión. Las corre
# .github/workflows/deploy.yml en cada entorno; test/unit/deploy-workflow.test.ts las ejercita
# con un `curl` simulado y repositorios git temporales.
#
#   SHA=<commit> CURRENT=<release que atiende> FIRST_DEPLOY=<true|false> deploy/release-check.sh before
#       El commit a desplegar desciende del release que atiende el entorno (los dos son SHA, no
#       tags). CURRENT y FIRST_DEPLOY los lee el paso anterior del servidor
#       (deploy/lightsail/deploy.sh current): lo último a lo que el deploy cambió, que no depende
#       de que la API responda. Un re-run del workflow de un release viejo puede llegar después
#       de uno más nuevo; acá se frena. Volver a desplegar el mismo commit pasa (también otro tag
#       sobre ese commit). El primer deploy del entorno (FIRST_DEPLOY=true y CURRENT vacío) pasa.
#       Cualquier otra combinación (un CURRENT vacío sin FIRST_DEPLOY=true, por ejemplo, si el
#       paso anterior no dejó su salida) frena: un release vacío no se toma como "no hay".
#
#   SHA=<commit> URL=https://<entorno> deploy/release-check.sh after
#       /health responde ok: true con release igual al SHA, por la URL pública (Caddy y HTTPS
#       incluidos). Reintenta mientras no lo haga, porque la API y el certificado pueden tardar;
#       `curl --retry` no serviría, solo reintenta errores de transporte. HEALTH_ATTEMPTS (30) ×
#       HEALTH_INTERVAL (5 s).
set -euo pipefail

: "${SHA:?falta SHA (el commit a desplegar)}"
ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
INTERVAL="${HEALTH_INTERVAL:-5}"

fail() { echo "DEPLOY FRENADO: $*" >&2; exit 1; }
# Sin -f: un 503 (db: "down") también trae release.
health() { curl -sS --max-time 10 "$URL/health"; }

before() {
  local current="${CURRENT:-}"
  case "${FIRST_DEPLOY:-}:$([ -n "$current" ] && echo con || echo sin)" in
    true:sin)
      echo "== el entorno no tiene release: primer deploy de $SHA"
      return 0 ;;
    false:con) ;;
    *) fail "no se sabe qué release atiende el entorno (FIRST_DEPLOY='${FIRST_DEPLOY:-}', CURRENT='$current')" ;;
  esac
  if [ "$current" = "$SHA" ]; then
    echo "== atiende $SHA: se vuelve a desplegar el mismo commit"
    return 0
  fi
  git cat-file -e "$current^{commit}" 2>/dev/null \
    || fail "el release actual ($current) no está en la historia de este checkout"
  git merge-base --is-ancestor "$current" "$SHA" \
    || fail "$SHA no desciende del release actual ($current): es un commit anterior (un release viejo no pisa uno más nuevo)"
  echo "== $SHA desciende de $current: se despliega"
}

after() {
  : "${URL:?falta URL (https://<entorno>)}"
  local i body
  for ((i = 1; i <= ATTEMPTS; i++)); do
    body="$(health 2>/dev/null || true)"
    if jq -e --arg sha "$SHA" '.ok == true and .release == $sha' <<<"$body" >/dev/null 2>&1; then
      echo "== atiende $SHA con ok: true (intento $i de $ATTEMPTS)"
      echo "$body"
      return 0
    fi
    echo "intento $i de $ATTEMPTS: ${body:-sin respuesta}" >&2
    if [ "$i" -lt "$ATTEMPTS" ]; then sleep "$INTERVAL"; fi
  done
  fail "después de $ATTEMPTS intentos /health no atiende $SHA con ok: true"
}

case "${1:-}" in
  before) before ;;
  after)  after ;;
  *)      echo "uso: SHA=<commit> CURRENT=<sha> FIRST_DEPLOY=false $0 before | SHA=<commit> URL=<https://entorno> $0 after" >&2; exit 2 ;;
esac
