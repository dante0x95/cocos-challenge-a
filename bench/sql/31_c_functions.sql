-- Fase 12 / C — Funciones de C. IDEMPOTENTE (CREATE OR REPLACE).
-- Reemplaza place_order, execute_limit, cancel_order y read_portfolio de A por las versiones
-- snapshot + delta, con LA MISMA FIRMA: la API no cambia. Volver a A = correr 21_functions.sql.
-- Uso: psql $PG -v ON_ERROR_STOP=1 -f bench/sql/31_c_functions.sql
-- Prerrequisitos: 21_functions.sql (A) y 30_c_tables.sql.
--
-- Núcleo: app.c_state(userid) = snapshot válido (si su algo_version es la activa) + delta
-- (FILLED con balance_seq > last_seq, ≤ K en régimen), mismo fold R.2 que A.
-- Publicación (C §4): después de aplicar la operación, si delta ≥ K (compactación) o si no había
-- snapshot válido y hay al menos un FILLED (reconstrucción). El replay nunca publica (C §6).
\set ON_ERROR_STOP on
BEGIN;

\echo '=== c_state: snapshot + delta ==='
-- kind 0: una fila de cabecera: cash_cents, last_seq (secuencia vista), delta_count, snapshot_valid,
--         inconsistent = flag global.
-- kind 1: posiciones con qty <> 0 o inconsistentes: qty, cost_total (micro-ARS), inconsistent.
CREATE OR REPLACE FUNCTION app.c_state(p_userid int)
RETURNS TABLE (kind smallint, instrumentid int, qty bigint, cost_total bigint, inconsistent boolean,
               cash_cents bigint, last_seq bigint, delta_count int, snapshot_valid boolean)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  v        smallint;
  s_seq    bigint;
  s_cash   bigint;
  s_bad    boolean;
  valid    boolean := false;
  from_seq bigint := 0;
  cash     numeric := 0;
  seen     bigint := 0;
  n_delta  int := 0;
  any_bad  boolean := false;
  r        record;
  cur_i    int := NULL;
  q        numeric := 0;
  c        numeric := 0;
  bad      boolean := false;
  imp      numeric;
BEGIN
  SELECT active_algo_version INTO v FROM app.settings;
  SELECT b.last_seq, (b.cash * 100)::bigint, b.has_inconsistent INTO s_seq, s_cash, s_bad
    FROM app.balance_snapshots b WHERE b.userid = p_userid AND b.algo_version = v;
  IF FOUND THEN valid := true; from_seq := s_seq; cash := s_cash; seen := s_seq; any_bad := s_bad; END IF;

  FOR r IN
    SELECT 0 AS src, p.instrumentid, NULL::bigint AS seq, NULL::text AS side, NULL::int AS size, NULL::numeric AS price,
           p.qty AS pq, (p.cost_total * 1000000)::numeric AS pc, p.inconsistent AS pbad
      FROM app.snapshot_positions p WHERE p.userid = p_userid AND valid
    UNION ALL
    SELECT 1, o.instrumentid, o.balance_seq, o.side, o.size, o.price, NULL, NULL, NULL
      FROM app.orders o WHERE o.userid = p_userid AND o.status = 'FILLED' AND o.balance_seq > from_seq
    ORDER BY instrumentid, src, seq
  LOOP
    IF r.src = 1 THEN
      n_delta := n_delta + 1;
      IF r.seq > seen THEN seen := r.seq; END IF;
      imp := (r.size::numeric * r.price * 100)::numeric(20,0);
      IF r.side IN ('CASH_IN','SELL') THEN cash := cash + imp; ELSE cash := cash - imp; END IF;
      IF r.side IN ('CASH_IN','CASH_OUT') THEN CONTINUE; END IF;
    END IF;

    IF cur_i IS DISTINCT FROM r.instrumentid THEN
      IF cur_i IS NOT NULL AND (q <> 0 OR bad) THEN
        kind := 1; instrumentid := cur_i; qty := q; cost_total := c; inconsistent := bad;
        cash_cents := NULL; last_seq := NULL; delta_count := NULL; snapshot_valid := NULL;
        RETURN NEXT;
      END IF;
      cur_i := r.instrumentid; q := 0; c := 0; bad := false;
    END IF;

    IF r.src = 0 THEN
      q := r.pq; c := r.pc; bad := r.pbad;
    ELSIF r.side = 'BUY' THEN
      c := c + imp * 10000; q := q + r.size;
    ELSE
      IF r.size > q THEN bad := true; any_bad := true; q := q - r.size; c := 0;
      ELSE
        c := app.div_half_even(c * (q - r.size), q); q := q - r.size;
        IF q = 0 THEN c := 0; END IF;
      END IF;
    END IF;
  END LOOP;
  IF cur_i IS NOT NULL AND (q <> 0 OR bad) THEN
    kind := 1; instrumentid := cur_i; qty := q; cost_total := c; inconsistent := bad;
    cash_cents := NULL; last_seq := NULL; delta_count := NULL; snapshot_valid := NULL;
    RETURN NEXT;
  END IF;

  kind := 0; instrumentid := NULL; qty := NULL; cost_total := NULL; inconsistent := any_bad;
  cash_cents := cash::bigint; last_seq := seen; delta_count := n_delta; snapshot_valid := valid;
  RETURN NEXT;
END $$;

\echo '=== c_publish: escribe el snapshot con el estado actual (bajo el lock del llamador) ==='
-- Devuelve true si publicó. Regla: delta ≥ K, o snapshot inválido con al menos un FILLED.
-- p_force: publicar si hay historia, sin mirar K (calentamiento).
CREATE OR REPLACE FUNCTION app.c_publish(p_userid int, p_force boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  h   record;
  k   int;
  v   smallint;
  a_inst int[]; a_qty bigint[]; a_cost bigint[]; a_bad boolean[];
BEGIN
  SELECT active_algo_version, snapshot_k INTO v, k FROM app.settings;
  SELECT * INTO h FROM app.c_state(p_userid) WHERE kind = 0;
  IF h.last_seq = 0 THEN RETURN false; END IF;                       -- sin historia: nada que publicar
  IF NOT p_force AND h.snapshot_valid AND h.delta_count < k THEN RETURN false; END IF;
  IF NOT p_force AND NOT h.snapshot_valid AND h.delta_count = 0 THEN RETURN false; END IF;

  -- Capturar el estado ANTES de escribir: c_state leería el snapshot recién publicado.
  SELECT array_agg(s.instrumentid), array_agg(s.qty), array_agg(s.cost_total), array_agg(s.inconsistent)
    INTO a_inst, a_qty, a_cost, a_bad
    FROM app.c_state(p_userid) s WHERE s.kind = 1;

  INSERT INTO app.balance_snapshots (userid, last_seq, cash, algo_version, has_inconsistent, updated_at)
  VALUES (p_userid, h.last_seq, (h.cash_cents::numeric / 100)::numeric(18,2), v, h.inconsistent, now())
  ON CONFLICT (userid) DO UPDATE SET last_seq = EXCLUDED.last_seq, cash = EXCLUDED.cash,
    algo_version = EXCLUDED.algo_version, has_inconsistent = EXCLUDED.has_inconsistent, updated_at = EXCLUDED.updated_at;
  DELETE FROM app.snapshot_positions WHERE userid = p_userid;
  IF a_inst IS NOT NULL THEN
    INSERT INTO app.snapshot_positions (userid, instrumentid, qty, cost_total, inconsistent)
    SELECT p_userid, x.instrumentid, x.qty, (x.cost_total::numeric / 1000000)::numeric(24,6), x.inconsistent
      FROM unnest(a_inst, a_qty, a_cost, a_bad) AS x(instrumentid, qty, cost_total, inconsistent);
  END IF;
  RETURN true;
END $$;

\echo '=== read_portfolio (C): mismas columnas que A ==='
CREATE OR REPLACE FUNCTION app.read_portfolio(p_userid int)
RETURNS TABLE (kind smallint, instrumentid int, ticker text, name text,
               qty bigint, cost_total bigint, inconsistent boolean,
               reserved bigint, close numeric, previousclose numeric, price_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
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
   ORDER BY 1, 2
$$;

\echo '=== place_order (C): autoriza con snapshot + delta + reservas; publica según §4 ==='
CREATE OR REPLACE FUNCTION app.place_order(
  p_userid int, p_key text, p_hash text,
  p_side text, p_type text, p_instrumentid int, p_size int, p_amount numeric, p_limit numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  k_ars        int;
  inst_type    text;
  claimed      text;
  prev         record;
  vc           record;
  price        numeric(18,2);
  imp          numeric;
  h            record;          -- cabecera de c_state
  pos_qty      bigint := 0;
  res          record;
  new_status   text;
  new_seq      bigint;
  new_id       bigint;
  body         jsonb;
  ts           timestamp := timezone('UTC', now());
  is_cash      boolean := p_side IN ('CASH_IN','CASH_OUT');
  v_size       bigint;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);

  IF p_key IS NULL OR p_key = '' OR p_hash IS NULL THEN
    RAISE EXCEPTION 'BAD_REQUEST: idempotency key y hash obligatorios' USING ERRCODE = 'APP02';
  END IF;
  IF p_side NOT IN ('BUY','SELL','CASH_IN','CASH_OUT') THEN
    RAISE EXCEPTION 'BAD_REQUEST: side inválido %', p_side USING ERRCODE = 'APP02';
  END IF;
  IF p_type NOT IN ('MARKET','LIMIT') THEN
    RAISE EXCEPTION 'BAD_REQUEST: type inválido %', p_type USING ERRCODE = 'APP02';
  END IF;
  IF (p_size IS NULL) = (p_amount IS NULL) THEN
    RAISE EXCEPTION 'BAD_REQUEST: enviar size o amount, exactamente uno' USING ERRCODE = 'APP02';
  END IF;
  IF p_size IS NOT NULL AND p_size <= 0 THEN
    RAISE EXCEPTION 'BAD_REQUEST: size debe ser > 0' USING ERRCODE = 'APP02';
  END IF;
  IF p_amount IS NOT NULL AND (p_amount <= 0 OR p_amount <> round(p_amount, 2)) THEN
    RAISE EXCEPTION 'BAD_REQUEST: amount debe ser > 0 con a lo sumo 2 decimales' USING ERRCODE = 'APP02';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.users u WHERE u.id = p_userid) THEN
    RAISE EXCEPTION 'BAD_REQUEST: usuario % inexistente', p_userid USING ERRCODE = 'APP02';
  END IF;
  SELECT i.type INTO inst_type FROM app.instruments i WHERE i.id = p_instrumentid;
  IF inst_type IS NULL THEN
    RAISE EXCEPTION 'BAD_REQUEST: instrumento % inexistente', p_instrumentid USING ERRCODE = 'APP02';
  END IF;
  SELECT i.id INTO k_ars FROM app.instruments i WHERE i.ticker = 'ARS';

  IF is_cash THEN
    IF p_type <> 'MARKET' OR p_limit IS NOT NULL OR p_instrumentid <> k_ars THEN
      RAISE EXCEPTION 'BAD_REQUEST: un movimiento cash es MARKET, sobre ARS y sin precio' USING ERRCODE = 'APP02';
    END IF;
    price := 0.01;
  ELSE
    IF inst_type = 'MONEDA' THEN
      RAISE EXCEPTION 'BAD_REQUEST: BUY/SELL no aplica sobre moneda' USING ERRCODE = 'APP02';
    END IF;
    IF p_type = 'MARKET' AND p_limit IS NOT NULL THEN
      RAISE EXCEPTION 'BAD_REQUEST: MARKET no admite precio' USING ERRCODE = 'APP02';
    END IF;
    IF p_type = 'LIMIT' THEN
      IF p_limit IS NULL OR p_limit <= 0 OR p_limit <> round(p_limit, 2) THEN
        RAISE EXCEPTION 'BAD_REQUEST: LIMIT requiere precio > 0 con a lo sumo 2 decimales' USING ERRCODE = 'APP02';
      END IF;
      price := p_limit;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('user-balance'), p_userid);

  -- Idempotencia: el replay devuelve y sale, sin leer estado ni publicar (C §6).
  INSERT INTO app.idempotency_keys (userid, key, request_hash)
  VALUES (p_userid, p_key, p_hash)
  ON CONFLICT (userid, key) DO NOTHING
  RETURNING key INTO claimed;
  IF claimed IS NULL THEN
    SELECT request_hash, http_status, response_body, order_id INTO prev
      FROM app.idempotency_keys WHERE userid = p_userid AND key = p_key;
    IF prev.request_hash <> p_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: la clave % ya se usó con otro request', p_key USING ERRCODE = 'APP03';
    END IF;
    IF prev.http_status IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: clave % sin respuesta registrada', p_key USING ERRCODE = 'APP03';
    END IF;
    RETURN jsonb_build_object('status', prev.http_status, 'body', prev.response_body,
                              'replay', true, 'order_id', prev.order_id::text);
  END IF;

  IF NOT is_cash AND p_type = 'MARKET' THEN
    SELECT * INTO vc FROM app.valid_close(p_instrumentid);
    IF vc.close IS NULL THEN
      RAISE EXCEPTION 'NO_PRICE: sin cotización válida para el instrumento %', p_instrumentid USING ERRCODE = 'APP01';
    END IF;
    price := vc.close;
  END IF;

  IF p_size IS NOT NULL THEN v_size := p_size;
  ELSIF is_cash THEN v_size := (p_amount * 100)::bigint;
  ELSE
    v_size := floor(p_amount / price)::bigint;
    IF v_size <= 0 THEN
      RAISE EXCEPTION 'BAD_REQUEST: amount % no alcanza para una acción a %', p_amount, price USING ERRCODE = 'APP02';
    END IF;
  END IF;
  IF v_size > 2147483647 THEN
    RAISE EXCEPTION 'BAD_REQUEST: size supera el máximo por movimiento (2147483647)' USING ERRCODE = 'APP02';
  END IF;
  imp := (v_size::numeric * price * 100)::numeric(20,0);

  -- Lectura única C §3: snapshot + delta (cabecera y, si hace falta, la posición del instrumento) + reservas.
  SELECT * INTO h FROM app.c_state(p_userid) WHERE kind = 0;
  IF p_side = 'SELL' THEN
    SELECT COALESCE((SELECT s.qty FROM app.c_state(p_userid) s WHERE s.kind = 1 AND s.instrumentid = p_instrumentid), 0) INTO pos_qty;
  END IF;
  SELECT
    COALESCE(sum(CASE WHEN o.side = 'BUY' THEN o.size::numeric * o.price * 100 END), 0)                 AS cash_reservado,
    COALESCE(sum(CASE WHEN o.side = 'SELL' AND o.instrumentid = p_instrumentid THEN o.size END), 0)     AS acciones_reservadas
  INTO res
  FROM app.orders o WHERE o.userid = p_userid AND o.status = 'NEW';

  CASE
    WHEN p_side = 'CASH_IN' THEN new_status := 'FILLED';
    WHEN p_side = 'CASH_OUT' THEN
      new_status := CASE WHEN h.cash_cents - res.cash_reservado >= imp THEN 'FILLED' ELSE 'REJECTED' END;
    WHEN p_side = 'BUY' THEN
      IF h.cash_cents - res.cash_reservado >= imp THEN
        new_status := CASE WHEN p_type = 'MARKET' THEN 'FILLED' ELSE 'NEW' END;
      ELSE new_status := 'REJECTED'; END IF;
    WHEN p_side = 'SELL' THEN
      IF pos_qty - res.acciones_reservadas >= v_size THEN
        new_status := CASE WHEN p_type = 'MARKET' THEN 'FILLED' ELSE 'NEW' END;
      ELSE new_status := 'REJECTED'; END IF;
  END CASE;

  IF new_status = 'FILLED' THEN
    IF p_side IN ('CASH_IN','SELL') AND abs(h.cash_cents + imp) > 1e17
       OR p_side IN ('CASH_OUT','BUY') AND abs(h.cash_cents - imp) > 1e17 THEN
      RAISE EXCEPTION 'DOMAIN_LIMIT: cash fuera de ±10^15 ARS' USING ERRCODE = 'APP05';
    END IF;
    IF p_side = 'BUY' AND pos_qty + v_size > 4611686018427387904 THEN
      RAISE EXCEPTION 'DOMAIN_LIMIT: qty supera 2^62' USING ERRCODE = 'APP05';
    END IF;
    new_seq := h.last_seq + 1;
  END IF;

  INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
  VALUES (p_instrumentid, p_userid, v_size, price, p_type, p_side, new_status, ts, new_seq)
  RETURNING id INTO new_id;

  body := jsonb_build_object(
    'id', new_id::text, 'userid', p_userid::text, 'instrumentid', p_instrumentid::text,
    'side', p_side, 'type', p_type, 'size', v_size::text, 'price', price::text,
    'amount', (imp / 100)::numeric(18,2)::text, 'status', new_status, 'balance_seq', new_seq::text,
    'datetime', to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  UPDATE app.idempotency_keys SET order_id = new_id, http_status = 201, response_body = body
   WHERE userid = p_userid AND key = p_key;

  -- Publicación C §4, con el estado resultante (misma transacción, mismo lock).
  PERFORM app.c_publish(p_userid);

  RETURN jsonb_build_object('status', 201, 'body', body, 'replay', false, 'order_id', new_id::text);
END $$;

\echo '=== execute_limit (C) ==='
CREATE OR REPLACE FUNCTION app.execute_limit(p_order_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE o record; vc record; nxt bigint; n int;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);
  SELECT userid INTO o FROM app.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('user-balance'), o.userid);
  SELECT id, userid, instrumentid, side, price, status, type INTO o FROM app.orders WHERE id = p_order_id;
  IF o.status <> 'NEW' OR o.type <> 'LIMIT' THEN
    PERFORM app.c_publish(o.userid);          -- reconstrucción por versión si corresponde (C §5)
    RETURN false;
  END IF;
  SELECT * INTO vc FROM app.valid_close(o.instrumentid);
  IF vc.close IS NULL THEN
    RAISE EXCEPTION 'NO_PRICE: sin cotización válida para el instrumento %', o.instrumentid USING ERRCODE = 'APP01';
  END IF;
  IF NOT ((o.side = 'BUY' AND vc.close <= o.price) OR (o.side = 'SELL' AND vc.close >= o.price)) THEN
    PERFORM app.c_publish(o.userid);
    RETURN false;
  END IF;
  SELECT COALESCE(max(balance_seq), 0) + 1 INTO nxt FROM app.orders WHERE userid = o.userid AND balance_seq IS NOT NULL;
  UPDATE app.orders SET status = 'FILLED', balance_seq = nxt
   WHERE id = p_order_id AND userid = o.userid AND status = 'NEW';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM app.c_publish(o.userid);
  RETURN n > 0;
END $$;

\echo '=== cancel_order (C) ==='
CREATE OR REPLACE FUNCTION app.cancel_order(p_userid int, p_order_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);
  PERFORM pg_advisory_xact_lock(hashtext('user-balance'), p_userid);
  UPDATE app.orders SET status = 'CANCELLED' WHERE id = p_order_id AND userid = p_userid AND status = 'NEW';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM app.c_publish(p_userid);
  RETURN n > 0;
END $$;

\echo '=== warm_snapshot: calentamiento (C §7), publica si hay historia y el snapshot falta o es viejo ==='
CREATE OR REPLACE FUNCTION app.warm_snapshot(p_userid int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE h record;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);
  IF NOT pg_try_advisory_xact_lock(hashtext('user-balance'), p_userid) THEN RETURN false; END IF;
  SELECT * INTO h FROM app.c_state(p_userid) WHERE kind = 0;
  IF h.last_seq = 0 THEN RETURN false; END IF;
  IF h.snapshot_valid AND h.delta_count = 0 THEN RETURN false; END IF;
  RETURN app.c_publish(p_userid, true);
END $$;

\echo '=== reconcile: snapshot + delta == fold completo; si no, borra el snapshot (P.10) ==='
CREATE OR REPLACE FUNCTION app.reconcile(p_userid int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE n_diff int; c_cash bigint; f_cash bigint; c_bad boolean; f_bad boolean;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);
  PERFORM pg_advisory_xact_lock(hashtext('user-balance'), p_userid);
  SELECT cash_cents, inconsistent INTO c_cash, c_bad FROM app.c_state(p_userid) WHERE kind = 0;
  SELECT qty, inconsistent INTO f_cash, f_bad FROM app.fold_user(p_userid) WHERE instrumentid IS NULL;
  SELECT count(*) INTO n_diff FROM (
    (SELECT instrumentid, qty, cost_total, inconsistent FROM app.c_state(p_userid) WHERE kind = 1
     EXCEPT SELECT instrumentid, qty, cost_total, inconsistent FROM app.fold_user(p_userid) WHERE instrumentid IS NOT NULL)
    UNION ALL
    (SELECT instrumentid, qty, cost_total, inconsistent FROM app.fold_user(p_userid) WHERE instrumentid IS NOT NULL
     EXCEPT SELECT instrumentid, qty, cost_total, inconsistent FROM app.c_state(p_userid) WHERE kind = 1)) d;
  IF n_diff = 0 AND c_cash = f_cash AND c_bad = f_bad THEN RETURN true; END IF;
  DELETE FROM app.balance_snapshots WHERE userid = p_userid;     -- cascada a posiciones; el siguiente escritor reconstruye
  RETURN false;
END $$;

\echo '=== set_algo_version: cambio de versión con barrera exclusiva (F.3) ==='
CREATE OR REPLACE FUNCTION app.set_algo_version(p_version smallint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('deploy'));     -- espera a todos los escritores en curso
  UPDATE app.settings SET active_algo_version = p_version;
END $$;

\echo '=== propiedad y privilegios ==='
ALTER FUNCTION app.c_state(int)                                                          OWNER TO app_owner;
ALTER FUNCTION app.c_publish(int, boolean)                                               OWNER TO app_owner;
ALTER FUNCTION app.read_portfolio(int)                                                   OWNER TO app_owner;
ALTER FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric)  OWNER TO app_owner;
ALTER FUNCTION app.execute_limit(bigint)                                                 OWNER TO app_owner;
ALTER FUNCTION app.cancel_order(int, bigint)                                             OWNER TO app_owner;
ALTER FUNCTION app.warm_snapshot(int)                                                    OWNER TO app_owner;
ALTER FUNCTION app.reconcile(int)                                                        OWNER TO app_owner;
ALTER FUNCTION app.set_algo_version(smallint)                                            OWNER TO app_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_portfolio(int)                                                  TO api;
GRANT EXECUTE ON FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric) TO api;
GRANT EXECUTE ON FUNCTION app.execute_limit(bigint)                                                TO api;
GRANT EXECUTE ON FUNCTION app.cancel_order(int, bigint)                                            TO api;
GRANT EXECUTE ON FUNCTION app.cleanup_idempotency(int)                                             TO api;
GRANT EXECUTE ON FUNCTION app.warm_snapshot(int)                                                   TO api;
-- c_state, c_publish, reconcile y set_algo_version: solo app_owner/superusuario.

COMMIT;
\echo '=== FUNCIONES DE C INSTALADAS ==='
