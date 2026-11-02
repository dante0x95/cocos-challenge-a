-- 011 — Verificar el cash negativo heredado en la base existente (issue #68, D-01, D-24).
--
-- No cambia el esquema ni los datos. El bootstrap verifica la historia (app.verify_ledger) solo
-- en un despliegue que aplica alguna migración; esta existe para que el despliegue que instala
-- el chequeo 'cash negativo' lo corra una vez sobre la base existente, como la 010 con 'tope'.
-- Una base preexistente (D-24) puede tener compras o retiros FILLED sin fondos que dejan el cash
-- del fold por debajo de 0: verify_ledger lo informa y el bootstrap lo registra en el log, sin
-- abortar ni cambiar nada. place_order no deja el cash negativo.
SELECT 1;
