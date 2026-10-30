-- 008 — Índices para el executor de LIMIT (issue #9, D-28).
--
-- app.limit_candidates busca, por instrumento y lado, las NEW cuyo precio límite la cotización
-- vigente cruza: un rango de (instrumentid, side, price) por cada instrumento con cotización.
-- Sin este índice, cada corrida recorría todas las NEW y evaluaba la cotización por orden.
-- El segundo índice sirve al cursor (id > after_id) cuando ya se recorrió la mayor parte del
-- lote y quedan pocas pendientes por delante.
CREATE INDEX orders_new_limit_by_price ON app.orders (instrumentid, side, price)
  WHERE status = 'NEW' AND type = 'LIMIT';
CREATE INDEX orders_new_limit_by_id ON app.orders (id)
  WHERE status = 'NEW' AND type = 'LIMIT';
