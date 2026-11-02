#!/usr/bin/env bash
# Dump reproducible de la base del challenge en Neon.
# Uso: source .env.local && bench/dump/pull-neon.sh
# Requiere pg_dump 18.x y NEON_URL apuntando al host directo (sin -pooler).
set -euo pipefail

: "${NEON_URL:?Falta NEON_URL. Ejemplo: export NEON_URL='postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require'}"

case "$NEON_URL" in
  *-pooler*) echo "ERROR: NEON_URL apunta al pooler; usá el host directo (sin -pooler)." >&2; exit 1 ;;
esac

OUT="bench/dump/trading.dump"
mkdir -p "$(dirname "$OUT")"

echo "Dumping Neon -> $OUT"
pg_dump "$NEON_URL" -Fc --no-owner --no-privileges -f "$OUT"

echo "--- cabecera del dump ---"
pg_restore -l "$OUT" | head -5
echo "--- tamaño ---"
ls -lh "$OUT"