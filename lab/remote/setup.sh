#!/usr/bin/env bash
# Preparación de la instancia del lab (issue #72), una vez. La corre lab/deploy.sh setup en la
# instancia, con sudo, como el usuario por defecto de Lightsail (ubuntu). Es idempotente:
#   1. Docker y el plugin compose, de los paquetes de Ubuntu (docker.io, docker-compose-v2), si
#      no están; el usuario que corrió sudo queda en el grupo docker.
#   2. 2 GB de swap en /swapfile si la instancia no tiene: las tres bases y las tres APIs entran
#      en 2 GB de RAM (lab/compose.yml), y el swap es el margen de la carga y de una request de Z.
#   3. /opt/cocos-lab de ese usuario, con secrets.env (600): las contraseñas de Postgres y del rol
#      api de las tres bases, generadas acá la primera vez y nunca impresas. Las bases no publican
#      puertos; las contraseñas no cambian si ya están.
# No toca nada del servidor del entregable: es otra instancia.
set -euo pipefail

fail() { echo "SETUP FRENADO: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "se corre con sudo"
OWNER="${SUDO_USER:-}"
[ -n "$OWNER" ] && [ "$OWNER" != root ] || fail "se corre con sudo desde el usuario que va a desplegar (ubuntu)"
ROOT=/opt/cocos-lab

echo "== docker"
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io docker-compose-v2
fi
systemctl enable --now docker >/dev/null
usermod -aG docker "$OWNER"
docker compose version

echo "== swap"
if [ -z "$(swapon --show --noheadings)" ]; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon --show

echo "== $ROOT"
mkdir -p "$ROOT"
chown "$OWNER:$OWNER" "$ROOT"
chmod 700 "$ROOT"
if [ ! -f "$ROOT/secrets.env" ]; then
  (
    umask 077
    printf 'LAB_PG_PASSWORD=%s\nLAB_API_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$ROOT/secrets.env.tmp"
  )
  mv "$ROOT/secrets.env.tmp" "$ROOT/secrets.env"
  echo "secrets.env nuevo"
else
  echo "secrets.env ya estaba, sin cambios"
fi
chown "$OWNER:$OWNER" "$ROOT/secrets.env"
chmod 600 "$ROOT/secrets.env"

echo "== listo: lab/deploy.sh despliega"
