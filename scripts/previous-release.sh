#!/usr/bin/env bash
# Compatibilidad con el release anterior (D-24, issue #39): la API del último release vX.Y.Z
# tiene que seguir escribiendo sobre la base que deja HEAD. Es lo que pasa en cada deploy, entre
# el COMMIT del bootstrap y el cambio de versión, y después de una vuelta atrás (D-29), que no
# corre el bootstrap anterior. El contrato que verifica el bootstrap (src/db/contract.ts) solo ve
# que las firmas resuelvan; esto ve también lo que devuelven: corre las pruebas de escritura del
# release anterior (POST /orders de cash, MARKET y LIMIT, cancelar, portfolio), con su código,
# contra una base que el bootstrap de ese release creó y el de HEAD actualizó.
#
# Lo corre el CI (.github/workflows/ci.yml) con el Postgres de servicio; necesita TEST_PG_URL,
# la historia y los tags (checkout con fetch-depth: 0). Recrea la base cocos_test.
# Sin un release anterior en la historia de HEAD no hay nada que probar y termina bien.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TEST_PG_URL:?falta TEST_PG_URL}"
# Las pruebas de escritura por HTTP del release anterior, desde su árbol.
TESTS=(test/db/orders.api.test.ts)

# El release más nuevo en la historia de HEAD, sin contar uno que apunte a HEAD mismo.
tag="$(git tag --list --merged HEAD --no-contains HEAD --sort=-version:refname \
  | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | head -n1 || true)"
if [ -z "$tag" ]; then
  echo "== no hay un release vX.Y.Z anterior a HEAD: nada que probar"
  exit 0
fi

prev="$(mktemp -d)"
trap 'git worktree remove --force "$prev" >/dev/null 2>&1 || rm -rf "$prev"' EXIT
git worktree add --detach --quiet "$prev" "$tag"
(cd "$prev" && pnpm install --frozen-lockfile --silent)

base="${TEST_PG_URL%%\?*}"
admin="${base%/*}/cocos_test"
psql "$TEST_PG_URL" -q -c 'DROP DATABASE IF EXISTS cocos_test WITH (FORCE)' -c 'CREATE DATABASE cocos_test'
echo "== base de $tag ($(git rev-parse --short "$tag^{commit}"))"
(cd "$prev" && DATABASE_ADMIN_URL="$admin" API_DB_PASSWORD=api RELEASE="$tag" SERVING_RELEASE= pnpm -s db:bootstrap)
echo "== bootstrap de HEAD sobre esa base"
# Como en el deploy: el bootstrap de HEAD exige el contrato del release que atiende.
DATABASE_ADMIN_URL="$admin" API_DB_PASSWORD=api RELEASE=HEAD SERVING_RELEASE="$tag" pnpm -s db:bootstrap
echo "== pruebas de escritura de $tag contra la base de HEAD: ${TESTS[*]}"
(cd "$prev" && SKIP_DB_SETUP=1 TEST_PG_URL="$TEST_PG_URL" pnpm -s exec vitest run "${TESTS[@]}")
