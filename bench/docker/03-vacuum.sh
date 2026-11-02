#!/bin/bash
# Tras un restore el visibility map está vacío y los index-only scans tocan el heap.
# Para bench.dump: VACUUM ANALYZE de orders al arrancar (minutos; se cuenta en el tiempo de restore).
set -e
if psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_namespace WHERE nspname = 'app'" | grep -q 1; then
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "VACUUM (ANALYZE) app.orders" -c "ANALYZE app.marketdata"
  echo "03-vacuum: visibility map de app.orders listo"
fi
