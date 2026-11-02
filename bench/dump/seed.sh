#!/usr/bin/env bash
# trading.dump sin Neon: la base del challenge desde db/migrations/000_seed.sql (el database.sql del
# enunciado). Mismas filas y mismo esquema que el dump de Neon (pull-neon.sh) con que se corrió el
# benchmark: se comparó tabla por tabla y con pg_dump -s (docs/benchmark/datos.md).
# Uso: bench/dump/seed.sh        (desde la raíz del repo; solo necesita Docker)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="bench/dump/trading.dump"
NAME="cocos-bench-seed-$$"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=trading postgres:18 >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
echo -n "esperando postgres"
for _ in $(seq 1 60); do
  # Por TCP: el servidor temporal de initdb solo escucha en el socket y después se reinicia.
  if docker exec "$NAME" psql -h 127.0.0.1 -U postgres -d trading -qAtc 'SELECT 1' >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."; sleep 1
done
docker exec -i "$NAME" psql -h 127.0.0.1 -U postgres -d trading -q -v ON_ERROR_STOP=1 < db/migrations/000_seed.sql
docker exec "$NAME" pg_dump -h 127.0.0.1 -U postgres -d trading -Fc --no-owner --no-privileges -f /tmp/trading.dump
docker cp "$NAME:/tmp/trading.dump" "$OUT"
docker exec "$NAME" psql -h 127.0.0.1 -U postgres -d trading -Atc \
  "SELECT 'users ' || (SELECT count(*) FROM users) || ', instruments ' || (SELECT count(*) FROM instruments) || ', orders ' || (SELECT count(*) FROM orders) || ', marketdata ' || (SELECT count(*) FROM marketdata)"
ls -lh "$OUT"
