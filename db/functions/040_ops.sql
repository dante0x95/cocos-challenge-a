-- 040 — Operación: limpieza de idempotencia, verificación de la historia, salud. Repetible.

-- Limpieza de claves de idempotencia vencidas (D-19). Solo recupera espacio: una clave vencida
-- que el job todavía no borró ya no da replay ni 422, porque place_order la reusa. El job pide
-- los usuarios con claves para borrar y limpia cada uno en su propia transacción, con try-lock:
-- nunca borra una clave en medio de un replay en curso (el replay corre bajo el mismo lock) y
-- nunca hace esperar a un escritor.
--
-- Borra una clave 1 minuto después de que vence, no apenas vence. place_order decide con el
-- now() del inicio de su transacción, y antes del lock de usuario puede esperar la barrera de
-- despliegue: un request que empezó con la clave viva la tiene que encontrar al llegar al lock,
-- aunque la limpieza corra mientras espera. Una escritura dura a lo sumo el statement_timeout
-- del rol api (5 s, D-20); el minuto lo cubre con margen.
CREATE OR REPLACE FUNCTION app.idempotency_purge_age() RETURNS interval
LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT app.idempotency_ttl() + interval '1 minute'
$$;

CREATE OR REPLACE FUNCTION app.cleanup_candidates()
RETURNS TABLE (userid int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT DISTINCT k.userid FROM app.idempotency_keys k WHERE k.created_at < now() - app.idempotency_purge_age()
$$;

CREATE OR REPLACE FUNCTION app.cleanup_idempotency(p_userid int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT app.try_lock_user(p_userid) THEN RETURN 0; END IF;   -- escritura en curso: próxima pasada
  DELETE FROM app.idempotency_keys
   WHERE userid = p_userid AND created_at < now() - app.idempotency_purge_age();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Verificación de la historia, la corre el bootstrap después de migrar. Una sola pasada del
-- fold por usuario (los que tienen órdenes FILLED o NEW). Informa:
--   'cash'     el cash del fold no coincide con una suma directa de importes (cálculo
--              independiente del fold). El bootstrap aborta.
--   'short'    una posición queda en corto (historia heredada, D-01). Se tolera y se señala.
--   'overflow' la historia no entra en los tipos (22003 en el fold: importe, cash o costo por
--              encima de los tipos, D-14). Se informa en vez de abortar el bootstrap entero: ese
--              usuario no puede operar hasta que se corrija su historia; los demás, sí.
--   'reserva'  las LIMIT NEW no tienen respaldo: cash reservado por compras > cash del fold,
--              acciones reservadas por ventas de un instrumento > tenencia, o una NEW sobre una
--              MONEDA. Solo puede venir de una base preexistente (D-24): place_order no las crea.
--              El bootstrap las cancela con cancel_reason = 'UNBACKED' (cancel_unbacked) y lo
--              registra, en vez de abortar; una NEW es una decisión pendiente, no un hecho (D-12).
CREATE OR REPLACE FUNCTION app.verify_ledger()
RETURNS TABLE (userid int, problem text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE u int; fold_cash bigint; sum_cash bigint; res_cash numeric; r record; shorts text[];
        a_inst int[]; a_qty bigint[];
BEGIN
  FOR u IN SELECT DISTINCT o.userid FROM app.orders o WHERE o.status IN ('FILLED', 'NEW') ORDER BY 1 LOOP
    fold_cash := NULL; shorts := '{}'; a_inst := '{}'; a_qty := '{}';
    BEGIN
      FOR r IN SELECT s.kind, s.instrumentid, s.qty, s.cash_cents FROM app.c_state(u) s LOOP
        IF r.kind = 0 THEN
          fold_cash := r.cash_cents;
        ELSE
          a_inst := a_inst || r.instrumentid; a_qty := a_qty || r.qty;
          IF r.qty < 0 THEN
            shorts := shorts || format('instrumento %s en %s: historia con venta sin tenencia (se tolera y se señala, D-01)', r.instrumentid, r.qty);
          END IF;
        END IF;
      END LOOP;
    EXCEPTION WHEN numeric_value_out_of_range THEN
      userid := u; problem := 'overflow'; detail := SQLERRM;
      RETURN NEXT;
      CONTINUE;
    END;
    SELECT COALESCE(sum(CASE o.side WHEN 'CASH_IN' THEN 1 WHEN 'SELL' THEN 1 ELSE -1 END
                        * (o.size::numeric * o.price * 100)), 0)::bigint
      INTO sum_cash FROM app.orders o WHERE o.userid = u AND o.status = 'FILLED';
    IF fold_cash IS DISTINCT FROM sum_cash THEN
      userid := u; problem := 'cash'; detail := format('fold %s ≠ suma %s (centavos)', fold_cash, sum_cash);
      RETURN NEXT;
    END IF;
    FOREACH detail IN ARRAY shorts LOOP
      userid := u; problem := 'short';
      RETURN NEXT;
    END LOOP;
    -- Reservas de las NEW (issue #6), contra el cash y las posiciones de la misma pasada del fold.
    SELECT COALESCE(sum(o.size::numeric * o.price * 100), 0) INTO res_cash
      FROM app.orders o WHERE o.userid = u AND o.status = 'NEW' AND o.side = 'BUY';
    -- Sin compras NEW no hay nada que respaldar, aunque el cash heredado sea negativo.
    IF res_cash > 0 AND res_cash > fold_cash THEN
      userid := u; problem := 'reserva';
      -- trunc, no un cast acotado: una reserva heredada puede no entrar en numeric(20,0).
      detail := format('cash reservado %s > cash %s (centavos): compra LIMIT pendiente sin respaldo', trunc(res_cash), fold_cash);
      RETURN NEXT;
    END IF;
    FOR r IN SELECT x.instrumentid, x.reserved, COALESCE(p.q, 0) AS qty
               FROM (SELECT o.instrumentid, sum(o.size) AS reserved FROM app.orders o
                      WHERE o.userid = u AND o.status = 'NEW' AND o.side = 'SELL' GROUP BY o.instrumentid) x
               LEFT JOIN unnest(a_inst, a_qty) AS p(i, q) ON p.i = x.instrumentid
              WHERE x.reserved > COALESCE(p.q, 0) ORDER BY 1 LOOP
      userid := u; problem := 'reserva';
      detail := format('instrumento %s: %s acciones reservadas > tenencia %s: venta LIMIT pendiente sin respaldo', r.instrumentid, r.reserved, r.qty);
      RETURN NEXT;
    END LOOP;
    FOR r IN SELECT o.id, i.ticker FROM app.orders o JOIN app.instruments i ON i.id = o.instrumentid
              WHERE o.userid = u AND o.status = 'NEW' AND i.type = 'MONEDA' ORDER BY o.id LOOP
      userid := u; problem := 'reserva';
      detail := format('orden %s pendiente sobre la moneda %s: BUY/SELL no aplica sobre una moneda', r.id, r.ticker);
      RETURN NEXT;
    END LOOP;
  END LOOP;
END $$;

-- Cancela las LIMIT NEW sin respaldo de un usuario (cancel_reason = 'UNBACKED') y devuelve sus
-- ids, en orden de id. Lo llama el bootstrap para cada usuario que verify_ledger señala con
-- 'reserva' (D-24), dentro de su transacción. Con la barrera de despliegue tomada no entra
-- ninguna escritura entre verify_ledger y esta función, pero igual decide con el estado que lee
-- bajo el lock del usuario, como toda escritura (D-17). Recorre las NEW por id y conserva cada una que tenga respaldo (limit_backed)
-- descontando lo que reservan las conservadas antes (las de id menor que siguen NEW): queda lo
-- que el executor ejecutaría si todas cruzaran ahora, en orden de id, y lo reservado vuelve a
-- caber en el cash y en la tenencia, el invariante que place_order mantiene en régimen. Con
-- tenencia 10 y dos SELL NEW de 10 queda la primera; con una SELL de 100 y después una de 10,
-- queda la de 10.
CREATE OR REPLACE FUNCTION app.cancel_unbacked(p_userid int)
RETURNS TABLE (order_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp SET lock_timeout = '2s' AS $$
DECLARE o app.orders%ROWTYPE; v_cash bigint; pos_qty bigint; a_inst int[]; a_qty bigint[]; kept record;
BEGIN
  PERFORM app.deploy_barrier();
  PERFORM app.lock_user(p_userid);
  -- Una pasada del fold: el cash y todas las posiciones.
  SELECT max(s.cash_cents)      FILTER (WHERE s.kind = 0),
         array_agg(s.instrumentid) FILTER (WHERE s.kind = 1),
         array_agg(s.qty)          FILTER (WHERE s.kind = 1)
    INTO v_cash, a_inst, a_qty
    FROM app.c_state(p_userid) s;
  FOR o IN SELECT * FROM app.orders x WHERE x.userid = p_userid AND x.status = 'NEW' ORDER BY x.id LOOP
    pos_qty := COALESCE((SELECT p.q FROM unnest(a_inst, a_qty) AS p(i, q) WHERE p.i = o.instrumentid), 0);
    -- Lo que reservan las anteriores que se conservan: las canceladas en este recorrido ya no están NEW.
    SELECT COALESCE(sum(CASE WHEN x.side = 'BUY' THEN x.size::numeric * x.price * 100 END), 0)                    AS cash,
           COALESCE(sum(CASE WHEN x.side = 'SELL' AND x.instrumentid = o.instrumentid THEN x.size END), 0) AS shares
      INTO kept
      FROM app.orders x WHERE x.userid = p_userid AND x.status = 'NEW' AND x.id < o.id;
    IF NOT app.limit_backed(o, v_cash - kept.cash, pos_qty - kept.shares) THEN
      UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'UNBACKED' WHERE id = o.id;
      order_id := o.id;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- Estado para GET /health.
CREATE OR REPLACE FUNCTION app.health()
RETURNS TABLE (users bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT (SELECT count(*) FROM app.users)
$$;
