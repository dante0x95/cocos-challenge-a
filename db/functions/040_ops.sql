-- 040 — Operación: limpieza de idempotencia, verificación de la historia, salud. Repetible.

-- Limpieza de claves de idempotencia vencidas (D-19): created_at anterior a now() -
-- app.idempotency_ttl(), el mismo criterio con el que place_order las reusa. Solo recupera
-- espacio: una clave vencida que el job todavía no borró ya no da replay ni 422. El job pide
-- los usuarios con claves vencidas y limpia cada uno en su propia transacción, con try-lock:
-- nunca borra una clave en medio de un replay en curso (el replay corre bajo el mismo lock) y
-- nunca hace esperar a un escritor.
CREATE OR REPLACE FUNCTION app.cleanup_candidates()
RETURNS TABLE (userid int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT DISTINCT k.userid FROM app.idempotency_keys k WHERE k.created_at < now() - app.idempotency_ttl()
$$;

CREATE OR REPLACE FUNCTION app.cleanup_idempotency(p_userid int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT app.try_lock_user(p_userid) THEN RETURN 0; END IF;   -- escritura en curso: próxima pasada
  DELETE FROM app.idempotency_keys
   WHERE userid = p_userid AND created_at < now() - app.idempotency_ttl();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Verificación de la historia, la corre el bootstrap después de migrar. Compara, por usuario,
-- el cash del fold con una suma directa de importes (cálculo independiente del fold), y lista
-- las posiciones que quedan en corto (historia heredada, D-01). Una sola pasada del fold por
-- usuario. Una historia fuera de lo representable (22003 en el fold: importe o cash por encima
-- de los tipos, D-14) se informa como 'overflow' en vez de abortar el bootstrap entero: ese
-- usuario no puede operar hasta que se corrija su historia; los demás, sí.
CREATE OR REPLACE FUNCTION app.verify_ledger()
RETURNS TABLE (userid int, problem text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE u int; fold_cash bigint; sum_cash bigint; r record; shorts text[];
BEGIN
  FOR u IN SELECT DISTINCT o.userid FROM app.orders o WHERE o.status = 'FILLED' ORDER BY 1 LOOP
    fold_cash := NULL; shorts := '{}';
    BEGIN
      FOR r IN SELECT s.kind, s.instrumentid, s.qty, s.cash_cents FROM app.c_state(u) s LOOP
        IF r.kind = 0 THEN
          fold_cash := r.cash_cents;
        ELSIF r.qty < 0 THEN
          shorts := shorts || format('instrumento %s en %s: historia con venta sin tenencia (se tolera y se señala, D-01)', r.instrumentid, r.qty);
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
  END LOOP;
END $$;

-- Estado para GET /health.
CREATE OR REPLACE FUNCTION app.health()
RETURNS TABLE (users bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT (SELECT count(*) FROM app.users)
$$;
