-- 001 — Esquema `app` y roles.
--
-- Las tablas del challenge pasan del esquema `public` a `app`. Así los privilegios se
-- administran en un solo lugar y nada fuera de `app` queda expuesto al rol de la API.
--
-- Roles (son globales al servidor, por eso se crean solo si no existen):
--   app_owner  NOLOGIN. Dueño de tablas y funciones. Las funciones SECURITY DEFINER
--              corren con sus privilegios: es el único que escribe `orders`.
--   api        LOGIN. Lo usa la API. SELECT sobre las tablas de lectura y EXECUTE sobre
--              las funciones públicas. Sin INSERT/UPDATE/DELETE (ver docs/decisiones.md, D-17).
-- La contraseña de `api` la fija el bootstrap desde API_DB_PASSWORD.

CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
    CREATE ROLE api LOGIN;
  END IF;
END $$;

ALTER TABLE public.users       SET SCHEMA app;
ALTER TABLE public.instruments SET SCHEMA app;
ALTER TABLE public.orders      SET SCHEMA app;
ALTER TABLE public.marketdata  SET SCHEMA app;

-- Configuración por base de datos (no global): la API ve `app` primero y ninguna
-- sentencia suya puede tardar más de 5 s ni dejar una transacción abierta más de 30 s.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE api IN DATABASE %I SET search_path = app, public', current_database());
  EXECUTE format('ALTER ROLE api IN DATABASE %I SET statement_timeout = %L', current_database(), '5s');
  EXECUTE format('ALTER ROLE api IN DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '30s');
END $$;
