import { pool } from '../db/pool.js';

export interface InstrumentRow { id: number; ticker: string; name: string; type: string }

/** Escapa los comodines de LIKE para que la búsqueda sea literal. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Búsqueda por ticker y/o nombre, sin distinguir mayúsculas ni acentos (D-25, migración 009).
 * Encuentra lo que contiene `q` (LIKE) o se le parece por trigramas (`<<%`, strict_word_similarity
 * con el umbral que la migración fija para el rol api): `galisia` → Galicia, `petroleo` → Petróleo.
 * Los dos lados pasan por app.unaccent_immutable(lower(…)): la misma expresión de los índices GIN.
 * Orden: ticker exacto, ticker por prefijo, nombre por prefijo, el resto; dentro de cada nivel por
 * similitud descendente y después por ticker. La moneda (type MONEDA) se excluye salvo que se pida.
 *
 *   $1 q tal cual (similitud, igualdad)   $2 q con los comodines escapados (LIKE)
 *   $3 incluir la moneda                  $4 limit
 */
export const SEARCH_SQL = `
  SELECT id, ticker, name, type
    FROM app.instruments
   WHERE (app.unaccent_immutable(lower(ticker)) LIKE '%' || app.unaccent_immutable(lower($2)) || '%'
       OR app.unaccent_immutable(lower(name))   LIKE '%' || app.unaccent_immutable(lower($2)) || '%'
       OR app.unaccent_immutable(lower($1)) OPERATOR(public.<<%) app.unaccent_immutable(lower(ticker))
       OR app.unaccent_immutable(lower($1)) OPERATOR(public.<<%) app.unaccent_immutable(lower(name)))
     AND ($3 OR type <> 'MONEDA')
   ORDER BY CASE
              WHEN app.unaccent_immutable(lower(ticker)) = app.unaccent_immutable(lower($1))          THEN 0
              WHEN app.unaccent_immutable(lower(ticker)) LIKE app.unaccent_immutable(lower($2)) || '%' THEN 1
              WHEN app.unaccent_immutable(lower(name))   LIKE app.unaccent_immutable(lower($2)) || '%' THEN 2
              ELSE 3
            END,
            GREATEST(public.strict_word_similarity(app.unaccent_immutable(lower($1)), app.unaccent_immutable(lower(ticker))),
                     public.strict_word_similarity(app.unaccent_immutable(lower($1)), app.unaccent_immutable(lower(name)))) DESC,
            ticker
   LIMIT $4`;

export async function searchInstruments(q: string, opts: { includeCash: boolean; limit: number }): Promise<InstrumentRow[]> {
  const r = await pool.query<InstrumentRow>(SEARCH_SQL, [q, escapeLike(q), opts.includeCash, opts.limit]);
  return r.rows;
}
