#!/usr/bin/env bash
# Genera el dataset del lab (issue #72) con el generador del benchmark, seed fija: el mismo
# resultado en cada corrida y en cada máquina. Corre en la Mac, desde la raíz del repo:
#
#   LAB_GENERATOR=<ruta a bench/gen/generate.ts> lab/data/generate.sh [dir]     (dir: lab/.data)
#
# LAB_GENERATOR: el generate.ts del benchmark, dentro de su repo (importa el oráculo de ese repo,
# ../../test/oracle/fold.ts). Sin la variable, bench/gen/generate.ts de este repo.
# Parámetros: 5.010 usuarios (las 10 ballenas del generador + 5.000 con las cohortes del
# benchmark), 1.000 instrumentos con 5 años de cotizaciones, seed 42. lab/data/select.ts deja 3
# ballenas (las más cerca de 150.000 órdenes ejecutadas) y escribe manifest.json.
# Si [dir] ya tiene un manifest.json, no hace nada: borrar el directorio para regenerarlo.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT="${1:-lab/.data}"
GEN="${LAB_GENERATOR:-bench/gen/generate.ts}"
TSX=node_modules/.bin/tsx

if [ -f "$OUT/manifest.json" ]; then
  echo "dataset ya generado en $OUT (dataset_sha256 $(sed -n 's/.*"dataset_sha256": *"\([0-9a-f]*\)".*/\1/p' "$OUT/manifest.json"))"
  exit 0
fi
[ -f "$GEN" ] || { echo "no está el generador ($GEN): definir LAB_GENERATOR con la ruta a bench/gen/generate.ts" >&2; exit 1; }
[ -x "$TSX" ] || { echo "falta $TSX: pnpm install" >&2; exit 1; }

RAW="$OUT/.raw"
rm -rf "$RAW"
mkdir -p "$RAW"
"$TSX" "$GEN" --users 5010 --instruments 1000 --years 5 --end 2026-10-23 --seed 42 --out "$RAW" >/dev/null
"$TSX" lab/data/select.ts "$RAW" "$OUT"
rm -rf "$RAW"
