#!/usr/bin/env bash
# Las dos verificaciones del deploy (D-29), alrededor de `flyctl deploy`, sobre GET /health
# de la app real. Las corre .github/workflows/deploy.yml; test/unit/deploy-workflow.test.ts las
# ejercita con un `curl` simulado.
#
#   SHA=<commit> URL=https://<app>.fly.dev deploy/fly/release-check.sh before
#       El commit a desplegar desciende del release que atiende /health. Un re-run del CI de
#       un commit viejo dispara el workflow igual que un merge; acá se frena. Volver a
#       desplegar el mismo commit pasa. Sin release (app caída o sin crear) se frena: el
#       primer deploy es deploy/fly/setup.sh. Con $GITHUB_OUTPUT definido, escribe ahí
#       previous=<release actual>: si después hay que volver atrás (rollback.sh restore), es el
#       release que tiene que atender otra vez.
#
#   SHA=<commit> URL=https://<app>.fly.dev deploy/fly/release-check.sh after
#       /health responde ok: true con release igual al SHA. Reintenta mientras release sea el
#       anterior, porque la conmutación bluegreen tarda; `curl --retry` no serviría, solo
#       reintenta errores de transporte. HEALTH_ATTEMPTS (30) × HEALTH_INTERVAL (5 s).
set -euo pipefail

: "${SHA:?falta SHA (el commit a desplegar)}"
: "${URL:?falta URL (la app, https://<app>.fly.dev)}"
ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
INTERVAL="${HEALTH_INTERVAL:-5}"

fail() { echo "DEPLOY FRENADO: $*" >&2; exit 1; }
# Sin -f: un 503 (db: "down") también trae release.
health() { curl -sS --max-time 10 "$URL/health"; }

before() {
  local body current
  body="$(health)" || fail "no responde $URL/health. Si es el primer deploy: deploy/fly/setup.sh"
  current="$(jq -r '.release // empty' <<<"$body" 2>/dev/null)" || fail "/health no devolvió JSON: $body"
  [ -n "$current" ] || fail "/health no informa release: $body. Si es el primer deploy: deploy/fly/setup.sh"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "previous=$current" >> "$GITHUB_OUTPUT"; fi
  if [ "$current" = "$SHA" ]; then
    echo "== atiende $SHA: se vuelve a desplegar el mismo commit"
    return 0
  fi
  git cat-file -e "$current^{commit}" 2>/dev/null \
    || fail "el release actual ($current) no está en la historia de este checkout"
  git merge-base --is-ancestor "$current" "$SHA" \
    || fail "$SHA no desciende del release actual ($current): es un commit anterior (un re-run del CI de un commit viejo no despliega)"
  echo "== $SHA desciende de $current: se despliega"
}

after() {
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
  *)      echo "uso: SHA=<commit> URL=<https://app> $0 before|after" >&2; exit 2 ;;
esac
