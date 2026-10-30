// Operación: executor de LIMITs, limpieza de idempotencia, salud.
// Cada operación por usuario corre en su propia transacción, para que cada lock dure poco.
import { pool } from '../db/pool.js';

export interface ExecuteReport {
  candidates: number;
  executed: string[];
  not_crossed: string[];
  // Canceladas por el executor; no son cancelaciones del usuario. LIMIT: ejecutarla violaría
  // D-14. UNBACKED: una NEW heredada sin respaldo (SELL sin acciones, BUY sin cash; issue #6).
  cancelled: { order_id: string; reason: 'LIMIT' | 'UNBACKED' }[];
  errors: { order_id: string; error: string }[];
}

type LimitOutcome = 'FILLED' | 'SKIPPED' | 'LIMIT' | 'UNBACKED';

/** Ejecuta las LIMIT que la cotización vigente cruza (D-28). La decisión final es de execute_limit_outcome. */
export async function executeLimits(max = 500): Promise<ExecuteReport> {
  const ids = (await pool.query<{ order_id: string }>('SELECT order_id FROM app.limit_candidates($1)', [max])).rows.map((r) => r.order_id);
  const report: ExecuteReport = { candidates: ids.length, executed: [], not_crossed: [], cancelled: [], errors: [] };
  for (const id of ids) {
    try {
      // Una sentencia = una transacción, con los tiempos de la base (D-20).
      const outcome = (await pool.query<{ r: LimitOutcome }>('SELECT app.execute_limit_outcome($1) AS r', [id])).rows[0].r;
      if (outcome === 'FILLED') report.executed.push(id);
      else if (outcome === 'LIMIT' || outcome === 'UNBACKED') report.cancelled.push({ order_id: id, reason: outcome });
      else report.not_crossed.push(id);
    } catch (e) {
      report.errors.push({ order_id: id, error: (e as { code?: string }).code ?? (e as Error).message });
    }
  }
  return report;
}

/** Borra las claves de idempotencia vencidas (settings.idempotency_ttl), usuario por usuario. Solo recupera espacio: el vencimiento lo decide app.place_order (D-19). */
export async function cleanupIdempotency(): Promise<{ users: number; deleted: number }> {
  const users = (await pool.query<{ userid: number }>('SELECT userid FROM app.cleanup_candidates()')).rows;
  let deleted = 0;
  for (const { userid } of users) {
    deleted += (await pool.query<{ n: number }>('SELECT app.cleanup_idempotency($1) AS n', [userid])).rows[0].n;
  }
  return { users: users.length, deleted };
}

export interface Health { users: string }

export async function health(): Promise<Health> {
  return (await pool.query<Health>('SELECT * FROM app.health()')).rows[0];
}
