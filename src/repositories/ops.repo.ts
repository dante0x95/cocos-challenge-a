// Operación: executor de LIMITs, limpieza de idempotencia, salud.
// Cada operación por usuario corre en su propia transacción, para que cada lock dure poco.
import { pool } from '../db/pool.js';

export interface ExecuteReport {
  // Candidatas del lote (a lo sumo `max`), en orden de id.
  candidates: number;
  executed: string[];
  not_crossed: string[];
  // Canceladas por el executor; no son cancelaciones del usuario. LIMIT: ejecutarla violaría
  // D-14. UNBACKED: una NEW heredada sin respaldo (SELL sin acciones, BUY sin cash; issue #6).
  cancelled: { order_id: string; reason: 'LIMIT' | 'UNBACKED' }[];
  errors: { order_id: string; error: string }[];
  // Usuarios cuyo lock no se consiguió (55P03): sus demás candidatas del lote no se intentaron.
  skipped_users: string[];
  // Usuarios con la historia fuera de los tipos (APP07, 'overflow' en verify_ledger; issue #57):
  // necesitan corrección manual. Sus NEW siguen NEW (sin fold no se decide el respaldo) y sus
  // demás candidatas del lote no se intentaron.
  overflow_users: string[];
  // Instrumentos que se quedaron sin cotización válida entre la selección y la ejecución (APP01):
  // sus demás candidatas del lote no se intentaron.
  skipped_instruments: string[];
  // Cursor para la corrida siguiente (`after_id`); null cuando el lote se agotó y la próxima
  // empieza de cero. Si quedan candidatas y no se procesó ninguna, es el mismo cursor recibido
  // ('0' incluido): null es solo agotamiento.
  after_id: string | null;
  // Candidatas del lote que no se intentaron porque venció `max_ms`.
  remaining: number;
}

export interface ExecuteOptions {
  /** Tamaño del lote: candidatas por corrida. */
  max?: number;
  /** Cursor: solo candidatas con id mayor. '0' (o ausente) empieza desde el principio. */
  afterId?: string;
  /** Presupuesto de la corrida en ms: al vencer no se empieza otra sentencia; la que está en curso termina. */
  maxMs?: number;
  /** A lo sumo N candidatas por usuario por corrida, para que uno con miles no llene el lote solo. */
  perUser?: number;
}

export const EXECUTE_DEFAULTS = { max: 500, afterId: '0', maxMs: 10_000, perUser: 50 } as const;

type LimitOutcome = 'FILLED' | 'SKIPPED' | 'LIMIT' | 'UNBACKED';
interface Candidate { order_id: string; userid: number; instrumentid: number }

/**
 * Ejecuta las LIMIT que la cotización vigente cruza (D-28). La decisión final es de
 * execute_limit_outcome, una sentencia (= una transacción) por candidata. Un usuario con el lock
 * tomado o con la historia fuera de los tipos, o un instrumento sin cotización, no frenan al resto:
 * se saltean sus demás candidatas del lote. Al vencer `maxMs` la corrida corta entre sentencias y deja `remaining`.
 */
export async function executeLimits(opts: ExecuteOptions = {}): Promise<ExecuteReport> {
  const max = opts.max ?? EXECUTE_DEFAULTS.max;
  const afterId = opts.afterId ?? EXECUTE_DEFAULTS.afterId;
  const maxMs = opts.maxMs ?? EXECUTE_DEFAULTS.maxMs;
  const perUser = opts.perUser ?? EXECUTE_DEFAULTS.perUser;
  const deadline = Date.now() + maxMs;

  // Una candidata de más dice si el lote sigue después de `max` (y entonces hay cursor).
  const rows = (await pool.query<Candidate>(
    'SELECT order_id::text, userid, instrumentid FROM app.limit_candidates($1, $2, $3)', [max + 1, afterId, perUser])).rows;
  const more = rows.length > max;
  const batch = rows.slice(0, max);
  const report: ExecuteReport = {
    candidates: batch.length, executed: [], not_crossed: [], cancelled: [], errors: [],
    skipped_users: [], overflow_users: [], skipped_instruments: [], after_id: null, remaining: 0,
  };
  const skippedUsers = new Set<number>();
  const skippedInstruments = new Set<number>();

  let i = 0;
  for (; i < batch.length; i++) {
    const c = batch[i];
    if (skippedUsers.has(c.userid) || skippedInstruments.has(c.instrumentid)) continue;
    if (Date.now() >= deadline) break;
    try {
      // Una sentencia = una transacción, con los tiempos de la base (D-20). Nunca se cancela desde acá.
      const outcome = (await pool.query<{ r: LimitOutcome }>('SELECT app.execute_limit_outcome($1) AS r', [c.order_id])).rows[0].r;
      if (outcome === 'FILLED') report.executed.push(c.order_id);
      else if (outcome === 'LIMIT' || outcome === 'UNBACKED') report.cancelled.push({ order_id: c.order_id, reason: outcome });
      else report.not_crossed.push(c.order_id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '55P03') {
        skippedUsers.add(c.userid);
        report.skipped_users.push(String(c.userid));
      } else if (code === 'APP07') {
        skippedUsers.add(c.userid);
        report.overflow_users.push(String(c.userid));
      } else if (code === 'APP01') {
        skippedInstruments.add(c.instrumentid);
        report.skipped_instruments.push(String(c.instrumentid));
      } else {
        report.errors.push({ order_id: c.order_id, error: code ?? (e as Error).message });
      }
    }
  }
  report.remaining = batch.length - i;
  if (more || report.remaining > 0) report.after_id = i > 0 ? batch[i - 1].order_id : afterId;
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
