-- Fase 3 / M.1 — Auditoría previa a la migración (solo lectura).
-- Uso: psql $PG -v ON_ERROR_STOP=1 -f bench/sql/00_audit.sql
-- Cada chequeo devuelve un conteo. Al final, un DO aborta si algún conteo
-- bloqueante es distinto de 0. Los duplicados de marketdata se reportan
-- (regla declarada: se conserva el mayor id), no abortan.

\echo '=== M.1 instrumento moneda ==='
SELECT id AS ars_id, ticker, name, type FROM instruments WHERE ticker = 'ARS';

\echo '=== M.1 orders ==='
SELECT 'orders_null_obligatorios' AS chequeo, count(*) AS n FROM orders
 WHERE userid IS NULL OR instrumentid IS NULL OR size IS NULL OR price IS NULL
    OR type IS NULL OR side IS NULL OR status IS NULL OR datetime IS NULL
UNION ALL
SELECT 'orders_size_no_positivo', count(*) FROM orders WHERE size <= 0
UNION ALL
SELECT 'orders_price_no_positivo', count(*) FROM orders WHERE price <= 0
UNION ALL
SELECT 'orders_price_mas_de_2_decimales', count(*) FROM orders WHERE price <> round(price, 2)
UNION ALL
SELECT 'orders_side_fuera_de_dominio', count(*) FROM orders
 WHERE side NOT IN ('BUY','SELL','CASH_IN','CASH_OUT')
UNION ALL
SELECT 'orders_type_fuera_de_dominio', count(*) FROM orders WHERE type NOT IN ('MARKET','LIMIT')
UNION ALL
SELECT 'orders_status_fuera_de_dominio', count(*) FROM orders
 WHERE status NOT IN ('NEW','FILLED','REJECTED','CANCELLED')
UNION ALL
SELECT 'orders_pendiente_no_limit', count(*) FROM orders
 WHERE status IN ('NEW','CANCELLED') AND type <> 'LIMIT'
UNION ALL
SELECT 'orders_cash_mal_formado', count(*) FROM orders
 WHERE side IN ('CASH_IN','CASH_OUT')
   AND (price <> 1 OR type <> 'MARKET'
        OR instrumentid IS DISTINCT FROM (SELECT min(id) FROM instruments WHERE ticker = 'ARS'))
UNION ALL
SELECT 'orders_instrumento_inexistente', count(*) FROM orders o
 WHERE NOT EXISTS (SELECT 1 FROM instruments i WHERE i.id = o.instrumentid)
UNION ALL
SELECT 'orders_usuario_inexistente', count(*) FROM orders o
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.userid)
UNION ALL
SELECT 'orders_cash_size_desborda_x100', count(*) FROM orders
 WHERE side IN ('CASH_IN','CASH_OUT') AND size::bigint * 100 > 2147483647;

\echo '=== M.1 marketdata ==='
SELECT 'md_date_null' AS chequeo, count(*) AS n FROM marketdata WHERE date IS NULL
UNION ALL
SELECT 'md_instrumentid_null', count(*) FROM marketdata WHERE instrumentid IS NULL
UNION ALL
SELECT 'md_close_null', count(*) FROM marketdata WHERE close IS NULL
UNION ALL
SELECT 'md_close_no_positivo', count(*) FROM marketdata WHERE close <= 0
UNION ALL
SELECT 'md_close_mas_de_2_decimales', count(*) FROM marketdata WHERE close <> round(close, 2)
UNION ALL
SELECT 'md_duplicados_instrumento_fecha (reporte, no bloquea)', count(*) FROM (
  SELECT instrumentid, date FROM marketdata GROUP BY 1, 2 HAVING count(*) > 1) d;

\echo '=== M.1 resumen de combinaciones side/type/status ==='
SELECT type, side, status, count(*) AS total FROM orders GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo '=== M.1 veredicto ==='
DO $$
DECLARE
  n_ars  int;
  n_bad  bigint;
  ars    int;
BEGIN
  SELECT count(*) INTO n_ars FROM instruments WHERE ticker = 'ARS';
  IF n_ars <> 1 THEN
    RAISE EXCEPTION 'M.1: se esperaba exactamente 1 instrumento ARS, hay %', n_ars;
  END IF;
  SELECT id INTO ars FROM instruments WHERE ticker = 'ARS';

  SELECT
    (SELECT count(*) FROM orders WHERE userid IS NULL OR instrumentid IS NULL OR size IS NULL
        OR price IS NULL OR type IS NULL OR side IS NULL OR status IS NULL OR datetime IS NULL)
  + (SELECT count(*) FROM orders WHERE size <= 0)
  + (SELECT count(*) FROM orders WHERE price <= 0)
  + (SELECT count(*) FROM orders WHERE price <> round(price, 2))
  + (SELECT count(*) FROM orders WHERE side NOT IN ('BUY','SELL','CASH_IN','CASH_OUT'))
  + (SELECT count(*) FROM orders WHERE type NOT IN ('MARKET','LIMIT'))
  + (SELECT count(*) FROM orders WHERE status NOT IN ('NEW','FILLED','REJECTED','CANCELLED'))
  + (SELECT count(*) FROM orders WHERE status IN ('NEW','CANCELLED') AND type <> 'LIMIT')
  + (SELECT count(*) FROM orders WHERE side IN ('CASH_IN','CASH_OUT')
        AND (price <> 1 OR type <> 'MARKET' OR instrumentid <> ars))
  + (SELECT count(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM instruments i WHERE i.id = o.instrumentid))
  + (SELECT count(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.userid))
  + (SELECT count(*) FROM orders WHERE side IN ('CASH_IN','CASH_OUT') AND size::bigint * 100 > 2147483647)
  + (SELECT count(*) FROM marketdata WHERE date IS NULL OR instrumentid IS NULL OR close IS NULL)
  + (SELECT count(*) FROM marketdata WHERE close <= 0)
  + (SELECT count(*) FROM marketdata WHERE close <> round(close, 2))
  INTO n_bad;

  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'M.1: % hallazgo(s) bloqueante(s); ver conteos arriba. No migrar.', n_bad;
  END IF;

  RAISE NOTICE 'M.1 OK. ars_id = % (usar: psql -v ars_id=%)', ars, ars;
END $$;
