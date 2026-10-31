-- El usuario del smoke (D-29, issue #51), solo en staging: lo corre `remote.sh smoke-user staging`
-- como superusuario, con psql dentro del contenedor de la base (el rol api no escribe app.users),
-- en una transacción (psql -1), y devuelve su id: la única fila que imprime.
--
-- Es uno solo, `smoke@staging.invalid`, y cada corrida de deploy/smoke.mjs write lo deja como lo
-- encontró: en cero. Si no está en cero (una corrida anterior falló a la mitad: una LIMIT NEW, una
-- posición o cash que no volvieron), no se puede limpiar (las órdenes no se borran: el trigger de
-- app.orders) y se retira: su email pasa a `smoke-retirado-<id>@staging.invalid`, con su historia
-- intacta para mirarla, y se crea otro. Así la corrida siguiente siempre empieza en cero.
--
-- "En cero" es lo mismo que mira el smoke en GET /portfolio, contado directo sobre las órdenes:
-- ninguna NEW, ninguna posición distinta de 0 y el cash neto en 0 (FILLED: CASH_IN y SELL suman
-- size × price, CASH_OUT y BUY restan).
DO $$
DECLARE
  smoke constant text := 'smoke@staging.invalid';
  current_id integer;
BEGIN
  -- Un deploy de staging a la vez lo asegura el workflow; esto, también a mano.
  PERFORM pg_advisory_xact_lock(hashtext('cocos-smoke-user'));
  SELECT id INTO current_id FROM app.users WHERE email = smoke;
  IF current_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM app.orders WHERE userid = current_id AND status = 'NEW')
    OR EXISTS (SELECT 1 FROM app.orders
                WHERE userid = current_id AND status = 'FILLED' AND side IN ('BUY', 'SELL')
                GROUP BY instrumentid
               HAVING sum(CASE side WHEN 'BUY' THEN size ELSE -size END) <> 0)
    OR (SELECT coalesce(sum(CASE WHEN side IN ('CASH_IN', 'SELL') THEN size * price ELSE -size * price END), 0)
          FROM app.orders WHERE userid = current_id AND status = 'FILLED') <> 0
  ) THEN
    UPDATE app.users SET email = format('smoke-retirado-%s@staging.invalid', id) WHERE id = current_id;
    RAISE NOTICE 'usuario del smoke % retirado: no estaba en cero', current_id;
    current_id := NULL;
  END IF;
  IF current_id IS NULL THEN
    INSERT INTO app.users (email, accountnumber) VALUES (smoke, 'SMOKE') RETURNING id INTO current_id;
    RAISE NOTICE 'usuario del smoke % creado', current_id;
  END IF;
END $$;
SELECT id FROM app.users WHERE email = 'smoke@staging.invalid';
