import { pool } from '../db/pool.js';
import type { PortfolioRow } from '../domain/portfolio.js';

/**
 * Una sentencia, un round-trip: una foto MVCC de las órdenes del usuario (sin lock).
 * Usuario inexistente → la base falla con APP06, que la API traduce a 404 (src/http/errors.ts).
 */
export async function readPortfolio(userid: number): Promise<PortfolioRow[]> {
  const r = await pool.query<PortfolioRow>('SELECT * FROM app.read_portfolio($1)', [userid]);
  return r.rows;
}
