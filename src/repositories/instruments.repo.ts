import { pool } from '../db/pool.js';

export interface InstrumentRow { id: number; ticker: string; name: string; type: string }

/**
 * `q` normalizado (sin mayúsculas ni acentos) y con los comodines de LIKE escapados, en ese orden:
 * unaccent convierte ％, ＿ y ＼ (ancho completo) en %, _ y \, así que escapar antes de normalizar
 * dejaría comodines vivos (`q=％` encontraría todo el catálogo).
 */
const PATTERN = `replace(replace(replace(app.unaccent_immutable(lower($1)), '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

/**
 * Búsqueda por ticker y/o nombre, sin distinguir mayúsculas ni acentos (D-25, migración 009).
 * Encuentra lo que contiene `q` (LIKE) o se le parece por trigramas (`<<%`, strict_word_similarity
 * con el umbral que la migración fija para el rol api): `galisia` → Galicia, `petroleo` → Petróleo.
 * Los dos lados pasan por app.unaccent_immutable(lower(…)): la misma expresión de los índices GIN.
 * Orden: ticker exacto, ticker por prefijo, nombre por prefijo, el resto; dentro de cada nivel por
 * similitud descendente y después por ticker. La moneda (type MONEDA) se excluye salvo que se pida.
 *
 *   $1 q tal cual   $2 incluir la moneda   $3 limit
 */
export const SEARCH_SQL = `
  SELECT id, ticker, name, type
    FROM app.instruments
   WHERE (app.unaccent_immutable(lower(ticker)) LIKE '%' || ${PATTERN} || '%'
       OR app.unaccent_immutable(lower(name))   LIKE '%' || ${PATTERN} || '%'
       OR app.unaccent_immutable(lower($1)) OPERATOR(public.<<%) app.unaccent_immutable(lower(ticker))
       OR app.unaccent_immutable(lower($1)) OPERATOR(public.<<%) app.unaccent_immutable(lower(name)))
     AND ($2 OR type <> 'MONEDA')
   ORDER BY CASE
              WHEN app.unaccent_immutable(lower(ticker)) = app.unaccent_immutable(lower($1)) THEN 0
              WHEN app.unaccent_immutable(lower(ticker)) LIKE ${PATTERN} || '%'               THEN 1
              WHEN app.unaccent_immutable(lower(name))   LIKE ${PATTERN} || '%'               THEN 2
              ELSE 3
            END,
            GREATEST(public.strict_word_similarity(app.unaccent_immutable(lower($1)), app.unaccent_immutable(lower(ticker))),
                     public.strict_word_similarity(app.unaccent_immutable(lower($1)), app.unaccent_immutable(lower(name)))) DESC,
            ticker
   LIMIT $3`;

export async function searchInstruments(q: string, opts: { includeCash: boolean; limit: number }): Promise<InstrumentRow[]> {
  const r = await pool.query<InstrumentRow>(SEARCH_SQL, [q, opts.includeCash, opts.limit]);
  return r.rows;
}
