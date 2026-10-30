// El protocolo de escritura (D-17) como propiedad de la base.
// Dos conexiones reales, coordinadas con advisory locks como barreras (nunca con setTimeout).
// Incluye la prueba negativa: una función que lee ANTES del lock produce doble gasto. Es la
// demostración de que lo que protege el saldo es el orden lock → leer → decidir → escribir,
// no el trigger ni los CHECKs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, apiClient, arsId, fmt, newUser, placeOrder, quotes, type Quote } from '../support/db.js';

let ars: number;
let q: Quote;

beforeAll(async () => {
  ars = await arsId();
  [q] = await quotes(1);
});
afterAll(async () => {
  await admin.end();
});

/** Usuario con cash para exactamente UNA compra de `size` acciones al close. */
async function userWithFundsForOne(size: bigint): Promise<number> {
  const u = await newUser('conc');
  const amount = fmt(size * q.closeCents);
  await placeOrder(admin, { userid: u, key: 'seed', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount });
  return u;
}

describe('vía oficial: app.place_order bajo el lock', () => {
  it('dos BUY con fondos para una → exactamente una FILLED, la otra REJECTED, cash nunca negativo', async () => {
    const u = await userWithFundsForOne(10n);
    const a = await apiClient();
    const b = await apiClient();
    try {
      // A toma el lock del usuario "a mano" (barrera): B va a quedar esperando dentro de place_order.
      await a.query('BEGIN');
      await a.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);

      await b.query('BEGIN');
      const bPending = placeOrder(b, { userid: u, key: 'b', side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 10n });

      // Mientras B espera, A decide con el estado real y confirma.
      const aRes = await placeOrder(a, { userid: u, key: 'a', side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 10n });
      expect(aRes.body.status).toBe('FILLED');
      await a.query('COMMIT');

      const bRes = await bPending;    // recién ahora B obtiene el lock y lee el estado post-A
      await b.query('COMMIT');
      expect(bRes.body.status).toBe('REJECTED');
    } finally {
      await a.end(); await b.end();
    }
    const r = await admin.query(`SELECT status, count(*)::int AS n FROM app.orders WHERE userid = $1 AND side = 'BUY' GROUP BY status`, [u]);
    expect(Object.fromEntries(r.rows.map((x) => [x.status, x.n]))).toEqual({ FILLED: 1, REJECTED: 1 });
    const p = await admin.query<{ qty: string }>('SELECT qty FROM app.read_portfolio($1) WHERE kind = 0', [u]);
    expect(BigInt(p.rows[0].qty)).toBe(0n);
  });

  it('lock_timeout de la función (2 s) aunque la sesión pida más → 55P03, sin orden y sin clave reclamada', async () => {
    const u = await userWithFundsForOne(1n);
    const a = await apiClient();
    const b = await apiClient();
    try {
      await a.query('BEGIN');
      await a.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);
      // Si el lock_timeout no fuera de la función, esta sesión esperaría hasta el statement_timeout
      // del rol (5 s) y el error sería 57014, no 55P03.
      await b.query("SET lock_timeout = '10s'");
      await expect(placeOrder(b, { userid: u, key: 'lt', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '1.00' }))
        .rejects.toMatchObject({ code: '55P03' });
      await a.query('ROLLBACK');
    } finally { await a.end(); await b.end(); }
    expect((await admin.query('SELECT 1 FROM app.orders WHERE userid = $1 AND side = $2', [u, 'CASH_IN'])).rowCount).toBe(1); // solo el seed
    expect((await admin.query('SELECT 1 FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, 'lt'])).rowCount).toBe(0);
  });

  it('toda función que espera el lock de usuario fija lock_timeout = 2s; el rol api, statement_timeout = 5s', async () => {
    const r = await admin.query<{ fn: string; cfg: string[] }>(
      `SELECT p.proname AS fn, p.proconfig AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname IN ('place_order', 'execute_limit_outcome', 'cancel_order_outcome')
        ORDER BY 1`);
    expect(r.rows.map((x) => [x.fn, x.cfg.includes('lock_timeout=2s')])).toEqual([
      ['cancel_order_outcome', true], ['execute_limit_outcome', true], ['place_order', true]]);
    const c = await apiClient();
    try {
      expect((await c.query<{ v: string }>("SELECT current_setting('statement_timeout') AS v")).rows[0].v).toBe('5s');
    } finally { await c.end(); }
  });

  it('cancelación vs executor: la cancelación bajo el lock gana y execute_limit devuelve false', async () => {
    const u = await userWithFundsForOne(1n);
    const lim = await placeOrder(admin, { userid: u, key: 'lim', side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1n, limit: fmt(q.closeCents) });
    expect(lim.body.status).toBe('NEW');
    const orderId = Number(lim.order_id);

    const a = await apiClient();
    const b = await apiClient();
    try {
      await a.query('BEGIN');
      await a.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);
      await b.query('BEGIN');
      const exec = b.query<{ r: boolean }>('SELECT app.execute_limit($1) AS r', [orderId]);  // espera el lock
      expect((await a.query<{ r: boolean }>('SELECT app.cancel_order($1, $2) AS r', [u, orderId])).rows[0].r).toBe(true);
      await a.query('COMMIT');
      expect((await exec).rows[0].r).toBe(false);   // releyó bajo el lock: ya no es NEW
      await b.query('COMMIT');
    } finally { await a.end(); await b.end(); }
    expect((await admin.query<{ status: string }>('SELECT status FROM app.orders WHERE id = $1', [orderId])).rows[0].status).toBe('CANCELLED');
  });
});

describe('vía saltada: leer antes del lock (DEBE producir doble gasto)', () => {
  // Función de prueba que viola el orden: lee el disponible SIN lock, espera una barrera
  // (para que las dos conexiones lean el mismo estado), y recién después toma el lock e inserta.
  // El trigger acepta las dos filas (secuencias consecutivas válidas): el trigger no protege la
  // autorización; la protege el orden interno de place_order. Este test demuestra eso.
  const fn = `
    CREATE OR REPLACE FUNCTION app.test_unsafe_buy(p_userid int, p_instrumentid int, p_size int, p_price numeric)
    RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
    DECLARE disponible numeric; imp numeric; nxt bigint; st text;
    BEGIN
      SELECT COALESCE(sum(CASE WHEN status = 'FILLED' THEN
               CASE side WHEN 'CASH_IN' THEN 1 WHEN 'SELL' THEN 1 ELSE -1 END * size::numeric * price * 100 END), 0)
           - COALESCE(sum(CASE WHEN status = 'NEW' AND side = 'BUY' THEN size::numeric * price * 100 END), 0)
        INTO disponible FROM app.orders WHERE userid = p_userid;          -- SIN LOCK
      PERFORM pg_advisory_xact_lock_shared(hashtext('test-barrier'));      -- esperar a que ambos hayan leído
      PERFORM pg_advisory_xact_lock(hashtext('user-balance'), p_userid);  -- lock tarde: ya decidió
      imp := p_size::numeric * p_price * 100;
      st := CASE WHEN disponible >= imp THEN 'FILLED' ELSE 'REJECTED' END;
      SELECT COALESCE(max(balance_seq), 0) + 1 INTO nxt FROM app.orders WHERE userid = p_userid AND balance_seq IS NOT NULL;
      INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
      VALUES (p_instrumentid, p_userid, p_size, p_price, 'MARKET', 'BUY', st, now()::timestamp,
              CASE WHEN st = 'FILLED' THEN nxt END);
      RETURN st;
    END $$;`;

  beforeAll(async () => { await admin.query(fn); });
  afterAll(async () => { await admin.query('DROP FUNCTION IF EXISTS app.test_unsafe_buy(int, int, int, numeric)'); });

  it('dos compras con fondos para una → las dos FILLED y el cash queda negativo', async () => {
    const u = await userWithFundsForOne(10n);
    const price = fmt(q.closeCents);
    const gate = await apiClient();
    const a = await apiClient();
    const b = await apiClient();
    try {
      await gate.query('BEGIN');
      await gate.query("SELECT pg_advisory_xact_lock(hashtext('test-barrier'))");   // cerrar la barrera
      // Sin BEGIN explícito: cada llamada es su propia transacción y confirma al terminar
      // (si A quedara abierta, B esperaría su lock de usuario y el test se trabaría a sí mismo).
      let failed: unknown = null;
      const run = (c: typeof a) => c.query<{ r: string }>('SELECT app.test_unsafe_buy($1,$2,10,$3) AS r', [u, q.instrumentid, price])
        .catch((e) => { failed = e; throw e; });
      const pa = run(a);
      const pb = run(b);
      // Esperar a que las dos estén bloqueadas en la barrera (ya leyeron el disponible).
      for (;;) {
        if (failed) throw failed;
        const w = await admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE query LIKE '%test_unsafe_buy%' AND wait_event_type = 'Lock' AND wait_event = 'advisory'`);
        if (Number(w.rows[0].n) >= 2) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      await gate.query('COMMIT');   // abrir la barrera: ambas ya decidieron con el mismo estado
      const [ra, rb] = await Promise.all([pa, pb]);
      expect([ra.rows[0].r, rb.rows[0].r]).toEqual(['FILLED', 'FILLED']);
    } finally { await gate.end(); await a.end(); await b.end(); }

    const p = await admin.query<{ qty: string }>('SELECT qty FROM app.read_portfolio($1) WHERE kind = 0', [u]);
    expect(BigInt(p.rows[0].qty)).toBeLessThan(0n);   // doble gasto: la vía saltada lo permite
  });
});
