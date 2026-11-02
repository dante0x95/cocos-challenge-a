// Pool de node-postgres y transacción con presupuesto (A §6).
// Regla A §2.5: NINGÚN parser que devuelva Number para int8 (OID 20) ni numeric (OID 1700).
// node-postgres los entrega como string por defecto; acá no se registra nada para esos OIDs,
// y un test lo verifica. Lo único que se cambia es date (1082): string en vez de Date.
import pg from 'pg';

pg.types.setTypeParser(1082, (v: string) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://api:api@localhost:5434/trading',
  max: Number(process.env.PG_POOL_MAX ?? 10),
  application_name: 'balances-api',
});

export interface TxOptions {
  lockTimeout?: string;       // default 2s (A.1 §5)
  statementTimeout?: string;  // default 5s
  deadlineMs?: number;        // presupuesto total del request; al vencer, cancela y hace ROLLBACK
}

/**
 * Una transacción = una operación completa en la DB. Fija los timeouts con SET LOCAL,
 * ejecuta `fn`, confirma. Si el deadline vence, cancela la sentencia en curso desde otra
 * conexión (pg_cancel_backend), lo que hace fallar `fn` con 57014 y dispara el ROLLBACK.
 * El client se libera siempre en finally.
 */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const client = await pool.connect();
  let timer: NodeJS.Timeout | undefined;
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${opts.lockTimeout ?? '2s'}'`);
    await client.query(`SET LOCAL statement_timeout = '${opts.statementTimeout ?? '5s'}'`);
    if (opts.deadlineMs) {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0].pid;
      timer = setTimeout(() => {
        pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
      }, opts.deadlineMs);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    client.release();
  }
}

/** Para el test guard: los parsers de int8 y numeric deben devolver el string intacto. */
export function parserFor(oid: number): (v: string) => unknown {
  return pg.types.getTypeParser(oid, 'text');
}
