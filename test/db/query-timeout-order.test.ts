// Issue #11, el orden de los dos relojes con el pool real de la API y su plazo por defecto: una
// sentencia lenta con la base sana vence por el statement_timeout de la base (57014, 5 s), no por
// el plazo local del driver (PG_QUERY_TIMEOUT_MS, 7 s). En archivo propio para importar el pool
// sin el plazo corto de query-timeout.test.ts.
import { afterAll, describe, expect, it } from 'vitest';

delete process.env.PG_QUERY_TIMEOUT_MS;
const { pool } = await import('../../src/db/pool.js');
const { fromDbError } = await import('../../src/http/errors.js');
afterAll(async () => { await pool.end(); });

describe('el orden de los dos relojes', () => {
  it('pg_sleep(6) por el pool exportado vence por statement_timeout de la base (57014) a los ~5 s, no por el plazo local', async () => {
    const t0 = Date.now();
    const err = await pool.query('SELECT pg_sleep(6)').then(() => null, (e: unknown) => e as { code?: string; message?: string });
    const ms = Date.now() - t0;
    expect({ code: err?.code, message: err?.message }).toEqual({ code: '57014', message: 'canceling statement due to statement timeout' });
    expect(ms).toBeGreaterThanOrEqual(4900);
    expect(ms).toBeLessThan(6000);
    const e = fromDbError(err);
    expect({ status: e.status, code: e.code }).toEqual({ status: 503, code: 'TIMEOUT' });
  }, 15_000);
});
