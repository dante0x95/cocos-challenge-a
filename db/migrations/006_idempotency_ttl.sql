-- 006 — Plazo de las claves de idempotencia en settings (issue #4 de este repositorio).
--
-- D-19 promete que una clave vence a las 24 h. Hasta acá ese plazo era un literal repetido en
-- las dos funciones de limpieza, y place_order no lo miraba: una clave de 25 h seguía dando
-- replay (o 422) hasta que el job la borrara. Ahora el plazo vive en una sola columna, lo lee
-- app.idempotency_ttl() y lo aplican place_order (al reclamar la clave, bajo el lock) y la
-- limpieza (que solo recupera espacio). Cambiarlo es un UPDATE: las pruebas lo bajan a 1 minuto
-- para verificar que no quedó ningún '24 hours' suelto.
ALTER TABLE app.settings
  -- Una clave vence cuando created_at < now() - idempotency_ttl (D-19).
  ADD COLUMN idempotency_ttl interval NOT NULL DEFAULT '24 hours'
    CONSTRAINT settings_idempotency_ttl_positive CHECK (idempotency_ttl > interval '0');
