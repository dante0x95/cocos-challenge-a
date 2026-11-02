-- Fase 5 / F.1–F.3 — Funciones de app: la única vía de escritura. IDEMPOTENTE (CREATE OR REPLACE):
-- se puede reaplicar sobre un contenedor ya cargado sin restaurar datos.
-- Uso: psql $PG -v ON_ERROR_STOP=1 -f bench/sql/21_functions.sql
-- Prerrequisito: 20_schema_roles.sql (esquema app, roles, secuencia).
--
-- Códigos SQLSTATE propios (la API los mapea a HTTP):
--   APP01 NO_PRICE          -> 422 (sin orden; la clave de idempotencia no se consume)
--   APP02 BAD_REQUEST       -> 400 (validación de argumentos; sin escritura)
--   APP03 IDEMPOTENCY_MISMATCH -> 422 (misma clave, request distinto)
--   APP04 VERSION_MISMATCH  -> 503 (barrera de despliegue, F.3)
--   APP05 DOMAIN_LIMIT      -> 422 (resultado fuera de ±10^15 ARS o qty > 2^62)
--   55P03 / 57014 (lock/statement timeout) -> 503 (los pone Postgres)

\set ON_ERROR_STOP on
BEGIN;

\echo '=== F.2 aritmética: división entera half-even ==='
CREATE OR REPLACE FUNCTION app.div_half_even(a numeric, b numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT CASE
    WHEN 2 * mod(a, b) < b THEN div(a, b)
    WHEN 2 * mod(a, b) > b THEN div(a, b) + 1
    WHEN mod(div(a, b), 2) = 0 THEN div(a, b)
    ELSE div(a, b) + 1
  END
$$;

\echo '=== F.2 fold R.2 por usuario (orden balance_seq) ==='
-- Una fila por instrumento con posición o historia inconsistente, más una fila
-- instrumentid = NULL con el cash en centavos y el flag global (D-002).
-- cost_total en micro-ARS. Ventas en corto heredadas: inconsistent = true, cost = 0.
CREATE OR REPLACE FUNCTION app.fold_user(p_userid int)
RETURNS TABLE (instrumentid int, qty bigint, cost_total bigint, inconsistent boolean)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  r      record;
  cur_i  int     := NULL;
  q      numeric := 0;
  c      numeric := 0;
  bad    boolean := false;
  any_bad boolean := false;
  imp    numeric;
BEGIN
  FOR r IN
    SELECT o.instrumentid, o.side, o.size, o.price
      FROM app.orders o
     WHERE o.userid = p_userid AND o.status = 'FILLED' AND o.side IN ('BUY','SELL')
     ORDER BY o.instrumentid, o.balance_seq
  LOOP
    IF cur_i IS DISTINCT FROM r.instrumentid THEN
      IF cur_i IS NOT NULL AND (q <> 0 OR bad) THEN
        instrumentid := cur_i; qty := q; cost_total := c; inconsistent := bad;
        RETURN NEXT;
      END IF;
      cur_i := r.instrumentid; q := 0; c := 0; bad := false;
    END IF;

    imp := (r.size::numeric * r.price * 100)::numeric(20,0);   -- centavos, exacto
    IF r.side = 'BUY' THEN
      c := c + imp * 10000;                                     -- micro-ARS
      q := q + r.size;
    ELSE
      IF r.size > q THEN
        bad := true; any_bad := true;
        q := q - r.size; c := 0;
      ELSE
        c := app.div_half_even(c * (q - r.size), q);
        q := q - r.size;
        IF q = 0 THEN c := 0; END IF;
      END IF;
    END IF;
  END LOOP;
  IF cur_i IS NOT NULL AND (q <> 0 OR bad) THEN
    instrumentid := cur_i; qty := q; cost_total := c; inconsistent := bad;
    RETURN NEXT;
  END IF;

  -- Fila de cash: qty = centavos netos (solo FILLED), cost_total = 0.
  SELECT COALESCE(sum(
           CASE o.side WHEN 'CASH_IN' THEN 1 WHEN 'SELL' THEN 1 ELSE -1 END
           * (o.size::numeric * o.price * 100)), 0)::bigint
    INTO qty
    FROM app.orders o
   WHERE o.userid = p_userid AND o.status = 'FILLED';
  instrumentid := NULL; cost_total := 0; inconsistent := any_bad;
  RETURN NEXT;
END $$;

\echo '=== F.2 precio válido (A §5.1, D-005) ==='
CREATE OR REPLACE FUNCTION app.valid_close(p_instrumentid int,
                                OUT close numeric, OUT previousclose numeric, OUT price_date date)
LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT m.close, m.previousclose, m.date
    FROM app.marketdata m, app.settings s
   WHERE m.instrumentid = p_instrumentid
     AND m.date <= (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
     AND (s.price_max_age_days IS NULL
          OR m.date >= (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - s.price_max_age_days)
   ORDER BY m.date DESC
   LIMIT 1
$$;

\echo '=== F.2 read_portfolio: columnas tipadas, sin JSON ==='
-- kind 0: una fila de cash: qty = cash_cents, reserved = cash reservado (NEW BUY, centavos),
--         inconsistent = has_inconsistent_history.
-- kind 1: una fila por posición: qty, cost_total (micro-ARS), reserved = acciones reservadas
--         (NEW SELL), close y price_date de la última cotización válida (NULL si no hay).
-- La API deriva valor, rendimiento y disponible con BigInt.
CREATE OR REPLACE FUNCTION app.read_portfolio(p_userid int)
RETURNS TABLE (kind smallint, instrumentid int, ticker text, name text,
               qty bigint, cost_total bigint, inconsistent boolean,
               reserved bigint, close numeric, previousclose numeric, price_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  WITH f AS (SELECT * FROM app.fold_user(p_userid)),
       res AS (
         SELECT o.instrumentid,
                sum(CASE WHEN o.side = 'BUY'  THEN (o.size::numeric * o.price * 100) ELSE 0 END)::bigint AS cash_cents,
                sum(CASE WHEN o.side = 'SELL' THEN o.size ELSE 0 END)::bigint AS shares
           FROM app.orders o
          WHERE o.userid = p_userid AND o.status = 'NEW'
          GROUP BY o.instrumentid)
  SELECT 0::smallint, NULL::int, NULL::text, NULL::text,
         f.qty, 0::bigint, f.inconsistent,
         COALESCE((SELECT sum(cash_cents) FROM res), 0)::bigint, NULL::numeric, NULL::numeric, NULL::date
    FROM f WHERE f.instrumentid IS NULL
  UNION ALL
  SELECT 1::smallint, f.instrumentid, i.ticker::text, i.name::text,
         f.qty, f.cost_total, f.inconsistent,
         COALESCE(res.shares, 0), vc.close, vc.previousclose, vc.price_date
    FROM f
    JOIN app.instruments i ON i.id = f.instrumentid
    LEFT JOIN res ON res.instrumentid = f.instrumentid
    LEFT JOIN LATERAL app.valid_close(f.instrumentid) vc ON true
   WHERE f.instrumentid IS NOT NULL
   ORDER BY 1, 2
$$;

\echo '=== F.1 barrera de despliegue (F.3) ==='
CREATE OR REPLACE FUNCTION app.deploy_barrier(p_expected_version smallint)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE v smallint;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('deploy'));
  SELECT active_algo_version INTO v FROM app.settings;
  IF v IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'VERSION_MISMATCH: activa %, esperada %', v, p_expected_version
      USING ERRCODE = 'APP04';
  END IF;
END $$;

\echo '=== F.1 place_order ==='
-- p_size XOR p_amount (D-003): con p_amount (pesos, <= 2 decimales) la cantidad se calcula
-- bajo el lock con el precio de ejecución: floor(amount / price); 0 -> APP02.
-- Para CASH_IN/CASH_OUT, p_amount son pesos y size = centavos.
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
  imp          numeric;          -- centavos
  agg          record;
  new_status   text;
  new_seq      bigint;
  new_id       bigint;
  body         jsonb;
  ts           timestamp := timezone('UTC', now());
  is_cash      boolean := p_side IN ('CASH_IN','CASH_OUT');
  v_size       bigint;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);

  -- Validación de argumentos (sin escritura, antes del lock).
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
      RAISE EXCEPTION 'BAD_REQUEST: un movimiento cash es MARKET, sobre ARS y sin precio'
        USING ERRCODE = 'APP02';
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
        RAISE EXCEPTION 'BAD_REQUEST: LIMIT requiere precio > 0 con a lo sumo 2 decimales'
          USING ERRCODE = 'APP02';
      END IF;
      price := p_limit;
    END IF;
  END IF;

  -- Lock de usuario: antes de cualquier lectura que participe en la decisión.
  PERFORM pg_advisory_xact_lock(hashtext('user-balance'), p_userid);

  -- Idempotencia (A §7.1).
  INSERT INTO app.idempotency_keys (userid, key, request_hash)
  VALUES (p_userid, p_key, p_hash)
  ON CONFLICT (userid, key) DO NOTHING
  RETURNING key INTO claimed;
  IF claimed IS NULL THEN
    SELECT request_hash, http_status, response_body, order_id INTO prev
      FROM app.idempotency_keys WHERE userid = p_userid AND key = p_key;
    IF prev.request_hash <> p_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: la clave % ya se usó con otro request', p_key
        USING ERRCODE = 'APP03';
    END IF;
    IF prev.http_status IS NULL THEN
      -- Clave reclamada por una transacción que no completó (no debería ocurrir: misma tx).
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: clave % sin respuesta registrada', p_key
        USING ERRCODE = 'APP03';
    END IF;
    RETURN jsonb_build_object('status', prev.http_status, 'body', prev.response_body,
                              'replay', true, 'order_id', prev.order_id::text);
  END IF;

  -- Precio de ejecución para MARKET sobre acciones (A §5.1). Sin precio: NO_PRICE,
  -- la excepción revierte el reclamo de la clave.
  IF NOT is_cash AND p_type = 'MARKET' THEN
    SELECT * INTO vc FROM app.valid_close(p_instrumentid);
    IF vc.close IS NULL THEN
      RAISE EXCEPTION 'NO_PRICE: sin cotización válida para el instrumento %', p_instrumentid
        USING ERRCODE = 'APP01';
    END IF;
    price := vc.close;
  END IF;

  -- Cantidad (D-003), con el precio ya resuelto.
  IF p_size IS NOT NULL THEN
    v_size := p_size;
  ELSIF is_cash THEN
    v_size := (p_amount * 100)::bigint;
  ELSE
    v_size := floor(p_amount / price)::bigint;
    IF v_size <= 0 THEN
      RAISE EXCEPTION 'BAD_REQUEST: amount % no alcanza para una acción a %', p_amount, price
        USING ERRCODE = 'APP02';
    END IF;
  END IF;
  IF v_size > 2147483647 THEN
    RAISE EXCEPTION 'BAD_REQUEST: size supera el máximo por movimiento (2147483647)' USING ERRCODE = 'APP02';
  END IF;

  imp := (v_size::numeric * price * 100)::numeric(20,0);

  -- Autorización (A §5.3), bajo el lock. Tres subconsultas, cada una con el status exacto
  -- de su índice parcial (orders_filled_by_user, orders_new_by_user, orders_balance_seq):
  -- un filtro status IN ('FILLED','NEW') no implica ningún predicado parcial y termina en
  -- seq scan de toda la tabla. Una pasada por FILLED (cash y posición), una por NEW, un MAX.
  SELECT f.cash_neto, f.posicion, n.cash_reservado, n.acciones_reservadas, m.last_seq
  INTO agg
  FROM (
    SELECT COALESCE(sum(CASE o.side WHEN 'CASH_IN' THEN 1 WHEN 'SELL' THEN 1 ELSE -1 END
                        * (o.size::numeric * o.price * 100)), 0)                                   AS cash_neto,
           COALESCE(sum(CASE WHEN o.instrumentid = p_instrumentid THEN
                        CASE o.side WHEN 'BUY' THEN o.size WHEN 'SELL' THEN -o.size ELSE 0 END END), 0) AS posicion
      FROM app.orders o WHERE o.userid = p_userid AND o.status = 'FILLED') f,
  (
    SELECT COALESCE(sum(CASE WHEN o.side = 'BUY' THEN o.size::numeric * o.price * 100 END), 0)    AS cash_reservado,
           COALESCE(sum(CASE WHEN o.side = 'SELL' AND o.instrumentid = p_instrumentid THEN o.size END), 0) AS acciones_reservadas
      FROM app.orders o WHERE o.userid = p_userid AND o.status = 'NEW') n,
  (
    SELECT COALESCE(max(o.balance_seq), 0) AS last_seq
      FROM app.orders o WHERE o.userid = p_userid AND o.balance_seq IS NOT NULL) m;

  -- Decisión (A §6.1).
  CASE
    WHEN p_side = 'CASH_IN' THEN
      new_status := 'FILLED';
    WHEN p_side = 'CASH_OUT' THEN
      new_status := CASE WHEN agg.cash_neto - agg.cash_reservado >= imp THEN 'FILLED' ELSE 'REJECTED' END;
    WHEN p_side = 'BUY' THEN
      IF agg.cash_neto - agg.cash_reservado >= imp THEN
        new_status := CASE WHEN p_type = 'MARKET' THEN 'FILLED' ELSE 'NEW' END;
      ELSE
        new_status := 'REJECTED';
      END IF;
    WHEN p_side = 'SELL' THEN
      IF agg.posicion - agg.acciones_reservadas >= v_size THEN
        new_status := CASE WHEN p_type = 'MARKET' THEN 'FILLED' ELSE 'NEW' END;
      ELSE
        new_status := 'REJECTED';
      END IF;
  END CASE;

  -- Límites de dominio (A §2.1), solo si el movimiento se confirma.
  IF new_status = 'FILLED' THEN
    IF p_side IN ('CASH_IN','SELL') AND abs(agg.cash_neto + imp) > 1e17
       OR p_side IN ('CASH_OUT','BUY') AND abs(agg.cash_neto - imp) > 1e17 THEN
      RAISE EXCEPTION 'DOMAIN_LIMIT: cash fuera de ±10^15 ARS' USING ERRCODE = 'APP05';
    END IF;
    IF p_side = 'BUY' AND agg.posicion + v_size > 4611686018427387904 THEN
      RAISE EXCEPTION 'DOMAIN_LIMIT: qty supera 2^62' USING ERRCODE = 'APP05';
    END IF;
    new_seq := agg.last_seq + 1;
  END IF;

  INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
  VALUES (p_instrumentid, p_userid, v_size, price, p_type, p_side, new_status, ts, new_seq)
  RETURNING id INTO new_id;

  body := jsonb_build_object(
    'id',           new_id::text,
    'userid',       p_userid::text,
    'instrumentid', p_instrumentid::text,
    'side',         p_side,
    'type',         p_type,
    'size',         v_size::text,
    'price',        price::text,
    'amount',       (imp / 100)::numeric(18,2)::text,
    'status',       new_status,
    'balance_seq',  new_seq::text,
    'datetime',     to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  UPDATE app.idempotency_keys
     SET order_id = new_id, http_status = 201, response_body = body
   WHERE userid = p_userid AND key = p_key;

  RETURN jsonb_build_object('status', 201, 'body', body, 'replay', false, 'order_id', new_id::text);
END $$;

\echo '=== F.1 execute_limit ==='
CREATE OR REPLACE FUNCTION app.execute_limit(p_order_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE
  o   record;
  vc  record;
  nxt bigint;
  n   int;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);
  -- Solo el userid, leído de la DB, para elegir el lock. Nada de esto decide.
  SELECT userid INTO o FROM app.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('user-balance'), o.userid);

  -- Relectura bajo el lock.
  SELECT id, userid, instrumentid, side, price, status, type INTO o
    FROM app.orders WHERE id = p_order_id;
  IF o.status <> 'NEW' OR o.type <> 'LIMIT' THEN RETURN false; END IF;

  SELECT * INTO vc FROM app.valid_close(o.instrumentid);
  IF vc.close IS NULL THEN
    RAISE EXCEPTION 'NO_PRICE: sin cotización válida para el instrumento %', o.instrumentid
      USING ERRCODE = 'APP01';
  END IF;
  IF NOT ((o.side = 'BUY' AND vc.close <= o.price) OR (o.side = 'SELL' AND vc.close >= o.price)) THEN
    RETURN false;   -- no cruza
  END IF;

  SELECT COALESCE(max(balance_seq), 0) + 1 INTO nxt FROM app.orders WHERE userid = o.userid AND balance_seq IS NOT NULL;
  UPDATE app.orders SET status = 'FILLED', balance_seq = nxt
   WHERE id = p_order_id AND userid = o.userid AND status = 'NEW';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

\echo '=== F.1 cancel_order ==='
CREATE OR REPLACE FUNCTION app.cancel_order(p_userid int, p_order_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM app.deploy_barrier(1::smallint);
  PERFORM pg_advisory_xact_lock(hashtext('user-balance'), p_userid);
  UPDATE app.orders SET status = 'CANCELLED'
   WHERE id = p_order_id AND userid = p_userid AND status = 'NEW';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

\echo '=== F.1 cleanup_idempotency ==='
CREATE OR REPLACE FUNCTION app.cleanup_idempotency(p_userid int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('user-balance'), p_userid) THEN
    RETURN 0;   -- hay una escritura en curso; se intenta en la próxima pasada
  END IF;
  DELETE FROM app.idempotency_keys
   WHERE userid = p_userid AND created_at < now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

\echo '=== trigger orders_guard (A.1 §1.15), con max(balance_seq) sobre el índice parcial ==='
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

\echo '=== F.1 propiedad y privilegios de funciones ==='
ALTER FUNCTION app.div_half_even(numeric, numeric)                                       OWNER TO app_owner;
ALTER FUNCTION app.fold_user(int)                                                        OWNER TO app_owner;
ALTER FUNCTION app.valid_close(int)                                                      OWNER TO app_owner;
ALTER FUNCTION app.read_portfolio(int)                                                   OWNER TO app_owner;
ALTER FUNCTION app.deploy_barrier(smallint)                                              OWNER TO app_owner;
ALTER FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric)  OWNER TO app_owner;
ALTER FUNCTION app.execute_limit(bigint)                                                 OWNER TO app_owner;
ALTER FUNCTION app.cancel_order(int, bigint)                                             OWNER TO app_owner;
ALTER FUNCTION app.cleanup_idempotency(int)                                              OWNER TO app_owner;
ALTER FUNCTION app.orders_guard()                                                        OWNER TO app_owner;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_portfolio(int)                                                  TO api;
GRANT EXECUTE ON FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric) TO api;
GRANT EXECUTE ON FUNCTION app.execute_limit(bigint)                                                TO api;
GRANT EXECUTE ON FUNCTION app.cancel_order(int, bigint)                                            TO api;
GRANT EXECUTE ON FUNCTION app.cleanup_idempotency(int)                                             TO api;
-- fold_user, valid_close, div_half_even y deploy_barrier: solo vía las funciones de arriba.

COMMIT;
\echo '=== FUNCIONES INSTALADAS ==='
