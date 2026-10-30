#!/usr/bin/env bash
# Primer despliegue en Fly.io (D-29): crea la app de la base con su volumen, la app de la API,
# los secretos de las dos, y despliega. Se corre una sola vez, con flyctl autenticado y parado
# en el commit de main que se quiere desplegar (el workflow exige después que el commit de cada
# release descienda del desplegado: un commit de otra rama, o anterior, lo frenaría):
#
#   git switch main && git pull
#   fly auth login
#   deploy/fly/setup.sh            # producción (fly.toml + deploy/fly/db.toml)
#   CONFIG=deploy/fly/staging.toml DB_CONFIG=deploy/fly/staging-db.toml deploy/fly/setup.sh   # staging
#   FLY_ORG elige la organización (por defecto, personal).
#
# Las contraseñas y el token interno se generan acá y van por stdin a `fly secrets import`:
# no se imprimen, no pasan por la línea de comandos y no quedan en el repo. Para leer el token
# interno después: fly ssh console -a cocos-challenge-a-api -C 'printenv INTERNAL_TOKEN'.
#
# Después de esto, cada release publicado (gh release create vX.Y.Z --target main
# --generate-notes) se despliega solo (.github/workflows/deploy.yml), con el secreto
# FLY_API_TOKEN de cada environment de GitHub: un token de deploy por app, porque un token de
# deploy de Fly se acota a una sola (fly tokens create deploy -a <app>, que con el CONFIG de
# staging es cocos-challenge-a-staging, y gh secret set FLY_API_TOKEN --env <entorno>).
set -euo pipefail
cd "$(dirname "$0")/../.."

toml() { sed -n "s/^$1 = \"\(.*\)\"$/\1/p" "$2"; }
CONFIG="${CONFIG:-fly.toml}"
DB_CONFIG="${DB_CONFIG:-deploy/fly/db.toml}"
API_APP="$(toml app "$CONFIG")"
DB_APP="$(toml app "$DB_CONFIG")"
REGION="$(toml primary_region "$CONFIG")"
ORG="${FLY_ORG:-personal}"
secret() { openssl rand -hex 24; }

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "setup.sh se corre parado en main" >&2; exit 2; }
git diff --quiet HEAD -- || { echo "hay cambios sin commitear: el release tiene que ser un commit de main" >&2; exit 2; }

PG_PASSWORD="$(secret)"
API_PASSWORD="$(secret)"

echo "== base: $DB_APP ($REGION)"
fly apps create "$DB_APP" --org "$ORG"
fly volumes create pgdata --app "$DB_APP" --region "$REGION" --size 1 --yes
printf 'POSTGRES_PASSWORD=%s\n' "$PG_PASSWORD" | fly secrets import --app "$DB_APP" --stage
fly deploy --config "$DB_CONFIG" --ha=false

echo "== API: $API_APP"
fly apps create "$API_APP" --org "$ORG"
# DATABASE_ADMIN_URL la usa solo el release_command, pero los secretos son por app: queda
# también en las máquinas que atienden (límite conocido, D-29).
{
  printf 'DATABASE_ADMIN_URL=postgresql://postgres:%s@%s.internal:5432/cocos\n' "$PG_PASSWORD" "$DB_APP"
  printf 'API_DB_PASSWORD=%s\n' "$API_PASSWORD"
  printf 'DATABASE_URL=postgresql://api:%s@%s.internal:5432/cocos\n' "$API_PASSWORD" "$DB_APP"
  printf 'INTERNAL_TOKEN=%s\n' "$(secret)"
} | fly secrets import --app "$API_APP" --stage
SHA="$(git rev-parse HEAD)"
fly deploy --config "$CONFIG" --ha=false --remote-only --image-label "$SHA" --env "RELEASE=$SHA"

SHA="$SHA" URL="https://$API_APP.fly.dev" deploy/fly/release-check.sh after
