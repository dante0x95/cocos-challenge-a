-- 090 — Propiedad y privilegios. Repetible, corre al final de cada bootstrap, así cubre
-- también las tablas y funciones que agreguen migraciones futuras.
--
-- app_owner es dueño de todo; las funciones SECURITY DEFINER escriben con sus privilegios.
-- El rol api:
--   · SELECT sobre las tablas que lee directo (búsqueda, GET de órdenes). Nada sobre app.users:
--     el usuario lo resuelve app.read_portfolio (SECURITY DEFINER, APP06 si no existe).
--   · EXECUTE solo sobre las funciones listadas abajo.
--   · Nada sobre idempotency_keys, y ningún INSERT/UPDATE/DELETE.
-- Un test verifica que un UPDATE directo del rol api falla con 42501 (D-17).

ALTER SCHEMA app OWNER TO app_owner;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO app_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER SEQUENCE app.%I OWNER TO app_owner', r.sequencename);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_owner', r.sig);
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO api;

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC, api;
GRANT SELECT ON app.instruments, app.orders, app.marketdata, app.settings TO api;
-- Las bases desplegadas antes del issue #18 tienen SELECT de api sobre app.users. El REVOKE ALL
-- de arriba ya lo saca; este lo dice explícito, para que no dependa de esa línea. Idempotente.
REVOKE SELECT ON app.users FROM api;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, api;
GRANT EXECUTE ON FUNCTION
  app.read_portfolio(int),
  app.place_order(int, text, text, text, text, int, int, numeric, numeric, text),
  app.execute_limit(bigint),
  app.execute_limit_outcome(bigint),
  app.cancel_order(int, bigint),
  app.cancel_order_outcome(int, bigint),
  app.limit_candidates(int),
  app.cleanup_candidates(),
  app.cleanup_idempotency(int),
  app.health()
TO api;
-- Sin EXECUTE para api: c_state e idempotency_ttl (se usan solo desde las funciones de arriba),
-- verify_ledger (bootstrap), y las auxiliares internas.
