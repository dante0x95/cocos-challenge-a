-- 030 — Escritura de órdenes. Repetible.
--
-- Protocolo (D-17), igual en las tres funciones:
--   1. barrera de despliegue (compartida)       → deploy_barrier()
--   2. lock del usuario, ANTES de leer nada que decida
--   3. leer estado (todas las órdenes ejecutadas), decidir, escribir
-- Todo en una transacción. Son SECURITY DEFINER: corren como app_owner, el único que puede
-- escribir orders. La API solo tiene EXECUTE sobre ellas.
--
-- Tiempos (D-20): cada escritura es UNA sentencia de la API (`SELECT app.<función>(...)`), así
-- que el statement_timeout del rol api (5 s) es el presupuesto total, y lo hace cumplir la base
-- sin cancelar desde otra conexión. El lock_timeout (2 s) va como cláusula SET de cada función
-- que espera el lock de usuario: rige con cualquier conexión, y el llamador no lo puede ampliar.

-- Alta de una orden. Devuelve jsonb { status, body, replay, order_id }.
--   p_size XOR p_amount (D-11). Con p_amount (pesos, ≤ 2 decimales) la cantidad se calcula
--   bajo el lock con el precio de ejecución: floor(amount / precio); 0 → APP02.
--   Para CASH_IN/CASH_OUT solo p_amount; size = centavos (D-05).
--   p_limit: precio límite, obligatorio en LIMIT y prohibido en MARKET.
--   p_instrumentid: NULL en CASH_IN/CASH_OUT; se resuelve ARS acá (la API no necesita su id).
--   p_legacy_hash: transición del issue #4 (D-19). Hash que calculaba la versión anterior para este
--   mismo request; solo sirve para reconocer una clave que ya existe. Una clave nueva guarda siempre
--   p_hash. Se quita cuando ya no queda ninguna clave grabada antes del despliegue que place_order
--   no pueda reclamar: app.idempotency_reclaim_age() (24 h + 1 min) después, sin esperar a la
--   limpieza, porque place_order reusa una clave reclamable.
-- La firma anterior (sin p_legacy_hash) se borra para que no quede una sobrecarga ambigua.
DROP FUNCTION IF EXISTS app.place_order(int, text, text, text, text, int, int, numeric, numeric);
CREATE OR REPLACE FUNCTION app.place_order(
  p_userid int, p_key text, p_hash text,
  p_side text, p_type text, p_instrumentid int, p_size int, p_amount numeric, p_limit numeric,
  p_legacy_hash text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  k_ars       int;
  inst_type   text;
  claimed     text;
  prev        record;
  vc          record;
  price       numeric(18,2);
  imp         numeric;            -- importe en centavos
  v_cash      bigint;
  v_last_seq  bigint;
  pos_qty     bigint;
  pos_cost    numeric;             -- costo de la posición en micro-ARS
  res         record;
  new_status  text;
  new_seq     bigint;
  new_id      bigint;
  body        jsonb;
  ts          timestamp := timezone('UTC', now());
  is_cash     boolean := p_side IN ('CASH_IN','CASH_OUT');
  v_size      bigint;
  v_qty       numeric;
  over_cap    boolean := false;   -- LIMIT fuera del tope: 422 después del bloque de idempotencia
BEGIN
  PERFORM app.deploy_barrier();

  -- Validación de argumentos: sin escritura, antes del lock.
  IF p_key IS NULL OR p_key = '' OR p_hash IS NULL THEN
    RAISE EXCEPTION 'idempotency key y hash obligatorios' USING ERRCODE = 'APP02';
  END IF;
  IF p_side IS NULL OR p_side NOT IN ('BUY','SELL','CASH_IN','CASH_OUT') THEN
    RAISE EXCEPTION 'side inválido: %', p_side USING ERRCODE = 'APP02';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('MARKET','LIMIT') THEN
    RAISE EXCEPTION 'type inválido: %', p_type USING ERRCODE = 'APP02';
  END IF;
  IF (p_size IS NULL) = (p_amount IS NULL) THEN
    RAISE EXCEPTION 'enviar size o amount, exactamente uno' USING ERRCODE = 'APP02';
  END IF;
  IF p_size IS NOT NULL AND p_size <= 0 THEN
    RAISE EXCEPTION 'size debe ser > 0' USING ERRCODE = 'APP02';
  END IF;
  IF p_amount IS NOT NULL AND (p_amount <= 0 OR p_amount <> round(p_amount, 2)) THEN
    RAISE EXCEPTION 'amount debe ser > 0 con a lo sumo 2 decimales' USING ERRCODE = 'APP02';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.users u WHERE u.id = p_userid) THEN
    RAISE EXCEPTION 'usuario % inexistente', p_userid USING ERRCODE = 'APP02';
  END IF;
  SELECT i.id INTO k_ars FROM app.instruments i WHERE i.ticker = 'ARS';
  IF is_cash AND p_instrumentid IS NULL THEN
    p_instrumentid := k_ars;
  END IF;
  SELECT i.type INTO inst_type FROM app.instruments i WHERE i.id = p_instrumentid;
  IF inst_type IS NULL THEN
    RAISE EXCEPTION 'instrumento % inexistente', p_instrumentid USING ERRCODE = 'APP02';
  END IF;

  IF is_cash THEN
    IF p_type <> 'MARKET' OR p_limit IS NOT NULL OR p_instrumentid <> k_ars OR p_size IS NOT NULL THEN
      RAISE EXCEPTION 'un movimiento de cash es MARKET, sobre ARS, por amount y sin precio' USING ERRCODE = 'APP02';
    END IF;
    price := 0.01;
  ELSE
    IF inst_type = 'MONEDA' THEN
      RAISE EXCEPTION 'BUY/SELL no aplica sobre una moneda' USING ERRCODE = 'APP02';
    END IF;
    IF p_type = 'MARKET' AND p_limit IS NOT NULL THEN
      RAISE EXCEPTION 'una orden MARKET no lleva precio' USING ERRCODE = 'APP02';
    END IF;
    IF p_type = 'LIMIT' THEN
      IF p_limit IS NULL OR p_limit <= 0 OR p_limit <> round(p_limit, 2) THEN
        RAISE EXCEPTION 'una orden LIMIT requiere precio > 0 con a lo sumo 2 decimales' USING ERRCODE = 'APP02';
      END IF;
      -- Tope por orden (D-14), antes de asignar `price` (numeric(18,2)): un precio o un importe por
      -- encima de 10^15 ARS nunca podría ejecutarse. El 422 sale después del bloque de
      -- idempotencia: una clave grabada antes del tope guarda la respuesta que dio la versión
      -- anterior (D-19), y la clave se lee bajo el lock (D-17).
      over_cap := p_limit > 1e15 OR (p_size IS NOT NULL AND p_size::numeric * p_limit > 1e15);
      IF NOT over_cap THEN
        price := p_limit;
      END IF;
    END IF;
  END IF;

  PERFORM app.lock_user(p_userid);

  -- Idempotencia (D-19). La clave se reclama si no existe o si created_at es anterior a
  -- now() - app.idempotency_reclaim_age() (el plazo más un minuto, issue #38), con el now() del
  -- inicio de la transacción: el margen impide que un request posterior que toma el lock primero
  -- reclame la clave antes de que la use un reintento que empezó dentro del plazo. La limpieza
  -- borra después (app.idempotency_purge_age()) y solo recupera espacio: el vencimiento no
  -- depende de que corra. Una clave reclamada se reusa en el lugar, con hash y created_at nuevos y
  -- sin la respuesta anterior; si este request falla, la transacción se revierte y la fila queda
  -- como estaba. Si no se reclama, el replay devuelve la respuesta original y sale: no lee
  -- estado, no decide de nuevo.
  INSERT INTO app.idempotency_keys (userid, key, request_hash)
  VALUES (p_userid, p_key, p_hash)
  ON CONFLICT (userid, key) DO UPDATE
    SET request_hash = EXCLUDED.request_hash, created_at = now(),
        http_status = NULL, response_body = NULL, order_id = NULL
    WHERE idempotency_keys.created_at < now() - app.idempotency_reclaim_age()
  RETURNING key INTO claimed;
  IF claimed IS NULL THEN
    SELECT request_hash, http_status, response_body, order_id INTO prev
      FROM app.idempotency_keys WHERE userid = p_userid AND key = p_key;
    IF prev.request_hash <> p_hash AND prev.request_hash IS DISTINCT FROM p_legacy_hash THEN
      RAISE EXCEPTION 'la clave % ya se usó con otro request', p_key USING ERRCODE = 'APP03';
    END IF;
    RETURN jsonb_build_object('status', prev.http_status, 'body', prev.response_body,
                              'replay', true, 'order_id', prev.order_id::text);
  END IF;
  IF over_cap THEN
    RAISE EXCEPTION 'el importe de la orden supera 10^15 ARS' USING ERRCODE = 'APP05';
  END IF;

  -- Precio de ejecución de una MARKET (D-12). Sin cotización: excepción; la transacción se
  -- revierte y con ella el reclamo de la clave.
  IF NOT is_cash AND p_type = 'MARKET' THEN
    SELECT * INTO vc FROM app.valid_close(p_instrumentid);
    IF vc.close IS NULL THEN
      RAISE EXCEPTION 'sin cotización válida para el instrumento %', p_instrumentid USING ERRCODE = 'APP01';
    END IF;
    price := vc.close;
  END IF;

  -- Cantidad (D-11), con el precio ya resuelto.
  IF p_size IS NOT NULL THEN
    v_qty := p_size;
  ELSIF is_cash THEN
    v_qty := p_amount * 100;
  ELSE
    -- División entera exacta en centavos (D-11, D-13). `floor(p_amount / price)` no sirve: la
    -- división numeric redondea el cociente a 16 dígitos significativos antes del floor, y con
    -- amount = 2 × price − 0,01 daba 2 en vez de 1.
    v_qty := div(p_amount * 100, price * 100);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'amount % no alcanza para una acción a %', p_amount, price USING ERRCODE = 'APP02';
    END IF;
  END IF;
  -- Se acota como numeric, antes del cast: un amount sin máximo da un cociente que no entra en bigint.
  IF v_qty > 2147483647 THEN
    RAISE EXCEPTION 'la cantidad supera el máximo por orden (2147483647)' USING ERRCODE = 'APP02';
  END IF;
  v_size := v_qty;
  -- Tope por orden (D-14) con el precio ya resuelto (MARKET, o LIMIT por amount): size × price
  -- ≤ 10^15 ARS, así el importe entra en numeric(20,0) y el amount de la respuesta en numeric(18,2).
  IF v_size::numeric * price > 1e15 THEN
    RAISE EXCEPTION 'el importe de la orden supera 10^15 ARS' USING ERRCODE = 'APP05';
  END IF;
  imp := (v_size::numeric * price * 100)::numeric(20,0);

  -- Estado bajo el lock: una pasada del fold y las reservas. Una historia fuera de los tipos
  -- falla acá con APP07 (409, issue #57): la transacción se revierte con el reclamo de la clave,
  -- y una clave grabada antes sigue dando su replay (el bloque de idempotencia no pliega).
  SELECT max(s.cash_cents) FILTER (WHERE s.kind = 0),
         max(s.last_seq)   FILTER (WHERE s.kind = 0),
         COALESCE(max(s.qty) FILTER (WHERE s.kind = 1 AND s.instrumentid = p_instrumentid), 0),
         COALESCE(max(s.cost_total) FILTER (WHERE s.kind = 1 AND s.instrumentid = p_instrumentid), 0)
    INTO v_cash, v_last_seq, pos_qty, pos_cost
    FROM app.c_state(p_userid) s;
  SELECT COALESCE(sum(CASE WHEN o.side = 'BUY' THEN o.size::numeric * o.price * 100 END), 0)             AS cash,
         COALESCE(sum(CASE WHEN o.side = 'SELL' AND o.instrumentid = p_instrumentid THEN o.size END), 0) AS shares
    INTO res
    FROM app.orders o WHERE o.userid = p_userid AND o.status = 'NEW';

  -- Decisión (D-08).
  CASE p_side
    WHEN 'CASH_IN' THEN
      new_status := 'FILLED';
    WHEN 'CASH_OUT' THEN
      new_status := CASE WHEN v_cash - res.cash >= imp THEN 'FILLED' ELSE 'REJECTED' END;
    WHEN 'BUY' THEN
      new_status := CASE WHEN v_cash - res.cash < imp THEN 'REJECTED'
                         WHEN p_type = 'MARKET' THEN 'FILLED' ELSE 'NEW' END;
    WHEN 'SELL' THEN
      new_status := CASE WHEN pos_qty - res.shares < v_size THEN 'REJECTED'
                         WHEN p_type = 'MARKET' THEN 'FILLED' ELSE 'NEW' END;
  END CASE;

  -- Límites de dominio (D-14), solo si el movimiento se confirma.
  IF new_status = 'FILLED' THEN
    IF p_side IN ('CASH_IN','SELL') AND abs(v_cash + imp) > 1e17
       OR p_side IN ('CASH_OUT','BUY') AND abs(v_cash - imp) > 1e17 THEN
      RAISE EXCEPTION 'el cash quedaría fuera de ±10^15 ARS' USING ERRCODE = 'APP05';
    END IF;
    IF p_side = 'BUY' AND pos_qty + v_size > 4611686018427387904 THEN
      RAISE EXCEPTION 'la posición superaría 2^62 acciones' USING ERRCODE = 'APP05';
    END IF;
    -- El costo de una posición no lo acota el cash (se puede depositar y comprar muchas veces):
    -- tope propio de 10^17 ARS = 10^23 micro-ARS, con margen 10× sobre numeric(24,0).
    IF p_side = 'BUY' AND pos_cost + imp * 10000 > 1e23 THEN
      RAISE EXCEPTION 'el costo de la posición superaría 10^17 ARS' USING ERRCODE = 'APP05';
    END IF;
    new_seq := v_last_seq + 1;
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
    'datetime',     to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'cancel_reason', NULL);   -- una orden nueva nunca está CANCELLED; va para que la forma sea la de GET

  UPDATE app.idempotency_keys SET order_id = new_id, http_status = 201, response_body = body
   WHERE userid = p_userid AND key = p_key;

  RETURN jsonb_build_object('status', 201, 'body', body, 'replay', false, 'order_id', new_id::text);
END $$;

-- ¿Tiene respaldo una LIMIT NEW con `p_cash` de cash y `p_qty` acciones de su instrumento? Se
-- llama bajo el lock. Una venta necesita esas acciones; una compra, ese cash (size × price). Lo
-- que la propia orden reserva no cuenta en contra: es lo que está por ejecutar (una SELL por toda
-- la tenencia tiene respaldo). Una orden sobre una MONEDA nunca lo tiene: BUY/SELL no aplica sobre
-- una moneda, y el CHECK orders_cash_shape no lo impide para una compra.
-- El executor pasa el cash y la tenencia tal cual: el respaldo se evalúa al ejecutar y la que
-- cruza primero se lleva lo que hay. El bootstrap descuenta lo que reservan las NEW que conserva
-- (cancel_unbacked). En régimen siempre da true: place_order no deja una NEW sin respaldo y
-- ninguna escritura posterior gasta lo reservado. Da false solo con una NEW heredada (D-24,
-- D-12), insertada en orders sin pasar por place_order (issue #6).
CREATE OR REPLACE FUNCTION app.limit_backed(p_order app.orders, p_cash numeric, p_qty numeric) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM app.instruments i WHERE i.id = p_order.instrumentid AND i.type = 'MONEDA')
     AND CASE p_order.side
           WHEN 'SELL' THEN p_qty >= p_order.size
           WHEN 'BUY'  THEN p_cash >= p_order.size::numeric * p_order.price * 100
           ELSE false
         END
$$;

-- Ejecuta una LIMIT pendiente si la cotización vigente la cruza (BUY: close ≤ límite;
-- SELL: close ≥ límite), a su precio límite (D-12). Devuelve:
--   'FILLED'   la ejecutó;
--   'SKIPPED'  no la tocó: ya no estaba NEW o la cotización no la cruza;
--   'UNBACKED' no tiene respaldo (limit_backed: SELL sin esas acciones, BUY sin ese cash, o sobre
--              una MONEDA): la canceló con cancel_reason = 'UNBACKED'. Solo pasa con una NEW
--              heredada, insertada en orders sin pasar por place_order; en régimen lo reservado
--              al crearla es exactamente lo que se ejecuta (issue #6).
--   'LIMIT'    viola D-14: su importe (size × price) supera 10^15 ARS (solo una NEW heredada,
--              issue #41), o ejecutarla dejaría el estado fuera de los límites (SELL: cash +
--              importe > 10^15 ARS; BUY: posición + size > 2^62 acciones o costo + importe >
--              10^17 ARS): la canceló con cancel_reason = 'LIMIT'.
-- En los dos casos la orden sale del executor, libera su reserva y el motivo queda en ella.
-- Si la historia del usuario no entra en los tipos, el fold falla con APP07 (issue #57) y la
-- orden sigue NEW: sin fold no se puede decidir el respaldo, y corregir la historia podría
-- dejarla válida. El executor saltea al usuario (overflow_users).
-- El respaldo y D-14 se revalidan bajo el lock, con una sola lectura del estado. Una BUY con
-- respaldo no puede dejar el cash negativo ni una SELL la posición: de D-14 solo quedan por
-- validar el cash de una SELL y la posición y el costo de una BUY.
CREATE OR REPLACE FUNCTION app.execute_limit_outcome(p_order_id bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp SET lock_timeout = '2s' AS $$
DECLARE uid int; o app.orders%ROWTYPE; vc record; v_cash bigint; pos_qty bigint; pos_cost numeric; nxt bigint; n int;
BEGIN
  PERFORM app.deploy_barrier();
  -- El userid sale de la DB, no del llamador; solo sirve para elegir el lock.
  SELECT userid INTO uid FROM app.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN 'SKIPPED'; END IF;
  PERFORM app.lock_user(uid);

  -- Relectura bajo el lock: pudo haberse cancelado o ejecutado mientras esperábamos.
  SELECT * INTO o FROM app.orders WHERE id = p_order_id;
  IF o.status <> 'NEW' OR o.type <> 'LIMIT' THEN
    RETURN 'SKIPPED';
  END IF;
  SELECT * INTO vc FROM app.valid_close(o.instrumentid);
  IF vc.close IS NULL THEN
    RAISE EXCEPTION 'sin cotización válida para el instrumento %', o.instrumentid USING ERRCODE = 'APP01';
  END IF;
  IF NOT ((o.side = 'BUY' AND vc.close <= o.price) OR (o.side = 'SELL' AND vc.close >= o.price)) THEN
    RETURN 'SKIPPED';
  END IF;

  -- Tope por orden (D-14, issue #41): una orden con importe (size × price) por encima de 10^15
  -- ARS no se ejecuta, aunque el resultado quede dentro de los límites (cash −0,03 y una SELL de
  -- 2 a 500.000.000.000.000,01 dejaría el cash en 999.999.999.999.999,99). Es la validación de
  -- place_order, que no la graba: solo la puede tener una NEW heredada. Va antes del respaldo y
  -- del fold: es una propiedad de la orden, no del estado, así que el motivo no depende del cash
  -- ni de la tenencia del momento (por encima del tope y sin respaldo es LIMIT, igual que la
  -- cancela el bootstrap con cancel_over_cap) y no hace falta leer el fold para decidirla.
  IF o.size::numeric * o.price > 1e15 THEN
    UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'LIMIT'
     WHERE id = p_order_id AND userid = o.userid AND status = 'NEW';
    RETURN 'LIMIT';
  END IF;

  -- Estado bajo el lock: una pasada del fold para el respaldo y para D-14.
  SELECT max(s.cash_cents) FILTER (WHERE s.kind = 0),
         COALESCE(max(s.qty) FILTER (WHERE s.kind = 1 AND s.instrumentid = o.instrumentid), 0),
         COALESCE(max(s.cost_total) FILTER (WHERE s.kind = 1 AND s.instrumentid = o.instrumentid), 0)
    INTO v_cash, pos_qty, pos_cost
    FROM app.c_state(o.userid) s;

  -- Respaldo (issue #6): una NEW heredada sin acciones o sin cash no se ejecuta; ejecutarla
  -- dejaría la posición en corto o el cash negativo, y eso ya no sería historia sino una
  -- decisión del sistema (D-01).
  IF NOT app.limit_backed(o, v_cash, pos_qty) THEN
    UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'UNBACKED'
     WHERE id = p_order_id AND userid = o.userid AND status = 'NEW';
    RETURN 'UNBACKED';
  END IF;

  -- Límites de dominio (D-14). El cash puede haber crecido desde que se creó la orden, así que
  -- no alcanza con validar al crearla.
  IF o.side = 'SELL' AND v_cash + o.size::numeric * o.price * 100 > 1e17
     OR o.side = 'BUY' AND (pos_qty::numeric + o.size > 4611686018427387904
                            OR pos_cost + o.size::numeric * o.price * 1000000 > 1e23) THEN
    UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'LIMIT'
     WHERE id = p_order_id AND userid = o.userid AND status = 'NEW';
    RETURN 'LIMIT';
  END IF;

  SELECT COALESCE(max(balance_seq), 0) + 1 INTO nxt
    FROM app.orders WHERE userid = o.userid AND balance_seq IS NOT NULL;
  UPDATE app.orders SET status = 'FILLED', balance_seq = nxt
   WHERE id = p_order_id AND userid = o.userid AND status = 'NEW';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n > 0 THEN 'FILLED' ELSE 'SKIPPED' END;
END $$;

-- La misma ejecución, como booleano: true si la ejecutó. Una LIMIT cancelada por D-14 o sin
-- respaldo da false; el executor usa execute_limit_outcome para informarla aparte.
CREATE OR REPLACE FUNCTION app.execute_limit(p_order_id bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT app.execute_limit_outcome(p_order_id) = 'FILLED'
$$;

-- Cancela una orden NEW del usuario (cancel_reason = 'USER') y dice qué pasó, en la misma
-- sentencia (sin releer):
--   'ok'         la canceló; devuelve la orden ya CANCELLED.
--   'not_found'  no existe o es de otro usuario: sin columnas de la orden, para no revelar
--                nada de una ajena (D-26).
--   'not_new'    es del usuario pero ya no está NEW; devuelve la orden con su estado actual.
-- La orden se lee bajo el lock, así que el motivo es el del momento de la decisión.
-- La versión anterior devolvía la orden sin cancel_reason (issue #21). Cambiar las columnas de
-- RETURNS TABLE exige borrarla; se borra solo si es esa versión, así una segunda corrida del
-- bootstrap la reemplaza en el lugar y no le quita el EXECUTE a la API ni por un instante.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid = to_regprocedure('app.cancel_order_outcome(int, bigint)')
                AND NOT ('cancel_reason' = ANY (proargnames))) THEN
    DROP FUNCTION app.cancel_order_outcome(int, bigint);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION app.cancel_order_outcome(p_userid int, p_order_id bigint)
RETURNS TABLE (outcome text, id int, userid int, instrumentid int, side text, type text,
               size int, price numeric, status text, balance_seq bigint, datetime timestamp,
               cancel_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp SET lock_timeout = '2s' AS $$
DECLARE o app.orders%ROWTYPE; n int;
BEGIN
  PERFORM app.deploy_barrier();
  PERFORM app.lock_user(p_userid);
  UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'USER'
   WHERE orders.id = p_order_id AND orders.userid = p_userid AND orders.status = 'NEW';
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT * INTO o FROM app.orders WHERE orders.id = p_order_id AND orders.userid = p_userid;
  IF NOT FOUND THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;
  outcome := CASE WHEN n > 0 THEN 'ok' ELSE 'not_new' END;
  id := o.id; userid := o.userid; instrumentid := o.instrumentid; side := o.side; type := o.type;
  size := o.size; price := o.price; status := o.status; balance_seq := o.balance_seq; datetime := o.datetime;
  cancel_reason := o.cancel_reason;
  RETURN NEXT;
END $$;

-- La misma cancelación, como booleano: true si la canceló.
CREATE OR REPLACE FUNCTION app.cancel_order(p_userid int, p_order_id bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT outcome = 'ok' FROM app.cancel_order_outcome(p_userid, p_order_id)
$$;

-- LIMITs pendientes que la cotización vigente cruza, para el executor (D-28), que después llama
-- execute_limit_outcome por cada una: la decisión final se toma ahí, bajo el lock.
--   p_max       tamaño del lote.
--   p_after     cursor: solo órdenes con id > p_after (0 = desde el principio).
--   p_per_user  a lo sumo N órdenes por usuario, aplicado ANTES del LIMIT: un usuario con
--               miles de pendientes no llena el lote solo.
-- Devuelve también userid e instrumentid, para que el executor saltee las demás de un usuario
-- cuyo lock no consiguió o de un instrumento que se quedó sin cotización, sin otra consulta.
-- Costo (issue #9): la cotización se resuelve UNA vez por instrumento (CTE materializado) y las
-- órdenes se buscan por rango en el índice (instrumentid, side, price) WHERE NEW/LIMIT (008):
-- nada se evalúa por fila pendiente. El reparto y el orden final solo tocan las que cruzan.
-- La firma anterior (solo p_max, una columna) se borra: cambian las columnas del resultado.
DROP FUNCTION IF EXISTS app.limit_candidates(int);
CREATE OR REPLACE FUNCTION app.limit_candidates(p_max int DEFAULT 500, p_after bigint DEFAULT 0, p_per_user int DEFAULT 50)
RETURNS TABLE (order_id bigint, userid int, instrumentid int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  WITH quote AS MATERIALIZED (
    SELECT i.id AS instrumentid, vc.close
      FROM app.instruments i
      CROSS JOIN LATERAL app.valid_close(i.id) vc
     WHERE vc.close IS NOT NULL
  ), crossing AS (
    -- Un rango del índice por instrumento y lado. OFFSET 0 impide que el planificador aplane la
    -- subconsulta y la cambie por un hash join con recorrido completo de las pendientes, que es
    -- lo que elige cuando estima que un tercio de ellas cruza.
    SELECT c.id, c.userid, c.instrumentid
      FROM quote q
      CROSS JOIN LATERAL (
        SELECT o.id, o.userid, o.instrumentid
          FROM app.orders o
         WHERE o.status = 'NEW' AND o.type = 'LIMIT' AND o.id > p_after
           AND o.instrumentid = q.instrumentid AND o.side = 'BUY' AND o.price >= q.close
        OFFSET 0) c
    UNION ALL
    SELECT c.id, c.userid, c.instrumentid
      FROM quote q
      CROSS JOIN LATERAL (
        SELECT o.id, o.userid, o.instrumentid
          FROM app.orders o
         WHERE o.status = 'NEW' AND o.type = 'LIMIT' AND o.id > p_after
           AND o.instrumentid = q.instrumentid AND o.side = 'SELL' AND o.price <= q.close
        OFFSET 0) c
  ), ranked AS (
    SELECT c.id, c.userid, c.instrumentid, row_number() OVER (PARTITION BY c.userid ORDER BY c.id) AS rn
      FROM crossing c
  )
  SELECT r.id::bigint, r.userid, r.instrumentid
    FROM ranked r
   WHERE r.rn <= p_per_user
   ORDER BY r.id
   LIMIT p_max
$$;
