#!/bin/bash
# Restaura el dump horneado en la base creada por el entrypoint.
# -j 2: tablas e índices en paralelo (bench.dump tarda minutos; trading.dump, nada).
# maintenance_work_mem alto solo para esta sesión: acelera los CREATE INDEX del restore.
set -e
export PGOPTIONS="-c maintenance_work_mem=512MB"
pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error -j 2 /dumps/trading.dump
