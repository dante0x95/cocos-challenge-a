#!/bin/bash
# Agrega la config del perfil al postgresql.conf generado por initdb.
# El entrypoint reinicia Postgres después de los scripts de initdb.d, así que
# parámetros que requieren restart (shared_preload_libraries) quedan aplicados.
set -e
echo "include '/etc/postgresql/custom.conf'" >> "$PGDATA/postgresql.conf"