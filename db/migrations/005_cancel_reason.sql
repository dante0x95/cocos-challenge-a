-- 005 — Motivo de una cancelación (issue #21).
--
-- Una orden CANCELLED dice por qué: `USER` (la canceló su dueño, cancel_order_outcome) o `LIMIT`
-- (el executor la canceló porque ejecutarla violaría D-14, execute_limit_outcome). Las dos
-- funciones lo escriben bajo el lock, en el mismo UPDATE que la cancela.
--
--   1. Columna cancel_reason y migración de las órdenes ya canceladas.
--   2. CHECKs: valor válido y presente si y solo si la orden está CANCELLED.
--   3. Trigger orders_guard: la misma regla en cada transición, con un mensaje propio. Una
--      cancelación sin motivo (la de una función anterior) falla con APP04, reintentable.
--
-- Migración de las ya canceladas: todas quedan `USER`. El motivo no se puede reconstruir:
--   · orders no guarda cuándo se canceló una orden, y el reporte del executor no se persiste.
--   · Recalcular la regla de D-14 con el estado de hoy no sirve: el cash y la posición que
--     decidieron la cancelación eran los de ese momento, y cambian con cada orden posterior.
-- Solo pueden ser `LIMIT` las canceladas por un executor desplegado entre el PR del issue #2
-- y este; antes de ese PR el executor no cancelaba. Para que una lo sea, el usuario tuvo que
-- tener un cash cercano a 10^15 ARS o una posición cercana a 2^62 acciones.

-- 1. Columna y migración --------------------------------------------------------------------
ALTER TABLE app.orders ADD COLUMN cancel_reason text;

-- El trigger prohíbe modificar una orden CANCELLED: se suspende solo para esta escritura,
-- dentro de la transacción de la migración (si algo falla, vuelve a estar activo).
ALTER TABLE app.orders DISABLE TRIGGER orders_guard;
UPDATE app.orders SET cancel_reason = 'USER' WHERE status = 'CANCELLED';
ALTER TABLE app.orders ENABLE TRIGGER orders_guard;

-- 2. CHECKs ------------------------------------------------------------------------------------
ALTER TABLE app.orders
  ADD CONSTRAINT orders_cancel_reason_valid      CHECK (cancel_reason IN ('USER','LIMIT')),
  ADD CONSTRAINT orders_cancel_reason_iff_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL));

-- 3. Trigger -----------------------------------------------------------------------------------
-- La de 003 más una regla: cancel_reason se escribe solo al pasar a CANCELLED y siempre en
-- ese paso. Como una orden que no está NEW es inmutable, una vez escrito ya no cambia.
CREATE OR REPLACE FUNCTION app.orders_guard() RETURNS trigger
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
  -- Cancelar sin motivo es lo que hacían las funciones anteriores. El bootstrap aplica esta
  -- migración y las funciones nuevas en una transacción con la barrera de despliegue exclusiva,
  -- pero un escritor que ya había entrado a la función anterior y esperaba la barrera sigue con
  -- ese cuerpo después del COMMIT. Falla con APP04 (VERSION_MISMATCH → 503): la API reintenta
  -- y el reintento usa la función nueva. Sin efectos: la transacción del escritor se revierte.
  IF NEW.status = 'CANCELLED' AND NEW.cancel_reason IS NULL THEN
    RAISE EXCEPTION 'orders_guard: cancelación sin cancel_reason (orden %): la escribió una versión anterior de las funciones', NEW.id
      USING ERRCODE = 'APP04';
  END IF;
  IF NEW.status <> 'CANCELLED' AND NEW.cancel_reason IS NOT NULL THEN
    RAISE EXCEPTION 'orders_guard: cancel_reason solo va en una orden CANCELLED (orden %, estado %, motivo %)',
      NEW.id, NEW.status, NEW.cancel_reason USING ERRCODE = 'integrity_constraint_violation';
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
