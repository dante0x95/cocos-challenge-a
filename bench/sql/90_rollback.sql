-- Fase 4 — Reversión documental de 10_migrate.sql, en orden inverso (A.1).
-- En Docker el rollback real es: cd bench/docker && docker compose down -v && docker compose up -d <perfil>
-- Este script existe para documentar el orden; NO deshace la transformación de datos
-- (cash x100 y balance_seq se pierden al borrar la columna; ver A.1 §1.3 y §7).
BEGIN;
DROP TRIGGER IF EXISTS orders_guard ON orders;
DROP FUNCTION IF EXISTS orders_guard();
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS idempotency_keys;
ALTER TABLE marketdata
  DROP CONSTRAINT IF EXISTS marketdata_one_per_day,
  DROP CONSTRAINT IF EXISTS marketdata_close_positive,
  ALTER COLUMN close TYPE numeric,
  ALTER COLUMN close DROP NOT NULL,
  ALTER COLUMN date DROP NOT NULL,
  ALTER COLUMN instrumentid DROP NOT NULL;
DROP INDEX IF EXISTS orders_new_by_user;
DROP INDEX IF EXISTS orders_filled_by_user;
DROP INDEX IF EXISTS orders_balance_seq;
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_seq_positive,
  DROP CONSTRAINT IF EXISTS orders_seq_iff_filled,
  DROP CONSTRAINT IF EXISTS orders_cash_shape,
  DROP CONSTRAINT IF EXISTS orders_pending_only_limit,
  DROP CONSTRAINT IF EXISTS orders_status_valid,
  DROP CONSTRAINT IF EXISTS orders_type_valid,
  DROP CONSTRAINT IF EXISTS orders_side_valid,
  DROP CONSTRAINT IF EXISTS orders_price_scale,
  DROP CONSTRAINT IF EXISTS orders_price_positive,
  DROP CONSTRAINT IF EXISTS orders_size_positive,
  ALTER COLUMN datetime DROP NOT NULL, ALTER COLUMN status DROP NOT NULL,
  ALTER COLUMN side DROP NOT NULL,     ALTER COLUMN type DROP NOT NULL,
  ALTER COLUMN price DROP NOT NULL,    ALTER COLUMN size DROP NOT NULL,
  ALTER COLUMN instrumentid DROP NOT NULL, ALTER COLUMN userid DROP NOT NULL,
  ALTER COLUMN price TYPE numeric,
  DROP COLUMN balance_seq;
-- Cash de vuelta a pesos (inverso de M.3):
UPDATE orders SET size = size / 100, price = 1
 WHERE side IN ('CASH_IN','CASH_OUT') AND price = 0.01;
COMMIT;
