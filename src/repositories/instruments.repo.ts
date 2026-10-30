import { pool } from '../db/pool.js';

export interface InstrumentRow { id: number; ticker: string; name: string; type: string }

/** Escapa los comodines de LIKE para que la búsqueda sea literal. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Búsqueda por ticker y/o nombre, sin distinguir mayúsculas, por coincidencia parcial (D-25).
 * Orden: ticker exacto, ticker por prefijo, nombre por prefijo, el resto; luego por ticker.
 * La moneda (type MONEDA) se excluye salvo que se pida.
 */
export async function searchInstruments(q: string, opts: { includeCash: boolean; limit: number }): Promise<InstrumentRow[]> {
  const e = escapeLike(q);
  const r = await pool.query<InstrumentRow>(
    `SELECT id, ticker, name, type
       FROM app.instruments
      WHERE (ticker ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%')
        AND ($2 OR type <> 'MONEDA')
      ORDER BY CASE
                 WHEN lower(ticker) = lower($3)          THEN 0
                 WHEN ticker ILIKE $1 || '%'             THEN 1
                 WHEN name   ILIKE $1 || '%'             THEN 2
                 ELSE 3
               END, ticker
      LIMIT $4`,
    [e, opts.includeCash, q, opts.limit],
  );
  return r.rows;
}
