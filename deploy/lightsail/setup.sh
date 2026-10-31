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
#      secretos en secrets/, un archivo por secreto, con el valor sin salto de línea, nunca
#      impresos (issue #36; compose.yml los monta como secrets de Docker Compose):
#        postgres_password                     db: lo lee el entrypoint de Postgres como root
#        database_admin_url, api_db_password   migrate (el bootstrap): la credencial de admin
#        database_url, internal_token          api
#      La primera vez se generan acá. Si el entorno tiene los .env de la versión anterior
#      (db.env, migrate.env y api.env), en cambio, se migran con los mismos valores, sin generar
#      nada: las contraseñas tienen que seguir siendo las de la base ya creada. Los .env quedan
#      (un rollback a un release anterior los usa) y nunca se vuelven a leer. Si ya están los
#      cinco archivos, no los toca; con algunos y no todos, o con .env incompletos, frena:
#      regenerar uno solo dejaría contraseñas que no coinciden con las de la base.
#      Permisos: sin Swarm, compose monta cada archivo con el dueño y el modo del servidor (no
#      aplica uid, gid ni mode). postgres_password queda 600 de deploy; los de api y migrate, que
#      corren como node (uid y gid 1000 en la imagen), 640 de deploy con el grupo 1000. En el
#      servidor el gid 1000 es el del usuario ubuntu, que ya es sudoer, y /opt/cocos es 700 de
#      deploy: nadie más llega a los archivos.
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

# Los secretos de cada entorno, en el orden en que se escriben. postgres_password lo lee root;
# los demás, node (gid APP_GID en la imagen: Dockerfile, node:22-alpine y USER node).
APP_GID=1000
ROOT_SECRETS=(postgres_password)
APP_SECRETS=(database_admin_url api_db_password database_url internal_token)
SECRETS=("${ROOT_SECRETS[@]}" "${APP_SECRETS[@]}")
LEGACY=(db.env migrate.env api.env)

# Una variable de un .env de la versión anterior: exactamente una línea VAR=valor, no vacía. El
# valor va tal cual (setup.sh los escribía sin comillas).
legacy() {   # archivo, variable
  local n
  n="$(grep -c "^$2=" "$1" || true)"
  [ "$n" = 1 ] || fail "$1 tiene $n líneas $2= (se espera una): revisar a mano (no se migra nada)"
  [ -n "$(sed -n "s/^$2=//p" "$1")" ] || fail "$2 está vacío en $1: revisar a mano (no se migra nada)"
  sed -n "s/^$2=//p" "$1"
}

# Escribe los cinco secretos de un entorno (los valores en el orden de SECRETS), sin salto final.
# Van a un directorio temporal con umask 077 que después se renombra: nunca hay un secrets/ a
# medias.
write_secrets() {   # directorio del entorno, valores...
  local dir="$1" tmp="$1/.secrets.tmp" i
  shift
  local values=("$@")
  rm -rf "$tmp"
  (
    umask 077
    mkdir "$tmp"
    for i in "${!SECRETS[@]}"; do printf '%s' "${values[i]}" > "$tmp/${SECRETS[i]}"; done
  )
  mv "$tmp" "$dir/secrets"
}

mkdir -p "$ROOT"
chmod 700 "$ROOT"
for env in staging production; do
  dir="$ROOT/$env"
  mkdir -p "$dir"
  chmod 700 "$dir"
  present=0
  for name in "${SECRETS[@]}"; do [ -f "$dir/secrets/$name" ] && present=$((present + 1)); done
  legacy_present=0
  for f in "${LEGACY[@]}"; do [ -f "$dir/$f" ] && legacy_present=$((legacy_present + 1)); done
  if [ "$present" = "${#SECRETS[@]}" ]; then
    echo "== $env: secretos ya generados, sin cambios"
  elif [ "$present" != 0 ]; then
    fail "$dir/secrets tiene $present de los ${#SECRETS[@]} secretos: revisar a mano (no se regeneran)"
  else
    # Un secrets/ vacío se reemplaza; uno con otros archivos frena.
    [ ! -e "$dir/secrets" ] || rmdir "$dir/secrets" 2>/dev/null \
      || fail "$dir/secrets existe sin ninguno de los secretos: revisar a mano"
    case "$legacy_present" in
      3)
        pg="$(legacy "$dir/db.env" POSTGRES_PASSWORD)"
        admin="$(legacy "$dir/migrate.env" DATABASE_ADMIN_URL)"
        api="$(legacy "$dir/migrate.env" API_DB_PASSWORD)"
        url="$(legacy "$dir/api.env" DATABASE_URL)"
        token="$(legacy "$dir/api.env" INTERNAL_TOKEN)"
        write_secrets "$dir" "$pg" "$admin" "$api" "$url" "$token"
        echo "== $env: secretos migrados de db.env, migrate.env y api.env, con los mismos valores"
        ;;
      0)
        pg="$(secret)"
        api="$(secret)"
        write_secrets "$dir" "$pg" "postgresql://postgres:$pg@db:5432/cocos" "$api" \
          "postgresql://api:$api@db:5432/cocos" "$(secret)"
        echo "== $env: secretos nuevos"
        ;;
      *) fail "$dir tiene $legacy_present de los 3 .env de la versión anterior y ningún secreto: revisar a mano (no se migran ni se regeneran)" ;;
    esac
  fi
  for f in "${LEGACY[@]}"; do [ ! -f "$dir/$f" ] || chmod 600 "$dir/$f"; done
done

echo "== proxy"
mkdir -p "$ROOT/proxy/caddy"
cp proxy/compose.yml "$ROOT/proxy/compose.yml"
cp proxy/caddy/Caddyfile "$ROOT/proxy/caddy/Caddyfile"
chown -R "$USER_NAME:$USER_NAME" "$ROOT"
# Después del chown -R, que deja el grupo de deploy: los secretos que lee node, con el suyo.
for env in staging production; do
  s="$ROOT/$env/secrets"
  chmod 700 "$s"
  for name in "${ROOT_SECRETS[@]}"; do chmod 600 "$s/$name"; done
  for name in "${APP_SECRETS[@]}"; do
    chown "$USER_NAME:$APP_GID" "$s/$name"
    chmod 640 "$s/$name"
  done
done
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
