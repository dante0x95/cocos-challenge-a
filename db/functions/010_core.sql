-- 010 — Funciones base. Repetible: el bootstrap reaplica todo db/functions en cada corrida.
--
-- Códigos de error propios (SQLSTATE). La API los traduce a HTTP en src/http/errors.ts:
--   APP01 NO_PRICE             → 422  sin cotización válida; no se crea orden ni se consume la clave
--   APP02 BAD_REQUEST          → 400  argumento inválido; nada escrito
--   APP03 IDEMPOTENCY_MISMATCH → 422  misma clave con otro request
--   APP04 VERSION_MISMATCH     → 503  las funciones cambiaron durante un despliegue (reintentable)
--   APP05 DOMAIN_LIMIT         → 422  el resultado saldría de ±10^15 ARS o 2^62 acciones
--   APP06 USER_NOT_FOUND       → 404  el usuario no existe (app.read_portfolio)
--   55P03 / 57014 (lock / statement timeout, los pone Postgres) → 503

-- División entera con redondeo half-even del resto exacto (D-09). b > 0.
CREATE OR REPLACE FUNCTION app.div_half_even(a numeric, b numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT CASE
    WHEN 2 * mod(a, b) < b THEN div(a, b)
    WHEN 2 * mod(a, b) > b THEN div(a, b) + 1
    WHEN mod(div(a, b), 2) = 0 THEN div(a, b)
    ELSE div(a, b) + 1
  END
$$;

-- Última cotización válida de un instrumento (D-06): fecha ≤ hoy en Buenos Aires y, si
-- settings.price_max_age_days no es NULL, no más vieja que esa cantidad de días.
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

-- Plazo de vida de una clave de idempotencia (D-19): settings.idempotency_ttl, 24 h por defecto.
-- Única fuente del plazo. Una clave está vencida si created_at < now() - app.idempotency_ttl(),
-- con el now() del inicio de la transacción. Lo aplican place_order (reusa una clave vencida al
-- reclamarla, bajo el lock) y la limpieza (recupera el espacio un minuto después:
-- app.idempotency_purge_age(), en 040_ops.sql).
CREATE OR REPLACE FUNCTION app.idempotency_ttl() RETURNS interval
LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT s.idempotency_ttl FROM app.settings s
$$;

-- Barrera de despliegue (D-24). Toda escritura la toma en modo compartido ANTES del lock de
-- usuario; el bootstrap la toma en modo exclusivo mientras aplica migraciones y funciones.
-- Mientras haya escritores en curso, el despliegue espera; cuando termina, todo escritor nuevo
-- ve el esquema y las funciones nuevas juntos.
CREATE OR REPLACE FUNCTION app.deploy_barrier() RETURNS void
LANGUAGE sql SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT pg_advisory_xact_lock_shared(hashtext('deploy'))
$$;

-- Lock de usuario: serializa todas las escrituras de un usuario (D-17).
CREATE OR REPLACE FUNCTION app.lock_user(p_userid int) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtext('user-balance'), p_userid)
$$;

CREATE OR REPLACE FUNCTION app.try_lock_user(p_userid int) RETURNS boolean
LANGUAGE sql SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT pg_try_advisory_xact_lock(hashtext('user-balance'), p_userid)
$$;
