#!/bin/bash
# Si el dump trae el esquema app (bench.dump), recrea roles, propiedad y privilegios de F.1:
# pg_dump/pg_restore con --no-owner --no-privileges no los conserva. Para trading.dump no hace nada
# (los crea 21_functions.sql).
set -e
if psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_namespace WHERE nspname = 'app'" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN CREATE ROLE app_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN CREATE ROLE api LOGIN PASSWORD 'api'; END IF;
END $$;
ALTER SCHEMA app OWNER TO app_owner;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO app_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER SEQUENCE app.%I OWNER TO app_owner', r.sequencename);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_owner', r.sig);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO api;
GRANT SELECT ON app.users, app.instruments, app.orders, app.marketdata, app.settings TO api;
GRANT EXECUTE ON FUNCTION app.read_portfolio(int) TO api;
GRANT EXECUTE ON FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric) TO api;
GRANT EXECUTE ON FUNCTION app.execute_limit(bigint) TO api;
GRANT EXECUTE ON FUNCTION app.cancel_order(int, bigint) TO api;
GRANT EXECUTE ON FUNCTION app.cleanup_idempotency(int) TO api;
ALTER ROLE api SET search_path = app, public;
ALTER ROLE api SET idle_in_transaction_session_timeout = '30s';
SQL
  echo "02-grants: roles y privilegios F.1 aplicados sobre el esquema app"
fi
