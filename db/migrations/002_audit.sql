-- 002 — Auditoría de los datos recibidos, antes de transformarlos. No escribe nada.
--
-- Cada chequeo cuenta filas que violan una regla que la migración 003 va a imponer con
-- NOT NULL o CHECK. Si alguno es distinto de 0, la migración aborta acá con el detalle,
-- en vez de fallar a mitad de un ALTER TABLE con un mensaje genérico.
-- Lo que no bloquea (duplicados en marketdata) se informa con NOTICE.

DO $$
DECLARE
  n_ars  int;
  ars    int;
  c      record;
  n_bad  bigint := 0;
  n      bigint;
BEGIN
  SELECT count(*), min(id) INTO n_ars, ars FROM app.instruments WHERE ticker = 'ARS';
  IF n_ars <> 1 THEN
    RAISE EXCEPTION 'auditoría: se esperaba exactamente 1 instrumento ARS, hay %', n_ars;
  END IF;

  FOR c IN
    SELECT * FROM (VALUES
      ('orders con campos obligatorios en NULL',
       'SELECT count(*) FROM app.orders WHERE userid IS NULL OR instrumentid IS NULL OR size IS NULL OR price IS NULL OR type IS NULL OR side IS NULL OR status IS NULL OR datetime IS NULL'),
      ('orders con size <= 0',              'SELECT count(*) FROM app.orders WHERE size <= 0'),
      ('orders con price <= 0',             'SELECT count(*) FROM app.orders WHERE price <= 0'),
      ('orders con más de 2 decimales',     'SELECT count(*) FROM app.orders WHERE price <> round(price, 2)'),
      ('orders con side fuera de dominio',  $q$SELECT count(*) FROM app.orders WHERE side NOT IN ('BUY','SELL','CASH_IN','CASH_OUT')$q$),
      ('orders con type fuera de dominio',  $q$SELECT count(*) FROM app.orders WHERE type NOT IN ('MARKET','LIMIT')$q$),
      ('orders con status fuera de dominio',$q$SELECT count(*) FROM app.orders WHERE status NOT IN ('NEW','FILLED','REJECTED','CANCELLED')$q$),
      ('orders NEW/CANCELLED que no son LIMIT', $q$SELECT count(*) FROM app.orders WHERE status IN ('NEW','CANCELLED') AND type <> 'LIMIT'$q$),
      ('movimientos cash mal formados',     format($q$SELECT count(*) FROM app.orders WHERE side IN ('CASH_IN','CASH_OUT') AND (price <> 1 OR type <> 'MARKET' OR instrumentid <> %s)$q$, ars)),
      ('orders con instrumento inexistente','SELECT count(*) FROM app.orders o WHERE NOT EXISTS (SELECT 1 FROM app.instruments i WHERE i.id = o.instrumentid)'),
      ('orders con usuario inexistente',    'SELECT count(*) FROM app.orders o WHERE NOT EXISTS (SELECT 1 FROM app.users u WHERE u.id = o.userid)'),
      ('cash que desborda integer al pasar a centavos', $q$SELECT count(*) FROM app.orders WHERE side IN ('CASH_IN','CASH_OUT') AND size::bigint * 100 > 2147483647$q$),
      ('marketdata con campos obligatorios en NULL', 'SELECT count(*) FROM app.marketdata WHERE date IS NULL OR instrumentid IS NULL OR close IS NULL'),
      ('marketdata con close <= 0',         'SELECT count(*) FROM app.marketdata WHERE close <= 0'),
      ('marketdata con más de 2 decimales', 'SELECT count(*) FROM app.marketdata WHERE close <> round(close, 2) OR previousclose <> round(previousclose, 2)')
    ) AS t(name, sql)
  LOOP
    EXECUTE c.sql INTO n;
    IF n > 0 THEN
      RAISE WARNING 'auditoría: % → %', c.name, n;
      n_bad := n_bad + n;
    END IF;
  END LOOP;

  IF n_bad > 0 THEN
    RAISE EXCEPTION 'auditoría: % fila(s) no cumplen las reglas del esquema (ver WARNING arriba). No se migra.', n_bad;
  END IF;

  SELECT count(*) INTO n FROM (
    SELECT instrumentid, date FROM app.marketdata GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE NOTICE 'auditoría: % par(es) (instrumento, fecha) duplicados en marketdata; se conserva el de mayor id (D-07)', n;
  END IF;
  RAISE NOTICE 'auditoría OK (ARS = instrumento %)', ars;
END $$;
