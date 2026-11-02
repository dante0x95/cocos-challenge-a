-- Fase 3 / M.2 — Inventario por fold R.2, sin depender de balance_seq.
-- Uso: psql $PG -v ON_ERROR_STOP=1 -v mode=datetime -f bench/sql/01_inventory.sql
--   mode=datetime : orden (datetime, id)   -> inventario_antes (M.2)
--   mode=seq      : orden balance_seq      -> inventario_despues (M.5)
-- Define migr_inventory(mode) y la deja creada: 10_migrate.sql la reutiliza
-- y la borra al final.
--
-- Aritmética R.1/R.2 en numeric entero (exacto):
--   cash       en centavos        (importe = size * price * 100)
--   cost_total en micro-ARS       (importe_cents * 10^4)
--   SELL: cost = div_half_even(cost * (qty - s), qty); qty -= s; qty = 0 -> cost = 0
-- Venta en corto (s > qty): la POSICION queda marcada inconsistent = true,
-- cost = 0 y el fold continúa (D-001/D-002). La fila de cash (instrumentid NULL)
-- lleva el flag global: true si alguna posición del usuario lo está.

CREATE OR REPLACE FUNCTION migr_div_half_even(a numeric, b numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN 2 * mod(a, b) < b THEN div(a, b)
    WHEN 2 * mod(a, b) > b THEN div(a, b) + 1
    WHEN mod(div(a, b), 2) = 0 THEN div(a, b)
    ELSE div(a, b) + 1
  END
$$;

DROP FUNCTION IF EXISTS migr_inventory(text);
CREATE FUNCTION migr_inventory(p_mode text)
RETURNS TABLE (userid int, instrumentid int, qty numeric, cost_total numeric,
               cash_cents numeric, inconsistent boolean)
LANGUAGE plpgsql AS $$
DECLARE
  r      record;
  cur_u  int := NULL;
  cash   numeric := 0;
  quar   boolean := false;
  pos    jsonb := '{}';           -- instrumentid -> {q, c, bad}
  q      numeric;
  c      numeric;
  imp    numeric;                 -- importe en centavos
  k      text;
  bad    boolean;
BEGIN
  IF p_mode NOT IN ('datetime', 'seq') THEN
    RAISE EXCEPTION 'mode debe ser datetime o seq, no %', p_mode;
  END IF;

  FOR r IN EXECUTE format(
    'SELECT userid, instrumentid, side, size, price FROM orders
      WHERE status = %L ORDER BY userid, %s',
    'FILLED',
    CASE p_mode WHEN 'datetime' THEN 'datetime, id' ELSE 'balance_seq' END)
  LOOP
    IF cur_u IS DISTINCT FROM r.userid THEN
      IF cur_u IS NOT NULL THEN
        FOR k IN SELECT jsonb_object_keys(pos) LOOP
          userid := cur_u; instrumentid := k::int;
          qty := (pos->k->>'q')::numeric; cost_total := (pos->k->>'c')::numeric;
          cash_cents := cash; inconsistent := (pos->k->>'bad')::boolean;
          RETURN NEXT;
        END LOOP;
        userid := cur_u; instrumentid := NULL; qty := NULL; cost_total := NULL;
        cash_cents := cash; inconsistent := quar;
        RETURN NEXT;
      END IF;
      cur_u := r.userid; cash := 0; quar := false; pos := '{}';
    END IF;

    -- centavos, exacto: price tiene <= 2 decimales (auditado en M.1); el cast no redondea
    imp := (r.size::numeric * r.price * 100)::numeric(20,0);

    IF r.side = 'CASH_IN' THEN
      cash := cash + imp;
    ELSIF r.side = 'CASH_OUT' THEN
      cash := cash - imp;
    ELSE
      k := r.instrumentid::text;
      q := COALESCE((pos->k->>'q')::numeric, 0);
      c := COALESCE((pos->k->>'c')::numeric, 0);
      bad := COALESCE((pos->k->>'bad')::boolean, false);
      IF r.side = 'BUY' THEN
        cash := cash - imp;
        c := c + imp * 10000;
        q := q + r.size;
      ELSE  -- SELL
        cash := cash + imp;
        IF r.size > q THEN
          bad := true; quar := true;
          q := q - r.size; c := 0;
        ELSE
          c := migr_div_half_even(c * (q - r.size), q);
          q := q - r.size;
          IF q = 0 THEN c := 0; END IF;
        END IF;
      END IF;
      pos := pos || jsonb_build_object(k, jsonb_build_object('q', q, 'c', c, 'bad', bad));
    END IF;
  END LOOP;

  IF cur_u IS NOT NULL THEN
    FOR k IN SELECT jsonb_object_keys(pos) LOOP
      userid := cur_u; instrumentid := k::int;
      qty := (pos->k->>'q')::numeric; cost_total := (pos->k->>'c')::numeric;
      cash_cents := cash; inconsistent := (pos->k->>'bad')::boolean;
      RETURN NEXT;
    END LOOP;
    userid := cur_u; instrumentid := NULL; qty := NULL; cost_total := NULL;
    cash_cents := cash; inconsistent := quar;
    RETURN NEXT;
  END IF;
END $$;

\echo '=== M.2 inventario por usuario (modo :mode) ==='
SELECT userid,
       (cash_cents / 100)::numeric(18,2) AS cash_neto,
       inconsistent AS has_inconsistent_history
  FROM migr_inventory(:'mode') WHERE instrumentid IS NULL ORDER BY userid;

\echo '=== M.2 posiciones (cost_total en micro-ARS; costo_unitario solo para mostrar) ==='
SELECT i.userid, i.instrumentid, ins.ticker, i.qty, i.cost_total,
       CASE WHEN i.qty > 0 THEN round(i.cost_total / 1000000 / i.qty, 4) END AS costo_unitario,
       i.inconsistent
  FROM migr_inventory(:'mode') i JOIN instruments ins ON ins.id = i.instrumentid
 WHERE i.instrumentid IS NOT NULL ORDER BY 1, 2;

\echo '=== M.2 reservas y disponible ==='
WITH c AS (SELECT userid, cash_cents FROM migr_inventory(:'mode') WHERE instrumentid IS NULL),
     r AS (SELECT userid, COALESCE(sum(size::numeric * price * 100), 0) AS reserva_cents
             FROM orders WHERE status = 'NEW' AND side = 'BUY' GROUP BY userid)
SELECT c.userid,
       (c.cash_cents / 100)::numeric(18,2)                          AS cash_neto,
       (COALESCE(r.reserva_cents, 0) / 100)::numeric(18,2)          AS reservas,
       ((c.cash_cents - COALESCE(r.reserva_cents, 0)) / 100)::numeric(18,2) AS disponible
  FROM c LEFT JOIN r USING (userid) ORDER BY 1;

\echo '=== M.2 historia inconsistente (ventas en corto por el orden elegido) ==='
SELECT userid, instrumentid FROM migr_inventory(:'mode') WHERE inconsistent AND instrumentid IS NOT NULL ORDER BY 1, 2;
