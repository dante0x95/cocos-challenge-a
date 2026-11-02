-- Fase 5 / F.1 — Esquema app, roles, secuencia y privilegios sobre tablas. UNA vez por contenedor.
-- Uso: psql $PG -v ON_ERROR_STOP=1 -f bench/sql/20_schema_roles.sql
-- Prerrequisito: 10_migrate.sql aplicado. Las funciones van en 21_functions.sql (idempotente).
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

\echo '=== F.1 esquema app y roles ==='
CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
    CREATE ROLE api LOGIN PASSWORD 'api';
  END IF;
END $$;

ALTER TABLE public.users            SET SCHEMA app;
ALTER TABLE public.instruments      SET SCHEMA app;
ALTER TABLE public.orders           SET SCHEMA app;
ALTER TABLE public.marketdata       SET SCHEMA app;
ALTER TABLE public.idempotency_keys SET SCHEMA app;
ALTER TABLE public.settings         SET SCHEMA app;
ALTER FUNCTION public.orders_guard() SET SCHEMA app;
ALTER FUNCTION app.orders_guard() SET search_path = pg_catalog, app, pg_temp;

-- orders.id necesita default por secuencia (el dump puede traerla o no).
DO $$
DECLARE seq text;
BEGIN
  seq := pg_get_serial_sequence('app.orders', 'id');
  IF seq IS NULL THEN
    CREATE SEQUENCE app.orders_id_seq OWNED BY app.orders.id;
    ALTER TABLE app.orders ALTER COLUMN id SET DEFAULT nextval('app.orders_id_seq');
    seq := 'app.orders_id_seq';
  END IF;
  PERFORM setval(seq, COALESCE((SELECT max(id) FROM app.orders), 0) + 1, false);
END $$;

-- A.1 §3.2 (enmienda, D-005): antigüedad máxima de una cotización para considerarla válida.
-- NULL = sin límite (necesario para los datos del challenge, de 2023). 7 = regla de A §5.1.
ALTER TABLE app.settings ADD COLUMN IF NOT EXISTS price_max_age_days integer
  CHECK (price_max_age_days IS NULL OR price_max_age_days > 0);

ALTER SCHEMA app OWNER TO app_owner;
ALTER TABLE app.users            OWNER TO app_owner;
ALTER TABLE app.instruments      OWNER TO app_owner;
ALTER TABLE app.orders           OWNER TO app_owner;
ALTER TABLE app.marketdata       OWNER TO app_owner;
ALTER TABLE app.idempotency_keys OWNER TO app_owner;
ALTER TABLE app.settings         OWNER TO app_owner;
ALTER FUNCTION app.orders_guard() OWNER TO app_owner;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO api;
GRANT SELECT ON app.users, app.instruments, app.orders, app.marketdata, app.settings TO api;
ALTER ROLE api SET search_path = app, public;
ALTER ROLE api SET idle_in_transaction_session_timeout = '30s';
DO $$
DECLARE s record;
BEGIN
  FOR s IN SELECT sequence_schema, sequence_name FROM information_schema.sequences
            WHERE sequence_schema IN ('app', 'public') LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO app_owner', s.sequence_schema, s.sequence_name);
  END LOOP;
END $$;

COMMIT;
\echo '=== ESQUEMA Y ROLES LISTOS ==='
