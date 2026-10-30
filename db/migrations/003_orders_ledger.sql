-- 003 — `orders` como libro contable: cash en centavos, orden de ejecución, invariantes.
--
-- Corre una sola vez (el bootstrap lo registra en schema_migrations), en una transacción:
-- si cualquier paso falla, la base queda como estaba.
--
--   1. Cash a centavos (D-05): CASH_IN/CASH_OUT pasan de (size = pesos, price = 1) a
--      (size = centavos, price = 0.01). size · price no cambia; ahora admite centavos.
--   2. balance_seq (D-04, D-18): número de ejecución por usuario. Los FILLED heredados se
--      numeran por (datetime, id); de acá en más la asigna la función que ejecuta la orden.
--   3. Tipos, NOT NULL, CHECKs e índices: lo que la auditoría 002 verificó, ahora impuesto.
--   4. marketdata: una cotización por instrumento y día (D-07).
--   5. Tablas nuevas: idempotency_keys (D-19) y settings.
--   6. Trigger orders_guard, al final, para que no vea la transformación de los pasos 1–2.

-- 1. Cash a centavos ------------------------------------------------------------------
UPDATE app.orders SET size = size * 100, price = 0.01
 WHERE side IN ('CASH_IN','CASH_OUT') AND price = 1;

-- 2. balance_seq -----------------------------------------------------------------------
ALTER TABLE app.orders ADD COLUMN balance_seq bigint;

WITH n AS (
  SELECT id, row_number() OVER (PARTITION BY userid ORDER BY datetime, id) AS seq
    FROM app.orders WHERE status = 'FILLED')
UPDATE app.orders o SET balance_seq = n.seq FROM n WHERE o.id = n.id;

-- 3. orders: tipos, nulabilidad, dominios ------------------------------------------------
ALTER TABLE app.orders
  ALTER COLUMN price TYPE numeric(18,2),
  ALTER COLUMN userid SET NOT NULL, ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN size SET NOT NULL,   ALTER COLUMN price SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,   ALTER COLUMN side SET NOT NULL,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN datetime SET NOT NULL;

ALTER TABLE app.orders
  ADD CONSTRAINT orders_size_positive      CHECK (size > 0),
  ADD CONSTRAINT orders_price_positive     CHECK (price > 0),
  ADD CONSTRAINT orders_side_valid         CHECK (side IN ('BUY','SELL','CASH_IN','CASH_OUT')),
  ADD CONSTRAINT orders_type_valid         CHECK (type IN ('MARKET','LIMIT')),
  ADD CONSTRAINT orders_status_valid       CHECK (status IN ('NEW','FILLED','REJECTED','CANCELLED')),
  ADD CONSTRAINT orders_pending_only_limit CHECK (status NOT IN ('NEW','CANCELLED') OR type = 'LIMIT'),
  ADD CONSTRAINT orders_seq_iff_filled     CHECK ((status = 'FILLED') = (balance_seq IS NOT NULL)),
  ADD CONSTRAINT orders_seq_positive       CHECK (balance_seq IS NULL OR balance_seq > 0);

-- Un movimiento cash es MARKET, sobre ARS y a 0.01. El id de ARS se resuelve acá
-- (la auditoría ya verificó que hay exactamente uno) y queda como constante en el CHECK.
DO $$
DECLARE ars int;
BEGIN
  SELECT id INTO ars FROM app.instruments WHERE ticker = 'ARS';
  EXECUTE format(
    'ALTER TABLE app.orders ADD CONSTRAINT orders_cash_shape CHECK (
       side NOT IN (''CASH_IN'',''CASH_OUT'') OR (type = ''MARKET'' AND price = 0.01 AND instrumentid = %s))', ars);
END $$;

-- Índices parciales por status. Cada consulta que los usa filtra por el status exacto:
-- un `status IN (...)` no implica el predicado de un índice parcial y termina en seq scan.
CREATE UNIQUE INDEX orders_balance_seq ON app.orders (userid, balance_seq)
  WHERE balance_seq IS NOT NULL;
CREATE INDEX orders_filled_by_user ON app.orders (userid, balance_seq)
  INCLUDE (instrumentid, side, size, price) WHERE status = 'FILLED';
CREATE INDEX orders_new_by_user ON app.orders (userid)
  INCLUDE (instrumentid, side, size, price) WHERE status = 'NEW';

-- 4. marketdata ------------------------------------------------------------------------
DELETE FROM app.marketdata m
 USING app.marketdata m2
 WHERE m.instrumentid = m2.instrumentid AND m.date = m2.date AND m.id < m2.id;

ALTER TABLE app.marketdata
  ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN close SET NOT NULL,
  ALTER COLUMN close TYPE numeric(18,2),
  ALTER COLUMN previousclose TYPE numeric(18,2),
  ADD CONSTRAINT marketdata_close_positive CHECK (close > 0),
  ADD CONSTRAINT marketdata_one_per_day UNIQUE (instrumentid, date);

-- 5. Tablas nuevas ---------------------------------------------------------------------
CREATE TABLE app.idempotency_keys (
  userid        integer NOT NULL REFERENCES app.users(id),
  key           text    NOT NULL,
  request_hash  text    NOT NULL,
  order_id      integer REFERENCES app.orders(id),
  http_status   smallint,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, key)
);
CREATE INDEX idempotency_keys_created_at ON app.idempotency_keys (created_at);

CREATE TABLE app.settings (
  id                  boolean  PRIMARY KEY DEFAULT true CHECK (id),
  -- Antigüedad máxima de una cotización para considerarla válida. NULL = sin límite (D-06).
  price_max_age_days  integer CHECK (price_max_age_days IS NULL OR price_max_age_days > 0)
);
INSERT INTO app.settings DEFAULT VALUES;

-- 6. Trigger: inmutabilidad y secuencia --------------------------------------------------
-- Garantiza: FILLED/REJECTED/CANCELLED inmutables, NEW solo pasa a FILLED o CANCELLED sin
-- tocar otro campo, nada se borra, y balance_seq de un FILLED es exactamente MAX + 1.
-- NO garantiza que la autorización se haya tomado bajo el lock: dos escritores que leen
-- sin lock obtienen secuencias consecutivas válidas igual. Eso lo protege el protocolo (D-17).
CREATE FUNCTION app.orders_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE last_seq bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders_guard: DELETE prohibido (orden %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'NEW' THEN
      RAISE EXCEPTION 'orders_guard: la orden % en estado % es inmutable', OLD.id, OLD.status
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
  IF NEW.status = 'FILLED' THEN
    SELECT COALESCE(max(balance_seq), 0) INTO last_seq
      FROM app.orders WHERE userid = NEW.userid AND balance_seq IS NOT NULL;
    IF NEW.balance_seq IS DISTINCT FROM last_seq + 1 THEN
      RAISE EXCEPTION 'orders_guard: balance_seq debe ser % para el usuario %, recibido %',
        last_seq + 1, NEW.userid, NEW.balance_seq USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER orders_guard
  BEFORE INSERT OR UPDATE OR DELETE ON app.orders
  FOR EACH ROW EXECUTE FUNCTION app.orders_guard();
