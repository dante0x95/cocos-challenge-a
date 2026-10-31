-- 010 — Verificar el tope por orden en las NEW existentes (issue #41, D-14, D-24).
--
-- No cambia el esquema ni los datos. El bootstrap verifica la historia (app.verify_ledger) solo
-- en un despliegue que aplica alguna migración; esta existe para que el despliegue que instala
-- el chequeo 'tope' lo corra una vez sobre la base existente. Una base anterior al tope por
-- orden (issue #2) o preexistente (D-24) puede tener NEW con size × price > 10^15 ARS:
-- verify_ledger las señala y el bootstrap las cancela con cancel_reason = 'LIMIT'
-- (app.cancel_over_cap), en la misma transacción. Desde acá place_order no las graba y el
-- executor cancela con LIMIT cualquiera que le llegue.
SELECT 1;
