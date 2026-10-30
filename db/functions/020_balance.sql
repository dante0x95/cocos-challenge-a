-- 020 — Cálculo del balance: se recorren todas las órdenes ejecutadas del usuario (D-16).
-- Repetible.
--
-- app.c_state es la ÚNICA implementación del fold en el sistema. La usan la lectura del
-- portfolio, la autorización de órdenes y la verificación de la historia.
-- La única otra implementación es el oráculo de los tests (test/oracle/fold.ts), escrito
-- aparte a propósito para que un bug compartido no pase inadvertido (D-22).

-- Estado de un usuario, calculado desde orders: los FILLED en orden de balance_seq.
-- Devuelve:
--   kind 0, una fila: cash_cents, last_seq (máxima secuencia vista), filled_count,
--           inconsistent = la historia tuvo alguna venta sin tenencia.
--   kind 1, una fila por instrumento con qty <> 0: qty, cost_total (micro-ARS),
--           inconsistent = la posición está en corto ahora (qty < 0).
--
-- Reglas del fold, por instrumento y en orden de balance_seq (D-09, D-03):
--   BUY  s @ p: si qty ≥ 0, costo += s·p. Si qty < 0 (corto heredado), las primeras −qty
--               acciones cubren el corto sin costo; solo el excedente suma costo.
--   SELL s @ p: si s ≤ qty, costo = half_even(costo · (qty − s) / qty). Si s > qty (solo
--               posible en historia heredada), qty queda negativa y costo = 0.
--   qty ≤ 0 → costo = 0.
-- Unidades: cash en centavos, costo en micro-ARS (10^-6 ARS), todo entero en numeric.
CREATE OR REPLACE FUNCTION app.c_state(p_userid int)
RETURNS TABLE (kind smallint, instrumentid int, qty bigint, cost_total bigint, inconsistent boolean,
               cash_cents bigint, last_seq bigint, filled_count int)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  cash     numeric := 0;
  seen     bigint := 0;
  n_filled int := 0;
  any_bad  boolean := false;
  r        record;
  cur_i    int := NULL;
  q        numeric := 0;
  c        numeric := 0;
  bad      boolean := false;
  imp      numeric;
BEGIN
  FOR r IN
    SELECT o.instrumentid, o.balance_seq AS seq, o.side, o.size, o.price
      FROM app.orders o
     WHERE o.userid = p_userid AND o.status = 'FILLED'
    ORDER BY instrumentid, seq
  LOOP
    n_filled := n_filled + 1;
    IF r.seq > seen THEN seen := r.seq; END IF;
    imp := (r.size::numeric * r.price * 100)::numeric(20,0);      -- centavos; price tiene 2 decimales
    IF r.side IN ('CASH_IN','SELL') THEN cash := cash + imp; ELSE cash := cash - imp; END IF;
    IF r.side IN ('CASH_IN','CASH_OUT') THEN CONTINUE; END IF;    -- el cash no es una posición

    IF cur_i IS DISTINCT FROM r.instrumentid THEN
      IF cur_i IS NOT NULL AND q <> 0 THEN
        kind := 1; instrumentid := cur_i; qty := q; cost_total := c; inconsistent := bad;
        cash_cents := NULL; last_seq := NULL; filled_count := NULL;
        RETURN NEXT;
      END IF;
      cur_i := r.instrumentid; q := 0; c := 0; bad := false;
    END IF;

    IF r.side = 'BUY' THEN
      IF q < 0 THEN
        c := GREATEST(r.size + q, 0) * r.price * 100 * 10000;   -- cubrir el corto no lleva costo (D-03)
      ELSE
        c := c + imp * 10000;
      END IF;
      q := q + r.size;
      IF q <= 0 THEN c := 0; END IF;
    ELSIF r.size > q THEN                                       -- venta sin tenencia: solo historia heredada (D-01)
      any_bad := true; q := q - r.size; c := 0;
    ELSE
      c := app.div_half_even(c * (q - r.size), q);
      q := q - r.size;
      IF q = 0 THEN c := 0; END IF;
    END IF;
    bad := q < 0;
  END LOOP;
  IF cur_i IS NOT NULL AND q <> 0 THEN
    kind := 1; instrumentid := cur_i; qty := q; cost_total := c; inconsistent := bad;
    cash_cents := NULL; last_seq := NULL; filled_count := NULL;
    RETURN NEXT;
  END IF;

  kind := 0; instrumentid := NULL; qty := NULL; cost_total := NULL; inconsistent := any_bad;
  cash_cents := cash::bigint; last_seq := seen; filled_count := n_filled;
  RETURN NEXT;
END $$;

-- Lectura del portfolio. Sin lock: una sentencia, una foto MVCC de las órdenes (la función
-- es STABLE: todo lo que lee adentro usa la foto de la sentencia que la llama).
-- Columnas tipadas (sin JSON); la API arma la respuesta con BigInt (src/domain/portfolio.ts).
--   kind 0: qty = cash en centavos; reserved = centavos reservados por BUY NEW;
--           inconsistent = la historia tuvo alguna venta sin tenencia.
--   kind 1: una fila por posición; reserved = acciones reservadas por SELL NEW; close,
--           previousclose y price_date de la última cotización válida (NULL si no hay).
-- Usuario inexistente → APP06. c_state emite la fila kind 0 (cash 0) también para un id que
-- no existe; sin este chequeo, la API necesitaría otra consulta para responder 404 (issue #5).
CREATE OR REPLACE FUNCTION app.read_portfolio(p_userid int)
RETURNS TABLE (kind smallint, instrumentid int, ticker text, name text,
               qty bigint, cost_total bigint, inconsistent boolean,
               reserved bigint, close numeric, previousclose numeric, price_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.users u WHERE u.id = p_userid) THEN
    RAISE EXCEPTION 'usuario % inexistente', p_userid USING ERRCODE = 'APP06';
  END IF;
  RETURN QUERY
  WITH f AS (SELECT * FROM app.c_state(p_userid)),
       res AS (
         SELECT o.instrumentid,
                sum(CASE WHEN o.side = 'BUY'  THEN (o.size::numeric * o.price * 100) ELSE 0 END)::bigint AS cash_cents,
                sum(CASE WHEN o.side = 'SELL' THEN o.size ELSE 0 END)::bigint AS shares
           FROM app.orders o
          WHERE o.userid = p_userid AND o.status = 'NEW'
          GROUP BY o.instrumentid)
  SELECT 0::smallint, NULL::int, NULL::text, NULL::text,
         f.cash_cents, 0::bigint, f.inconsistent,
         COALESCE((SELECT sum(cash_cents) FROM res), 0)::bigint, NULL::numeric, NULL::numeric, NULL::date
    FROM f WHERE f.kind = 0
  UNION ALL
  SELECT 1::smallint, f.instrumentid, i.ticker::text, i.name::text,
         f.qty, f.cost_total, f.inconsistent,
         COALESCE(res.shares, 0), vc.close, vc.previousclose, vc.price_date
    FROM f
    JOIN app.instruments i ON i.id = f.instrumentid
    LEFT JOIN res ON res.instrumentid = f.instrumentid
    LEFT JOIN LATERAL app.valid_close(f.instrumentid) vc ON true
   WHERE f.kind = 1
   ORDER BY 1, 2;
END $$;
