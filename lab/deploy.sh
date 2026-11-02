#!/usr/bin/env bash
# Deploy del lab (issue #72) a su instancia de Lightsail, a mano, desde la Mac de Dante y desde la
# raíz del repo. No hay workflow: nada de esto pasa por GitHub Actions ni por el servidor del
# entregable.
#
#   lab/deploy.sh setup     prepara la instancia (lab/remote/setup.sh, con sudo): una vez
#   lab/deploy.sh           despliega el commit actual (HEAD) y verifica con lab/check.ts
#   lab/deploy.sh check     solo la verificación, contra lo que ya atiende
#
# Variables:
#   LIGHTSAIL_LAB_HOST   la IP estática de la instancia del lab (obligatoria)
#   LIGHTSAIL_LAB_KEY    la ruta de su clave SSH, la que se baja de la consola (obligatoria)
#   LAB_C_REPO           el repo anterior (dante0x95/cocos-challenge) en la Mac: de ahí sale v3 (obligatoria)
#   LAB_C_COMMIT         su commit para v3 (e54cdcc, el último que corrió en Fly)
#   LAB_A_IMAGE          v2: la imagen que atiende producción, por digest (la de v0.2.0, abajo). La
#                        instancia la baja de GHCR con el token de `gh auth token` de la Mac, que
#                        necesita read:packages; va por stdin y no queda en el servidor
#                        (lab/remote/pull.sh).
#   LAB_SITE             la dirección del sitio en Caddy. Por defecto <ip con guiones>.sslip.io,
#                        con HTTPS; `:80` para HTTP solo por la IP.
#   LAB_GENERATOR        el generador del benchmark, si el dataset no está generado (lab/data/generate.sh).
#   LAB_RESET=1          borra las bases antes de levantar (docker compose down -v): hace falta si
#                        cambió el dataset, porque cada base se carga una sola vez.
#
# El deploy: arma el código con git archive (solo lo versionado en HEAD), genera el dataset si
# falta y lo copia si en la instancia hay otro, baja la imagen de A y construye la de C (git
# archive del repo anterior) si la instancia no las tiene, y en la instancia levanta lab/compose.yml (proyecto cocos-lab): `up` vuelve cuando arrancó el
# proxy, que espera a las tres APIs sanas, y cada API espera a que su base esté cargada (C, además,
# caliente). Después espera a que el proxy atienda (con sslip.io, Caddy pide el certificado) y corre
# lab/check.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "DEPLOY DEL LAB FRENADO: $*" >&2; exit 1; }

CMD="${1:-deploy}"
HOST_IP="${LIGHTSAIL_LAB_HOST:-}"
KEY="${LIGHTSAIL_LAB_KEY:-}"
[ -n "$HOST_IP" ] || fail "falta LIGHTSAIL_LAB_HOST (la IP de la instancia del lab)"
[ -n "$KEY" ] && [ -f "$KEY" ] || fail "falta LIGHTSAIL_LAB_KEY (la ruta de la clave SSH de la instancia): '${KEY}'"
TARGET="ubuntu@${HOST_IP}"
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ServerAliveInterval=30)
remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

ROOT=/opt/cocos-lab
DATA=lab/.data
# v0.2.0, la que atienden staging y producción: el digest que publicó su deploy (job image, run 41163581056).
A_IMAGE="${LAB_A_IMAGE:-ghcr.io/dante0x95/cocos-challenge-a@sha256:fcde20e4bc4e1aff220668a85d36736c4a33468b17aafe78d9fc1351a8aab86f}"
C_REPO="${LAB_C_REPO:-}"
C_COMMIT="${LAB_C_COMMIT:-e54cdcc}"
SITE="${LAB_SITE:-${HOST_IP//./-}.sslip.io}"
case "$SITE" in :*) URL="http://${HOST_IP}" ;; *) URL="https://${SITE}" ;; esac

check() {
  echo "== verificación contra ${URL}"
  node_modules/.bin/tsx lab/check.ts "$URL" "$DATA"
}

case "$CMD" in
  setup)
    echo "== preparar ${TARGET}"
    scp "${SSH_OPTS[@]}" lab/remote/setup.sh "${TARGET}:cocos-lab-setup.sh"
    remote "sudo bash cocos-lab-setup.sh && rm cocos-lab-setup.sh"
    exit 0
    ;;
  check) check; exit 0 ;;
  deploy) ;;
  *) fail "subcomando desconocido: $CMD (setup, deploy o check)" ;;
esac

remote "test -f ${ROOT}/secrets.env" || fail "la instancia no está preparada: lab/deploy.sh setup"
[ -n "$C_REPO" ] && git -C "$C_REPO" cat-file -e "${C_COMMIT}^{commit}" 2>/dev/null \
  || fail "falta LAB_C_REPO (el repo anterior, con el commit ${C_COMMIT}): '${C_REPO}'"
C_FULL="$(git -C "$C_REPO" rev-parse "${C_COMMIT}^{commit}")"
C_IMAGE="cocos-lab-c:${C_FULL:0:7}"
SHA="$(git rev-parse HEAD)"
[ -z "$(git status --porcelain -- lab db/migrations/000_seed.sql)" ] \
  || echo "aviso: hay cambios sin commitear en lab/: se despliega HEAD (${SHA}), sin ellos"

echo "== dataset"
lab/data/generate.sh "$DATA"
LOCAL_SHA="$(sed -n 's/.*"dataset_sha256": *"\([0-9a-f]*\)".*/\1/p' "$DATA/manifest.json")"
REMOTE_SHA="$(remote "sed -n 's/.*\"dataset_sha256\": *\"\([0-9a-f]*\)\".*/\1/p' ${ROOT}/data/manifest.json 2>/dev/null" || true)"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "copiando el dataset ${LOCAL_SHA} (en la instancia: ${REMOTE_SHA:-ninguno})"
  tar -C "$DATA" -czf - manifest.json users.csv instruments.csv marketdata.csv orders.csv \
    | remote "rm -rf ${ROOT}/data.new && mkdir ${ROOT}/data.new && tar -C ${ROOT}/data.new -xzf - && rm -rf ${ROOT}/data && mv ${ROOT}/data.new ${ROOT}/data"
else
  echo "la instancia ya tiene el dataset ${LOCAL_SHA}"
fi

echo "== código de ${SHA}"
git archive --format=tar "$SHA" lab db/migrations/000_seed.sql package.json pnpm-lock.yaml pnpm-workspace.yaml \
  | remote "rm -rf ${ROOT}/src.new && mkdir ${ROOT}/src.new && tar -C ${ROOT}/src.new -xf - && rm -rf ${ROOT}/src && mv ${ROOT}/src.new ${ROOT}/src"

echo "== v2 (A): ${A_IMAGE}"
if remote "docker image inspect '${A_IMAGE}' >/dev/null 2>&1"; then
  echo "la instancia ya la tiene"
else
  GH_USER="$(gh api user --jq .login)" || fail "gh no está autenticado"
  gh auth token | remote "bash ${ROOT}/src/lab/remote/pull.sh '${A_IMAGE}' '${GH_USER}'" \
    || fail "no se pudo bajar la imagen de A: gh auth refresh -s read:packages (lab/README.md)"
fi

echo "== v3 (C): ${C_IMAGE}, de ${C_FULL} de ${C_REPO}"
if remote "docker image inspect '${C_IMAGE}' >/dev/null 2>&1"; then
  echo "la instancia ya la tiene"
else
  git -C "$C_REPO" archive --format=tar "$C_FULL" \
    | remote "rm -rf ${ROOT}/c-src && mkdir ${ROOT}/c-src && tar -C ${ROOT}/c-src -xf - && docker build -q -t '${C_IMAGE}' ${ROOT}/c-src && rm -rf ${ROOT}/c-src" \
    || fail "no se pudo construir la imagen de C"
fi

remote "printf 'LAB_A_IMAGE=%s\nLAB_C_IMAGE=%s\nLAB_SITE=%s\nLAB_DATA_DIR=%s\nLAB_RELEASE=%s\n' '${A_IMAGE}' '${C_IMAGE}' '${SITE}' '${ROOT}/data' '${SHA}' > ${ROOT}/deploy.env"

echo "== levantar (cocos-lab)"
COMPOSE="docker compose -p cocos-lab --project-directory ${ROOT}/src/lab -f ${ROOT}/src/lab/compose.yml --env-file ${ROOT}/secrets.env --env-file ${ROOT}/deploy.env"
if [ "${LAB_RESET:-}" = 1 ]; then
  echo "LAB_RESET=1: borrando las bases del lab"
  remote "${COMPOSE} down -v --remove-orphans"
fi
remote "${COMPOSE} up -d --build --remove-orphans" \
  || { remote "${COMPOSE} ps -a; ${COMPOSE} logs --tail 40 load-z load-a load-c migrate-a migrate-c warm-c" || true; fail "el lab no levantó (logs arriba)"; }
remote "${COMPOSE} ps"

for ((i = 1; ; i++)); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "${URL}/v2/health" || true)" = 200 ] && break
  [ "$i" -lt 60 ] || fail "${URL}/v2/health no responde 200"
  sleep 2
done
check
echo "== listo: ${URL}/v1, ${URL}/v2 y ${URL}/v3 (commit ${SHA})"
