#!/usr/bin/env bash
# Preparación del servidor de Lightsail (D-29), una vez, antes del primer release. Corre en el
# servidor, con sudo, desde una copia de deploy/lightsail (los comandos exactos: README y
# docs/api/operacion.md):
#
#   sudo ./setup.sh "<clave pública ssh-ed25519 de deploy>"
#
# Es idempotente: correrlo otra vez no cambia ningún secreto y deja la configuración del proxy
# como la del commit. Hace:
#   1. El usuario deploy (en el grupo docker), con una sola clave en authorized_keys: la de
#      deploy que se pasa, con `restrict` (sin TTY ni reenvíos). Correrlo con otra clave la
#      reemplaza. No toca la clave por defecto de Lightsail del usuario ubuntu.
#   2. Por entorno (staging y production), /opt/cocos/<entorno> (700, de deploy) con sus
#      secretos, generados acá la primera vez y nunca impresos: db.env (POSTGRES_PASSWORD),
#      migrate.env (DATABASE_ADMIN_URL y API_DB_PASSWORD, solo para el bootstrap) y api.env
#      (DATABASE_URL con el rol api e INTERNAL_TOKEN), todos 600. Si ya están los tres, no los
#      toca; si falta alguno de los tres pero no todos, frena: regenerar uno solo dejaría
#      contraseñas que no coinciden con las de la base ya creada.
#   3. La red cocos-edge y el proxy (Caddy, /opt/cocos/proxy, proyecto cocos-proxy), con la
#      configuración de proxy/ de esta copia; si cambió, la recarga.
#
# Las API las despliega después cada release (.github/workflows/deploy.yml).
set -euo pipefail
cd "$(dirname "$0")"

ROOT="${COCOS_ROOT:-/opt/cocos}"
USER_NAME=deploy
USER_HOME="${DEPLOY_HOME:-/home/$USER_NAME}"

fail() { echo "SETUP FRENADO: $*" >&2; exit 1; }
secret() { openssl rand -hex 24; }

[ "$(id -u)" = 0 ] || fail "se corre con sudo"
KEY="${1:-}"
[[ "$KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [^[:cntrl:]]*)?$ ]] \
  || fail "falta la clave pública de deploy (ssh-ed25519 AAAA... comentario) como argumento"
[ -f proxy/compose.yml ] && [ -f proxy/caddy/Caddyfile ] || fail "se corre desde una copia de deploy/lightsail"
docker compose version >/dev/null 2>&1 || fail "falta docker compose (el plugin de Docker)"

echo "== usuario $USER_NAME"
getent passwd "$USER_NAME" >/dev/null || useradd --create-home --home-dir "$USER_HOME" --shell /bin/bash "$USER_NAME"
usermod -aG docker "$USER_NAME"
mkdir -p "$USER_HOME/.ssh"
printf 'restrict %s\n' "$KEY" > "$USER_HOME/.ssh/authorized_keys"
chmod 700 "$USER_HOME/.ssh"
chmod 600 "$USER_HOME/.ssh/authorized_keys"
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.ssh"

mkdir -p "$ROOT"
chmod 700 "$ROOT"
for env in staging production; do
  dir="$ROOT/$env"
  mkdir -p "$dir"
  chmod 700 "$dir"
  present=0
  for f in db.env migrate.env api.env; do [ -f "$dir/$f" ] && present=$((present + 1)); done
  case "$present" in
    3) echo "== $env: secretos ya generados, sin cambios" ;;
    0)
      echo "== $env: secretos nuevos"
      pg="$(secret)"
      api="$(secret)"
      token="$(secret)"
      # Se escriben con umask 077 en un temporal y se mueven: nunca hay un .env a medias.
      (
        umask 077
        printf 'POSTGRES_PASSWORD=%s\n' "$pg" > "$dir/.db.env.tmp"
        printf 'DATABASE_ADMIN_URL=postgresql://postgres:%s@db:5432/cocos\nAPI_DB_PASSWORD=%s\n' "$pg" "$api" > "$dir/.migrate.env.tmp"
        printf 'DATABASE_URL=postgresql://api:%s@db:5432/cocos\nINTERNAL_TOKEN=%s\n' "$api" "$token" > "$dir/.api.env.tmp"
      )
      mv "$dir/.db.env.tmp" "$dir/db.env"
      mv "$dir/.migrate.env.tmp" "$dir/migrate.env"
      mv "$dir/.api.env.tmp" "$dir/api.env"
      ;;
    *) fail "$dir tiene $present de los 3 archivos de secretos: revisar a mano (no se regeneran)" ;;
  esac
  chmod 600 "$dir/db.env" "$dir/migrate.env" "$dir/api.env"
done

echo "== proxy"
mkdir -p "$ROOT/proxy/caddy"
cp proxy/compose.yml "$ROOT/proxy/compose.yml"
cp proxy/caddy/Caddyfile "$ROOT/proxy/caddy/Caddyfile"
chown -R "$USER_NAME:$USER_NAME" "$ROOT"
docker network inspect cocos-edge >/dev/null 2>&1 || docker network create cocos-edge >/dev/null
proxy() { docker compose -p cocos-proxy --project-directory "$ROOT/proxy" -f "$ROOT/proxy/compose.yml" "$@"; }
proxy up -d
# Un contenedor que ya corría sigue con el Caddyfile anterior: se recarga. Recién creado, su API
# de administración tarda un momento en atender.
for ((i = 1; ; i++)); do
  proxy exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile && break
  [ "$i" -lt "${RELOAD_ATTEMPTS:-10}" ] || fail "Caddy no recargó el Caddyfile"
  sleep 1
done

echo "== listo: cada release publicado se despliega en staging y después en production"
