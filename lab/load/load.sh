#!/usr/bin/env bash
# Carga del dataset del lab en la base de una variante (issue #72). Corre en un contenedor
# postgres:18 (por psql) con el dataset en /data y lab/ en /lab, como superusuario de su base
# (PGHOST, PGUSER, PGPASSWORD y PGDATABASE vienen de lab/compose.yml):
#
#   load.sh z|a|c
#
# Las tres bases reciben los mismos CSV (lab/data/generate.sh; /data/manifest.json tiene sus
# sha256). La primera vez carga y deja el sha256 del dataset en public.lab_dataset, todo en una
# transacción: una carga cortada o rechazada no deja nada, y el arranque siguiente la reintenta.
# Las siguientes no recargan nada. Una base con otro dataset frena: se recrea con `down -v`
# (lab/README.md).
#   z  el esquema de database.sql tal cual (db/migrations/000_seed.sql, con sus datos de ejemplo)
#      y los CSV sin balance_seq, que database.sql no tiene. Cash como en A, size en centavos a
#      0.01: size · price da el mismo importe y no pierde los centavos.
#   a  sobre la base que dejó el bootstrap de la imagen de A (el servicio migrate-a): COPY con el
#      trigger orders_guard apagado y los índices de orders afuera (se recrean con su definición).
#      Las CANCELLED llevan cancel_reason USER, como las heredadas en la migración 005. Después,
#      app.verify_ledger() no puede informar nada de los usuarios del dataset (ids desde 1000; los
#      de database.sql tienen su corto heredado, D-01): el fold de A coincide con la suma directa
#      de importes para cada uno.
#   c  lo mismo que a y además, en cada arranque, lab/c/snapshot.sql (el bootstrap acaba de
#      reinstalar las funciones de A), el calentamiento de todos los snapshots (C no atiende frío:
#      docs/decision-snapshot.md) y una reconciliación: snapshot + delta = fold completo para
#      todos los usuarios.
set -euo pipefail

VARIANT="${1:?uso: load.sh z|a|c}"
DATA=/data
psql() { command psql -X -v ON_ERROR_STOP=1 -q "$@"; }
log() { echo "[load-$VARIANT] $*"; }

case "$VARIANT" in
  z) SCHEMA=public ;;
  a|c) SCHEMA=app ;;
  *) echo "variante desconocida: $VARIANT (z, a o c)" >&2; exit 2 ;;
esac

for f in manifest.json users.csv instruments.csv marketdata.csv orders.csv; do
  [ -f "$DATA/$f" ] || { echo "falta $DATA/$f: generar el dataset con lab/data/generate.sh" >&2; exit 1; }
done
SHA="$(sed -n 's/.*"dataset_sha256": *"\([0-9a-f]*\)".*/\1/p' "$DATA/manifest.json")"
[ -n "$SHA" ] || { echo "manifest.json sin dataset_sha256" >&2; exit 1; }

# El SQL de la carga de cada variante (sin la parte común: secuencias y marca del dataset).
load_sql_z() {
  cat <<SQL
\\i /db/000_seed.sql
\\copy users       (id,email,accountnumber)                                 FROM '$DATA/users.csv'       CSV HEADER
\\copy instruments (id,ticker,name,type)                                    FROM '$DATA/instruments.csv' CSV HEADER
\\copy marketdata  (id,instrumentid,high,low,open,close,previousclose,date) FROM '$DATA/marketdata.csv'  CSV HEADER
\\copy orders      (id,instrumentid,userid,size,price,type,side,status,datetime) FROM PROGRAM 'cut -d, -f1-9 $DATA/orders.csv' CSV HEADER
SQL
}
load_sql_app() {
  cat <<SQL
CREATE TEMP TABLE lab_idx AS
  SELECT i.indexrelid::regclass::text AS name, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
   WHERE i.indrelid = 'app.orders'::regclass
     AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid);
SELECT format('DROP INDEX %s', name) FROM lab_idx \\gexec
ALTER TABLE app.orders DISABLE TRIGGER orders_guard;
\\copy app.users       (id,email,accountnumber)                                 FROM '$DATA/users.csv'       CSV HEADER
\\copy app.instruments (id,ticker,name,type)                                    FROM '$DATA/instruments.csv' CSV HEADER
\\copy app.marketdata  (id,instrumentid,high,low,open,close,previousclose,date) FROM '$DATA/marketdata.csv'  CSV HEADER
\\copy app.orders      (id,instrumentid,userid,size,price,type,side,status,datetime,balance_seq,cancel_reason) FROM PROGRAM 'awk -f /lab/load/orders-a.awk $DATA/orders.csv' CSV
SET LOCAL maintenance_work_mem = '128MB';
SELECT def FROM lab_idx \\gexec
ALTER TABLE app.orders ENABLE TRIGGER orders_guard;
DO \$\$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s %s: %s', userid, problem, detail), '; ') INTO bad
    FROM (SELECT * FROM app.verify_ledger() WHERE userid >= 1000 LIMIT 20) p;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'la historia cargada no verifica: %', bad; END IF;
END \$\$;
SQL
}
load_sql_common() {
  cat <<SQL
SELECT setval(pg_get_serial_sequence('$SCHEMA.users', 'id'), (SELECT max(id) FROM $SCHEMA.users));
SELECT setval(pg_get_serial_sequence('$SCHEMA.instruments', 'id'), (SELECT max(id) FROM $SCHEMA.instruments));
SELECT setval(pg_get_serial_sequence('$SCHEMA.marketdata', 'id'), (SELECT max(id) FROM $SCHEMA.marketdata));
SELECT setval(pg_get_serial_sequence('$SCHEMA.orders', 'id'), (SELECT max(id) FROM $SCHEMA.orders));
CREATE TABLE public.lab_dataset (sha256 text PRIMARY KEY, loaded_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.lab_dataset (sha256) VALUES ('$SHA');
SQL
}

loaded="$(psql -At -c "SELECT sha256 FROM public.lab_dataset" 2>/dev/null || true)"
if [ -n "$loaded" ] && [ "$loaded" != "$SHA" ]; then
  echo "la base tiene el dataset $loaded y el de /data es $SHA: recrearla (docker compose down -v)" >&2
  exit 1
fi

if [ -z "$loaded" ]; then
  T0=$(date +%s)
  log "carga, en una transacción"
  case "$VARIANT" in z) load_sql_z ;; *) load_sql_app ;; esac | { cat; load_sql_common; } | psql -1 -o /dev/null
  psql -c "VACUUM (ANALYZE) $SCHEMA.orders" -c "ANALYZE $SCHEMA.marketdata" -c "ANALYZE $SCHEMA.users" -c "ANALYZE $SCHEMA.instruments"
  log "dataset $SHA cargado en $(( $(date +%s) - T0 )) s"
else
  log "dataset $SHA ya cargado"
fi

if [ "$VARIANT" = c ]; then
  log "funciones de C y calentamiento"
  psql -f /lab/c/snapshot.sql
  T0=$(date +%s)
  psql -At <<'SQL'
SELECT count(*) FILTER (WHERE app.c_publish(u.userid, true)) AS publicados
  FROM (SELECT DISTINCT o.userid FROM app.orders o WHERE o.status = 'FILLED' ORDER BY 1) u;
SQL
  psql -c "ANALYZE app.balance_snapshots" -c "ANALYZE app.snapshot_positions"
  log "calentamiento en $(( $(date +%s) - T0 )) s"
  diff="$(psql -At <<'SQL'
SELECT count(*) FROM app.users u
 WHERE EXISTS (SELECT kind, instrumentid, qty, cost_total, inconsistent, cash_cents, last_seq, filled_count FROM app.c_state(u.id)
               EXCEPT SELECT kind, instrumentid, qty, cost_total, inconsistent, cash_cents, last_seq, filled_count FROM app.c_state_full(u.id))
    OR EXISTS (SELECT kind, instrumentid, qty, cost_total, inconsistent, cash_cents, last_seq, filled_count FROM app.c_state_full(u.id)
               EXCEPT SELECT kind, instrumentid, qty, cost_total, inconsistent, cash_cents, last_seq, filled_count FROM app.c_state(u.id));
SQL
)"
  [ "$diff" = 0 ] || { echo "reconciliación: $diff usuario(s) con snapshot + delta distinto del fold completo" >&2; exit 1; }
  log "reconciliación: snapshot + delta = fold completo para todos los usuarios"
fi
