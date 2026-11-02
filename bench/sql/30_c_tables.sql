-- Fase 12 / C §2 — Tablas de snapshot. UNA vez por contenedor (idempotente con IF NOT EXISTS).
-- Uso: psql $PG -v ON_ERROR_STOP=1 -f bench/sql/30_c_tables.sql
-- D-009: snapshot_positions admite qty < 0 con inconsistent = true (historia heredada con venta en
-- corto, D-001); el CHECK original (qty > 0) perdería esas posiciones al publicar.
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS app.balance_snapshots (
  userid           integer PRIMARY KEY REFERENCES app.users(id),
  last_seq         bigint  NOT NULL CHECK (last_seq > 0),
  cash             numeric(18,2) NOT NULL,
  algo_version     smallint NOT NULL,
  has_inconsistent boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.snapshot_positions (
  userid       integer NOT NULL REFERENCES app.balance_snapshots(userid) ON DELETE CASCADE,
  instrumentid integer NOT NULL REFERENCES app.instruments(id),
  qty          bigint  NOT NULL CHECK (qty <> 0),
  cost_total   numeric(24,6) NOT NULL CHECK (cost_total >= 0),
  inconsistent boolean NOT NULL DEFAULT false,
  PRIMARY KEY (userid, instrumentid)
);

-- K: cada cuántos FILLED fuera del snapshot se compacta (C §4.1).
ALTER TABLE app.settings ADD COLUMN IF NOT EXISTS snapshot_k integer NOT NULL DEFAULT 500 CHECK (snapshot_k >= 1);

ALTER TABLE app.balance_snapshots  OWNER TO app_owner;
ALTER TABLE app.snapshot_positions OWNER TO app_owner;
REVOKE ALL ON app.balance_snapshots, app.snapshot_positions FROM PUBLIC, api;

COMMIT;
\echo '=== TABLAS DE C LISTAS ==='
