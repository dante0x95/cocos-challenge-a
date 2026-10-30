-- 009 — Búsqueda de instrumentos con tolerancia a errores de tipeo y acentos (issue #14, D-25).
--
-- `GET /instruments?q=` buscaba con ILIKE '%q%' sobre ticker y name, sin índice: `galisia` no
-- encontraba Galicia, `petroleo` no encontraba `Petróleo`, y con un catálogo grande la tabla se
-- recorría entera. Esta migración deja la base lista para la consulta nueva de
-- src/repositories/instruments.repo.ts:
--
--   1. Extensiones pg_trgm (similitud por trigramas, índice GIN para LIKE y para la similitud)
--      y unaccent (quita acentos y diéresis). Las dos vienen con Postgres (contrib) y son
--      "trusted": las instala el dueño de la base sin ser superusuario.
--   2. app.unaccent_immutable(text): unaccent() no es IMMUTABLE porque la forma de un argumento
--      resuelve el diccionario por search_path, y un índice solo admite expresiones IMMUTABLE.
--      Este wrapper fija el diccionario (public.unaccent) y por eso puede declararse IMMUTABLE.
--      Se crea acá porque los índices de abajo lo necesitan y las migraciones corren antes que
--      db/functions; db/functions/010_core.sql lo repite con CREATE OR REPLACE y el mismo cuerpo,
--      para que viva con el resto de las funciones. El cuerpo NO puede cambiar: los índices
--      guardan lo que devolvía al construirse. Si algún día cambia, va con un REINDEX en una
--      migración nueva.
--   3. Índices GIN gin_trgm_ops sobre unaccent_immutable(lower(ticker)) y sobre
--      unaccent_immutable(lower(name)): la consulta usa exactamente esas expresiones, de los dos
--      lados (también sobre q), así `Petróleo`, `petroleo` y `PETROLEO` buscan lo mismo. El
--      índice sirve para LIKE '%q%' y para el operador de similitud <<%.
--   4. Umbral de similitud para el rol api: strict_word_similarity ≥ 0.45. Es la similitud de
--      trigramas entre q y la palabra (o secuencia de palabras) más parecida del texto, así una
--      palabra con un error de tipeo encuentra un nombre largo (`galisia` contra "Grupo
--      Financiero Galicia" da 0,45; la similitud contra el texto entero daría 0,19). Con 0,45,
--      sobre el catálogo del challenge, lo único que suma a lo que ya encuentra ILIKE son
--      variantes de una palabra (`argentino` → Argentina, Argentinos; `comerciales` → Comercial);
--      con 0,40 entrarían `banco` → "Gas Natural Ban" y `del` → "de". El operador <<% lee el
--      umbral del parámetro pg_trgm.strict_word_similarity_threshold (0,5 por defecto): fijarlo
--      para el rol api, como 001 fija su search_path, lo deja en la base junto con el índice y
--      el operador, sin una transacción ni un SET por consulta en la API.

CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- Mismo cuerpo que en db/functions/010_core.sql (ver arriba).
CREATE OR REPLACE FUNCTION app.unaccent_immutable(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$;

CREATE INDEX instruments_ticker_trgm ON app.instruments
  USING gin (app.unaccent_immutable(lower(ticker)) public.gin_trgm_ops);
CREATE INDEX instruments_name_trgm ON app.instruments
  USING gin (app.unaccent_immutable(lower(name)) public.gin_trgm_ops);

DO $$
BEGIN
  EXECUTE format('ALTER ROLE api IN DATABASE %I SET pg_trgm.strict_word_similarity_threshold = 0.45', current_database());
END $$;
