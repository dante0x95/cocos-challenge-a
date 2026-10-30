-- 007 — Motivo de cancelación UNBACKED (issue #6).
--
-- Una LIMIT NEW heredada (insertada en orders por una base preexistente, D-24, sin pasar por
-- place_order) puede no tener respaldo: SELL sin acciones, BUY sin cash o una orden sobre una
-- MONEDA. Ejecutarla dejaría la posición en corto o el cash negativo. Desde este cambio no se
-- ejecuta: la cancelan execute_limit_outcome (el executor) o cancel_unbacked (el bootstrap,
-- después de verify_ledger), con cancel_reason = 'UNBACKED'.
--
-- Solo cambia el CHECK de 005: las filas existentes ya lo cumplen, así que volver a validarlo
-- es una lectura de la tabla dentro de la transacción del bootstrap. El trigger orders_guard
-- no cambia: la regla de que el motivo va si y solo si la orden está CANCELLED es la misma.
ALTER TABLE app.orders DROP CONSTRAINT orders_cancel_reason_valid;
ALTER TABLE app.orders
  ADD CONSTRAINT orders_cancel_reason_valid CHECK (cancel_reason IN ('USER','LIMIT','UNBACKED'));
