-- v3 del lab (issue #72): la variante C del benchmark (docs/decision-snapshot.md), snapshot + delta.
-- Corre sobre la base de C después del bootstrap de la imagen de A y de la carga, en CADA arranque
-- (lab/load/load.sh): el bootstrap reinstala las funciones de A en cada `up`, así que esto vuelve a
-- poner las de C. Idempotente, en una transacción.
--
-- C = A + una caché del balance por usuario. Lo que cambia respecto de A es solo app.c_state, el
-- fold que usa app.read_portfolio (y place_order, que en v3 no se llama: el proxy responde 403 a
-- todo POST). La firma es la misma, así que la API de A atiende C sin cambios:
--   app.c_state_full   el fold de A tal cual lo instaló el bootstrap, renombrado: recorre toda la
--                      historia. Con él se publica el snapshot, así que la caché se calcula con la
--                      misma función que la lectura completa y se puede tirar y regenerar.
--   app.c_state        parte del snapshot del usuario (si hay) y aplica el delta: los FILLED con
--                      balance_seq > snapshot.last_seq. Sin snapshot, recorre toda la historia.
--   app.c_publish      publica el snapshot con c_state_full. Regla del benchmark: si el delta llega
--                      a K = settings.snapshot_k (500), o si no hay snapshot y hay historia; con
--                      p_force (el calentamiento), siempre que haya delta.
-- Las tablas siguen a la migración 004 del primer intento de C, con dos diferencias: cash y costo
-- en las unidades enteras del fold (centavos y micro-ARS, sin conversión al leer) y la cantidad de
-- FILLED del snapshot, para que c_state devuelva filled_count igual que A. Sin algo_version: el
-- lab tiene una sola versión del cálculo, y nada escribe órdenes en v3, así que no hace falta el
-- lock de usuario.
BEGIN;

CREATE TABLE IF NOT EXISTS app.balance_snapshots (
  userid           integer PRIMARY KEY REFERENCES app.users(id),
  last_seq         bigint  NOT NULL CHECK (last_seq > 0),
  cash_cents       bigint  NOT NULL,
  filled_count     integer NOT NULL CHECK (filled_count > 0),
  has_inconsistent boolean NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.snapshot_positions (
  userid       integer NOT NULL REFERENCES app.balance_snapshots(userid) ON DELETE CASCADE,
  instrumentid integer NOT NULL REFERENCES app.instruments(id),
  qty          bigint  NOT NULL CHECK (qty <> 0),
  cost_micro   numeric(24,0) NOT NULL CHECK (cost_micro >= 0),
  inconsistent boolean NOT NULL,
  PRIMARY KEY (userid, instrumentid)
);

ALTER TABLE app.settings ADD COLUMN IF NOT EXISTS snapshot_k integer NOT NULL DEFAULT 500 CHECK (snapshot_k >= 1);

-- El c_state que acaba de instalar el bootstrap es el de A (no lee el snapshot): pasa a ser el
-- fold completo. Si ya es el de C (este archivo corrió sin un bootstrap en el medio), queda.
DO $$
BEGIN
  IF position('balance_snapshots' IN (SELECT prosrc FROM pg_proc WHERE oid = 'app.c_state(int)'::regprocedure)) = 0 THEN
    DROP FUNCTION IF EXISTS app.c_state_full(int);
    ALTER FUNCTION app.c_state(int) RENAME TO c_state_full;
  END IF;
END $$;

-- Las mismas reglas del fold que app.c_state_full (db/functions/020_balance.sql), arrancando del
-- estado del snapshot en vez de cero. Por instrumento: primero la fila del snapshot (src 0), después
-- el delta en orden de balance_seq (src 1).
CREATE OR REPLACE FUNCTION app.c_state(p_userid int)
RETURNS TABLE (kind smallint, instrumentid int, qty bigint, cost_total numeric, inconsistent boolean,
               cash_cents bigint, last_seq bigint, filled_count int)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  snap     record;
  from_seq bigint := 0;
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
  BEGIN
    SELECT b.last_seq, b.cash_cents, b.filled_count, b.has_inconsistent INTO snap
      FROM app.balance_snapshots b WHERE b.userid = p_userid;
    IF FOUND THEN
      from_seq := snap.last_seq; seen := snap.last_seq; cash := snap.cash_cents;
      n_filled := snap.filled_count; any_bad := snap.has_inconsistent;
    END IF;

    FOR r IN
      SELECT 0 AS src, p.instrumentid, NULL::bigint AS seq, NULL::text AS side, NULL::int AS size,
             NULL::numeric AS price, p.qty AS pq, p.cost_micro AS pc, p.inconsistent AS pbad
        FROM app.snapshot_positions p WHERE p.userid = p_userid
      UNION ALL
      SELECT 1, o.instrumentid, o.balance_seq, o.side, o.size, o.price, NULL, NULL, NULL
        FROM app.orders o
       WHERE o.userid = p_userid AND o.status = 'FILLED' AND o.balance_seq > from_seq
      ORDER BY instrumentid, src, seq
    LOOP
      IF r.src = 1 THEN
        n_filled := n_filled + 1;
        IF r.seq > seen THEN seen := r.seq; END IF;
        imp := (r.size::numeric * r.price * 100)::numeric(20,0);      -- centavos; price tiene 2 decimales
        IF r.side IN ('CASH_IN','SELL') THEN cash := cash + imp; ELSE cash := cash - imp; END IF;
        IF r.side IN ('CASH_IN','CASH_OUT') THEN CONTINUE; END IF;    -- el cash no es una posición
      END IF;

      IF cur_i IS DISTINCT FROM r.instrumentid THEN
        IF cur_i IS NOT NULL AND q <> 0 THEN
          kind := 1; instrumentid := cur_i; qty := q; cost_total := c::numeric(24,0); inconsistent := bad;
          cash_cents := NULL; last_seq := NULL; filled_count := NULL;
          RETURN NEXT;
        END IF;
        cur_i := r.instrumentid; q := 0; c := 0; bad := false;
      END IF;

      IF r.src = 0 THEN
        q := r.pq; c := r.pc; bad := r.pbad;
        CONTINUE;
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
      kind := 1; instrumentid := cur_i; qty := q; cost_total := c::numeric(24,0); inconsistent := bad;
      cash_cents := NULL; last_seq := NULL; filled_count := NULL;
      RETURN NEXT;
    END IF;

    kind := 0; instrumentid := NULL; qty := NULL; cost_total := NULL; inconsistent := any_bad;
    cash_cents := cash::bigint; last_seq := seen; filled_count := n_filled;
    RETURN NEXT;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'la historia del usuario % supera los tipos del cálculo (D-14): no puede operar hasta que se corrija; no reintentar', p_userid
      USING ERRCODE = 'APP07', DETAIL = SQLERRM;
  END;
END $$;

CREATE OR REPLACE FUNCTION app.c_publish(p_userid int, p_force boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  s_seq   bigint;
  n_delta bigint;
  k       int;
  h_seq bigint; h_cash bigint; h_filled int; h_bad boolean;
  a_inst int[]; a_qty bigint[]; a_cost numeric[]; a_bad boolean[];
BEGIN
  SELECT snapshot_k INTO k FROM app.settings;
  SELECT b.last_seq INTO s_seq FROM app.balance_snapshots b WHERE b.userid = p_userid;
  SELECT count(*) INTO n_delta FROM app.orders o
   WHERE o.userid = p_userid AND o.status = 'FILLED' AND o.balance_seq > COALESCE(s_seq, 0);
  IF n_delta = 0 THEN RETURN false; END IF;                                   -- al día, o sin historia
  IF NOT p_force AND s_seq IS NOT NULL AND n_delta < k THEN RETURN false; END IF;

  -- Una sola pasada del fold completo: cabecera y posiciones juntas.
  SELECT max(s.last_seq)          FILTER (WHERE s.kind = 0),
         max(s.cash_cents)        FILTER (WHERE s.kind = 0),
         max(s.filled_count)      FILTER (WHERE s.kind = 0),
         bool_or(s.inconsistent)  FILTER (WHERE s.kind = 0),
         array_agg(s.instrumentid) FILTER (WHERE s.kind = 1),
         array_agg(s.qty)          FILTER (WHERE s.kind = 1),
         array_agg(s.cost_total)   FILTER (WHERE s.kind = 1),
         array_agg(s.inconsistent) FILTER (WHERE s.kind = 1)
    INTO h_seq, h_cash, h_filled, h_bad, a_inst, a_qty, a_cost, a_bad
    FROM app.c_state_full(p_userid) s;

  INSERT INTO app.balance_snapshots (userid, last_seq, cash_cents, filled_count, has_inconsistent, updated_at)
  VALUES (p_userid, h_seq, h_cash, h_filled, h_bad, now())
  ON CONFLICT (userid) DO UPDATE SET last_seq = EXCLUDED.last_seq, cash_cents = EXCLUDED.cash_cents,
    filled_count = EXCLUDED.filled_count, has_inconsistent = EXCLUDED.has_inconsistent, updated_at = EXCLUDED.updated_at;
  DELETE FROM app.snapshot_positions WHERE userid = p_userid;
  IF a_inst IS NOT NULL THEN
    INSERT INTO app.snapshot_positions (userid, instrumentid, qty, cost_micro, inconsistent)
    SELECT p_userid, x.i, x.q, x.c, x.b FROM unnest(a_inst, a_qty, a_cost, a_bad) AS x(i, q, c, b);
  END IF;
  RETURN true;
END $$;

-- Dueño app_owner, como todo app.*: read_portfolio (SECURITY DEFINER de app_owner) llama c_state, y
-- 090_privileges.sql le saca EXECUTE a PUBLIC. Ninguna es para api.
ALTER TABLE app.balance_snapshots  OWNER TO app_owner;
ALTER TABLE app.snapshot_positions OWNER TO app_owner;
ALTER FUNCTION app.c_state(int)              OWNER TO app_owner;
ALTER FUNCTION app.c_state_full(int)         OWNER TO app_owner;
ALTER FUNCTION app.c_publish(int, boolean)   OWNER TO app_owner;
REVOKE ALL ON app.balance_snapshots, app.snapshot_positions FROM PUBLIC, api;
REVOKE ALL ON FUNCTION app.c_state(int), app.c_state_full(int), app.c_publish(int, boolean) FROM PUBLIC, api;

COMMIT;
