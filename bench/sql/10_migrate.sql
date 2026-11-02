-- Fase 4 / M.3–M.6 — Migración consolidada (una sola transacción).
-- Uso: psql $PG -v ON_ERROR_STOP=1 -v ars_id=66 -f bench/sql/10_migrate.sql
-- Prerrequisitos: 00_audit.sql terminó sin excepción (M.1).
-- Se ejecuta UNA vez sobre un contenedor fresco. Rollback real: down -v && up.
-- Orden: M.2 inventario antes -> M.3 cash a centavos -> M.4 backfill balance_seq
--        -> M.5 inventario después == antes -> M.6 esquema (trigger al final).

\set ON_ERROR_STOP on
\set mode datetime
\ir 01_inventory.sql

BEGIN;

\echo '=== M.1 guard: ars_id ==='
-- Las variables de psql no se interpolan dentro de $$...$$; se pasa por GUC de sesión.
SELECT set_config('migr.ars_id', :'ars_id', true);
DO $$
DECLARE n int; real_ars int; given int := current_setting('migr.ars_id')::int;
BEGIN
  SELECT count(*), min(id) INTO n, real_ars FROM instruments WHERE ticker = 'ARS';
  IF n <> 1 THEN RAISE EXCEPTION 'M.1: se esperaba 1 instrumento ARS, hay %', n; END IF;
  IF real_ars <> given THEN
    RAISE EXCEPTION 'M.1: ars_id pasado (%) no coincide con el real (%)', given, real_ars;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'orders' AND column_name = 'balance_seq') THEN
    RAISE EXCEPTION 'M.4: orders.balance_seq ya existe; esta base ya fue migrada. Rollback: down -v && up';
  END IF;
END $$;

\echo '=== M.2 inventario antes (orden datetime, id) ==='
CREATE TEMP TABLE inv_before ON COMMIT DROP AS
  SELECT * FROM migr_inventory('datetime');

\echo '=== M.3 cash a centavos ==='
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM orders
   WHERE side IN ('CASH_IN','CASH_OUT') AND size::bigint * 100 > 2147483647;
  IF n > 0 THEN RAISE EXCEPTION 'M.3: % movimiento(s) cash desbordan integer al x100', n; END IF;
END $$;
UPDATE orders SET size = size * 100, price = 0.01
 WHERE side IN ('CASH_IN','CASH_OUT') AND price = 1;
SELECT id, side, size, price FROM orders WHERE side IN ('CASH_IN','CASH_OUT') ORDER BY id;

\echo '=== M.4 backfill balance_seq por (datetime, id) ==='
ALTER TABLE orders ADD COLUMN balance_seq bigint;
WITH n AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY userid ORDER BY datetime, id) AS seq
    FROM orders WHERE status = 'FILLED')
UPDATE orders o SET balance_seq = n.seq FROM n WHERE o.id = n.id;

\echo '--- M.4 historia inconsistente (D-001: se reporta, no bloquea) ---'
SELECT userid, instrumentid, qty FROM inv_before
 WHERE inconsistent AND instrumentid IS NOT NULL ORDER BY 1, 2;

\echo '=== M.5 inventario después (orden balance_seq) == antes ==='
CREATE TEMP TABLE inv_after ON COMMIT DROP AS
  SELECT * FROM migr_inventory('seq');
DO $$
DECLARE n_diff bigint; n_null bigint;
BEGIN
  SELECT count(*) INTO n_null FROM orders WHERE status = 'FILLED' AND balance_seq IS NULL;
  IF n_null > 0 THEN RAISE EXCEPTION 'M.4: % FILLED sin balance_seq', n_null; END IF;

  SELECT count(*) INTO n_diff FROM (
    (SELECT * FROM inv_before EXCEPT SELECT * FROM inv_after)
    UNION ALL
    (SELECT * FROM inv_after EXCEPT SELECT * FROM inv_before)) d;
  IF n_diff > 0 THEN
    RAISE EXCEPTION 'M.5: inventario antes y después difieren en % fila(s). ROLLBACK.', n_diff;
  END IF;
  RAISE NOTICE 'M.5 OK: inventario idéntico antes y después';
END $$;

WITH c AS (SELECT userid, cash_cents FROM inv_after WHERE instrumentid IS NULL),
     r AS (SELECT userid, COALESCE(sum(size::numeric * price * 100), 0) AS reserva_cents
             FROM orders WHERE status = 'NEW' AND side = 'BUY' GROUP BY userid)
SELECT c.userid,
       (c.cash_cents / 100)::numeric(18,2) AS cash_neto,
       (COALESCE(r.reserva_cents, 0) / 100)::numeric(18,2) AS reservas,
       ((c.cash_cents - COALESCE(r.reserva_cents, 0)) / 100)::numeric(18,2) AS disponible
  FROM c LEFT JOIN r USING (userid) ORDER BY 1;

\echo '=== M.6 esquema: orders — tipos y NOT NULL (A.1 §1.1, 1.2) ==='
ALTER TABLE orders
  ALTER COLUMN price TYPE numeric(18,2),
  ALTER COLUMN userid SET NOT NULL, ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN size SET NOT NULL,   ALTER COLUMN price SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,   ALTER COLUMN side SET NOT NULL,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN datetime SET NOT NULL;

\echo '=== M.6 esquema: orders — CHECKs (A.1 §1.4–1.11) ==='
ALTER TABLE orders
  ADD CONSTRAINT orders_size_positive      CHECK (size > 0),
  ADD CONSTRAINT orders_price_positive     CHECK (price > 0),
  ADD CONSTRAINT orders_price_scale        CHECK (price = round(price, 2)),
  ADD CONSTRAINT orders_side_valid         CHECK (side IN ('BUY','SELL','CASH_IN','CASH_OUT')),
  ADD CONSTRAINT orders_type_valid         CHECK (type IN ('MARKET','LIMIT')),
  ADD CONSTRAINT orders_status_valid       CHECK (status IN ('NEW','FILLED','REJECTED','CANCELLED')),
  ADD CONSTRAINT orders_pending_only_limit CHECK (status NOT IN ('NEW','CANCELLED') OR type = 'LIMIT'),
  ADD CONSTRAINT orders_cash_shape CHECK (
    side NOT IN ('CASH_IN','CASH_OUT')
    OR (type = 'MARKET' AND price = 0.01 AND instrumentid = :ars_id)),
  ADD CONSTRAINT orders_seq_iff_filled     CHECK ((status = 'FILLED') = (balance_seq IS NOT NULL)),
  ADD CONSTRAINT orders_seq_positive       CHECK (balance_seq IS NULL OR balance_seq > 0);

\echo '=== M.6 esquema: orders — índices (A.1 §1.12–1.14) ==='
CREATE UNIQUE INDEX orders_balance_seq ON orders (userid, balance_seq)
  WHERE balance_seq IS NOT NULL;
CREATE INDEX orders_filled_by_user ON orders (userid, balance_seq)
  INCLUDE (instrumentid, side, size, price) WHERE status = 'FILLED';
CREATE INDEX orders_new_by_user ON orders (userid)
  INCLUDE (instrumentid, side, size, price) WHERE status = 'NEW';

\echo '=== M.6 esquema: marketdata (A.1 §2.1–2.4) ==='
-- Duplicados (instrumentid, date): regla declarada, se conserva el mayor id.
DELETE FROM marketdata m
 USING marketdata m2
 WHERE m.instrumentid = m2.instrumentid AND m.date = m2.date AND m.id < m2.id;
ALTER TABLE marketdata
  ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN close SET NOT NULL,
  ALTER COLUMN close TYPE numeric(18,2),
  ADD CONSTRAINT marketdata_close_positive CHECK (close > 0),
  ADD CONSTRAINT marketdata_one_per_day UNIQUE (instrumentid, date);

\echo '=== M.6 esquema: tablas nuevas (A.1 §3.1, 3.2) ==='
CREATE TABLE idempotency_keys (
  userid        integer NOT NULL REFERENCES users(id),
  key           text    NOT NULL,
  request_hash  text    NOT NULL,
  order_id      integer REFERENCES orders(id),
  http_status   smallint,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, key)
);
CREATE INDEX idempotency_keys_created_at ON idempotency_keys (created_at);

CREATE TABLE settings (
  id                  boolean  PRIMARY KEY DEFAULT true CHECK (id),
  active_algo_version smallint NOT NULL
);
INSERT INTO settings (active_algo_version) VALUES (1);

\echo '=== M.6 esquema: trigger orders_guard, AL FINAL (A.1 §1.15) ==='
CREATE FUNCTION orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders_guard: DELETE prohibido (orden %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'NEW' THEN
      RAISE EXCEPTION 'orders_guard: orden % en estado % es inmutable', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status NOT IN ('FILLED','CANCELLED') THEN
      RAISE EXCEPTION 'orders_guard: NEW solo puede pasar a FILLED o CANCELLED (orden %, destino %)',
        OLD.id, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.id <> OLD.id OR NEW.userid <> OLD.userid OR NEW.instrumentid <> OLD.instrumentid
       OR NEW.size <> OLD.size OR NEW.price <> OLD.price OR NEW.type <> OLD.type
       OR NEW.side <> OLD.side OR NEW.datetime <> OLD.datetime THEN
      RAISE EXCEPTION 'orders_guard: al cambiar de estado no se modifica ningún otro campo (orden %)', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- INSERT o UPDATE que termina en FILLED: balance_seq = MAX + 1 del usuario.
  IF NEW.status = 'FILLED' THEN
    SELECT COALESCE(max(balance_seq), 0) INTO last_seq FROM orders WHERE userid = NEW.userid;
    IF NEW.balance_seq IS DISTINCT FROM last_seq + 1 THEN
      RAISE EXCEPTION 'orders_guard: balance_seq debe ser % para el usuario %, recibido %',
        last_seq + 1, NEW.userid, NEW.balance_seq USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER orders_guard
  BEFORE INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard();

\echo '=== limpieza de funciones de migración ==='
DROP FUNCTION migr_inventory(text);
DROP FUNCTION migr_div_half_even(numeric, numeric);

COMMIT;
\echo '=== MIGRACIÓN APLICADA ==='
