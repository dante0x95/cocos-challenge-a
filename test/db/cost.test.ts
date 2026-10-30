// El costo de una posición en micro-ARS viaja como numeric (D-14, issue #3): en bigint desbordaba a
// 9,22 × 10¹² ARS, 100× por debajo del tope del cash, y congelaba al usuario entero. Y tiene tope
// propio (10¹⁷ ARS), porque el cash no lo acota.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { admin, apiClient, arsId, fmt, legacyShort, newUser, placeOrder } from '../support/db.js';
import * as O from '../oracle/fold.js';

let ars: number;
let inst: number;    // close 1.000.000.000.000.000,00 (10¹⁵): una acción cuesta el cash máximo
let cheap: number;   // close 5.000,00
let server: Server;
let base: string;

async function instrument(ticker: string, close: string): Promise<number> {
  const id = (await admin.query<{ id: number }>(
    "INSERT INTO app.instruments (ticker, name, type) VALUES ($1, $2, 'ACCIONES') RETURNING id", [ticker, `Prueba costo ${ticker}`])).rows[0].id;
  await admin.query(
    `INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
     VALUES ($1, $2, $2, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`, [id, close]);
  return id;
}

beforeAll(async () => {
  ars = await arsId();
  inst = await instrument('COST15', '1000000000000000.00');
  cheap = await instrument('COSTCH', '5000.00');
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await admin.end(); await pool.end(); });

/** Escribe historia heredada: FILLED con balance_seq consecutivo, como administrador. */
class History {
  seq = 0;
  constructor(readonly u: number) {}
  /** Retoma la secuencia después de escrituras de la API. */
  async sync() {
    this.seq = Number((await admin.query<{ m: string }>(
      'SELECT COALESCE(max(balance_seq), 0)::text AS m FROM app.orders WHERE userid = $1', [this.u])).rows[0].m);
  }
  async fill(side: string, iid: number, size: bigint | number, price: string) {
    await admin.query(
      `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
       VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`,
      [iid, this.u, size.toString(), price, side, ++this.seq]);
  }
  /** Cash arbitrario sin pasar por el tope de int4 de un CASH_IN: compra barata y venta a precio alto. */
  async cash(ars: number, iid: number, amountArs: string) {
    await this.fill('CASH_IN', ars, 1, '0.01');
    await this.fill('BUY', iid, 1, '0.01');
    await this.fill('SELL', iid, 1, amountArs);
  }
}

const position = async (u: number, iid: number) =>
  (await admin.query<{ qty: string; cost: string }>(
    'SELECT qty::text, cost_total::text AS cost FROM app.c_state($1) WHERE kind = 1 AND instrumentid = $2', [u, iid])).rows[0];
const portfolio = async (u: number) => {
  const r = await fetch(`${base}/portfolio/${u}`);
  return { status: r.status, body: (await r.json()) as { positions: (Record<string, string | null> & { instrumentid: number })[] } };
};
const ordersOf = async (u: number) =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n;

describe('el costo sale como numeric entero', () => {
  it('frontera real del tipo: costo 9.223.372.036.854,77 ARS pasa en bigint; + 0,01 desbordaba; ahora los dos responden 200 con costo unitario y rendimiento exactos', async () => {
    for (const price of ['9223372036854.77', '9223372036854.78']) {
      const h = new History(await newUser('cost-edge'));
      await h.cash(ars, cheap, price);
      await h.fill('BUY', cheap, 1, price);
      expect(await position(h.u, cheap)).toEqual({ qty: '1', cost: price.replace('.', '') + '0000' });
      const { status, body } = await portfolio(h.u);
      expect(status).toBe(200);
      const p = body.positions.find((x) => x.instrumentid === cheap)!;
      expect(p.costo_total).toBe(`${price}0000`);
      expect(p.costo_unitario).toBe(`${price}00`);
      // valor 5.000 contra ese costo: rendimiento ≈ −100 %
      expect(p.rendimiento_pct).toBe('-100.00');
    }
  });

  // La frontera exacta en micro-ARS: 10.000 acciones con costo total M centavos y una venta de
  // 9.999 dejan una con costo M micro-ARS (D-09: costo × 1 / 10.000). M = 2⁶³ − 1 entraba en bigint;
  // M + 1 desbordaba. El precio máximo de una orden es < 10¹⁸ centavos: el costo se arma con 10 compras.
  it.each([
    ['2⁶³ − 1', 9_223_372_036_854_775_807n, '9223372036854.775807', '9223372036854.7758'],
    ['2⁶³', 9_223_372_036_854_775_808n, '9223372036854.775808', '9223372036854.7758'],
  ])('frontera en micro-ARS: costo %s micro tras una venta parcial, exacto contra el oráculo', async (_n, micro, total, unit) => {
    const h = new History(await newUser('cost-micro'));
    const s = O.newState();
    const fill = async (side: 'BUY' | 'SELL', size: bigint, cents: bigint) => {
      await h.fill(side, cheap, size, fmt(cents));
      O.fill(s, side, cheap, size, cents);
    };
    await fill('BUY', 9_990n, 1n);
    const rest = micro - 9_990n;          // centavos de las 10 compras de una acción
    for (let i = 0; i < 10; i++) await fill('BUY', 1n, i < 9 ? rest / 10n : rest - 9n * (rest / 10n));
    await fill('SELL', 9_999n, 1n);
    expect(O.position(s, cheap).cost).toBe(micro);
    expect(await position(h.u, cheap)).toEqual({ qty: '1', cost: micro.toString() });
    const { status, body } = await portfolio(h.u);
    expect(status).toBe(200);
    expect(body.positions.find((x) => x.instrumentid === cheap)).toMatchObject({ costo_total: total, costo_unitario: unit, rendimiento_pct: '-100.00' });
  });

  it('posición de 10¹³ ARS: el costo exacto; una venta parcial lo reduce en proporción y sigue entero (D-09)', async () => {
    const h = new History(await newUser('cost-13'));
    await h.cash(ars, cheap, '10000000000000.00');
    await h.fill('BUY', cheap, 10, '1000000000000.00');       // 10 × 10¹² = 10¹³
    expect(await position(h.u, cheap)).toEqual({ qty: '10', cost: '10000000000000000000' });
    await h.fill('SELL', cheap, 3, '1.00');
    expect(await position(h.u, cheap)).toEqual({ qty: '7', cost: '7000000000000000000' });
    expect((await portfolio(h.u)).body.positions.find((x) => x.instrumentid === cheap)!.costo_unitario).toBe('1000000000000.0000');
  });

  it('una posición que cubrió un corto heredado sale sin decimales en el texto (la API la convierte con BigInt)', async () => {
    const u = await newUser('cost-short');
    const seq = await legacyShort(u, cheap, 500_000n, 100_000_000n, 10n);
    await admin.query(
      `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
       VALUES ($1, $2, 15, 5000.00, 'MARKET', 'BUY', 'FILLED', timezone('UTC', now()), $3)`, [cheap, u, seq + 1]);
    const p = await position(u, cheap);
    expect(p.qty).toBe('5');
    expect(p.cost).toBe('25000000000');   // 5 × 5.000,00 en micro-ARS, sin punto
    expect((await portfolio(u)).status).toBe(200);
  });

  it('el costo supera el cash: depositar 10¹⁵ y comprar, tres veces → costo 3 × 10¹⁵, GET /portfolio 200', async () => {
    const h = new History(await newUser('cost-cycle'));
    for (let i = 0; i < 3; i++) {
      await h.cash(ars, cheap, '1000000000000000.00');
      await h.fill('BUY', inst, 1, '1000000000000000.00');
    }
    expect(await position(h.u, inst)).toEqual({ qty: '3', cost: '3000000000000000000000' });
    const { status, body } = await portfolio(h.u);
    expect(status).toBe(200);
    expect(body.positions.find((x) => x.instrumentid === inst)!.costo_total).toBe('3000000000000000.000000');
  });
});

describe('tope del costo por posición: 10¹⁷ ARS', () => {
  /** Posición de `n` acciones a 10¹⁵ (costo n × 10¹⁵) y cash exacto de 10¹⁵ para una compra más. */
  async function nearCap(n: number) {
    const h = new History(await newUser('cost-cap'));
    for (let i = 0; i < n; i++) {
      await h.cash(ars, cheap, '1000000000000000.00');
      await h.fill('BUY', inst, 1, '1000000000000000.00');
    }
    await h.cash(ars, cheap, '1000000000000000.00');
    return h.u;
  }

  it('MARKET: la compra que deja el costo exactamente en 10¹⁷ → FILLED; la siguiente → 422 LIMIT sin orden', async () => {
    const u = await nearCap(99);
    const ok = await placeOrder(pool, { userid: u, key: 'ok', side: 'BUY', type: 'MARKET', instrumentid: inst, size: 1 });
    expect(ok.body.status).toBe('FILLED');
    expect((await position(u, inst)).cost).toBe('100000000000000000000000');   // 10²³ micro = 10¹⁷ ARS
    const h = new History(u); await h.sync();
    await h.cash(ars, cheap, '1000000000000000.00');
    const before = await ordersOf(u);
    await expect(placeOrder(pool, { userid: u, key: 'over', side: 'BUY', type: 'MARKET', instrumentid: inst, size: 1 }))
      .rejects.toMatchObject({ code: 'APP05' });
    expect(await ordersOf(u)).toBe(before);
  }, 60_000);

  it('LIMIT: la ejecución que deja el costo exactamente en 10¹⁷ → FILLED, con balance_seq', async () => {
    const u = await nearCap(99);
    const lim = await placeOrder(pool, { userid: u, key: 'lim', side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, limit: '1000000000000000.00' });
    expect(lim.body.status).toBe('NEW');
    expect((await pool.query<{ r: string }>('SELECT app.execute_limit_outcome($1) AS r', [Number(lim.order_id)])).rows[0].r).toBe('FILLED');
    expect((await position(u, inst)).cost).toBe('100000000000000000000000');
    const row = (await admin.query<{ status: string; balance_seq: string | null }>('SELECT status, balance_seq FROM app.orders WHERE id = $1', [lim.order_id])).rows[0];
    expect(row.status).toBe('FILLED');
    expect(row.balance_seq).not.toBeNull();
  }, 60_000);

  // R-2: dos compras con fondos que juntas superan el techo. La segunda espera el lock y lee el
  // costo que dejó la primera.
  it('dos BUY concurrentes que juntas superarían el techo: la primera FILLED, la segunda espera el lock y responde 422 LIMIT', async () => {
    const u = await nearCap(99);
    const h = new History(u); await h.sync();
    await h.cash(ars, cheap, '1000000000000000.00');   // cash para las dos compras
    const a = await apiClient();
    const b = await apiClient();
    try {
      const pidB = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await a.query('BEGIN');
      const first = await placeOrder(a, { userid: u, key: 'a', side: 'BUY', type: 'MARKET', instrumentid: inst, size: 1 });
      expect(first.body.status).toBe('FILLED');
      let failed: unknown = null;
      const second = placeOrder(b, { userid: u, key: 'b', side: 'BUY', type: 'MARKET', instrumentid: inst, size: 1 })
        .catch((e) => { failed = e; throw e; });
      second.catch(() => undefined);   // rechaza a propósito, a veces antes de que el COMMIT vuelva: que no quede sin manejar
      for (;;) {   // la segunda ya espera el lock del usuario
        if (failed) throw failed;
        if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'", [pidB])).rowCount) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      await a.query('COMMIT');
      await expect(second).rejects.toMatchObject({ code: 'APP05', message: expect.stringMatching(/costo de la posición/) });
    } finally { await a.end(); await b.end(); }
    expect((await position(u, inst)).cost).toBe('100000000000000000000000');
  }, 60_000);

  it('LIMIT: la ejecución que superaría el tope la cancela con motivo LIMIT', async () => {
    const u = await nearCap(100);
    const lim = await placeOrder(pool, { userid: u, key: 'lim', side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, limit: '1000000000000000.00' });
    expect(lim.body.status).toBe('NEW');
    expect((await pool.query<{ r: string }>('SELECT app.execute_limit_outcome($1) AS r', [Number(lim.order_id)])).rows[0].r).toBe('LIMIT');
    expect((await admin.query('SELECT status, cancel_reason FROM app.orders WHERE id = $1', [lim.order_id])).rows[0])
      .toEqual({ status: 'CANCELLED', cancel_reason: 'LIMIT' });
  }, 60_000);
});

describe('un usuario con una posición grande ya no queda congelado', () => {
  it('posición de 10¹³ en historia heredada: CASH_IN → 201, cancel de una orden inexistente → 404, GET /portfolio → 200', async () => {
    const h = new History(await newUser('cost-frozen'));
    await h.cash(ars, cheap, '10000000000000.00');
    await h.fill('BUY', cheap, 10, '1000000000000.00');
    const dep = await fetch(`${base}/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'dep' },
      body: JSON.stringify({ userid: h.u, side: 'CASH_IN', amount: '1.00' }) });
    expect(dep.status).toBe(201);
    const cancel = await fetch(`${base}/orders/2000000000/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userid: h.u }) });
    expect(cancel.status).toBe(404);
    expect((await portfolio(h.u)).status).toBe(200);
  });

  it('verify_ledger informa overflow para una historia fuera de los tipos y sigue con los demás usuarios', async () => {
    const h = new History(await newUser('cost-overflow'));
    await h.cash(ars, cheap, '10.00');
    // Importe 2³¹ − 1 × (10¹⁶ − 0,01): fuera de numeric(20,0) en el fold.
    await h.fill('BUY', cheap, 2_147_483_647, '9999999999999999.99');
    // Un usuario posterior con un corto heredado: si verify_ledger abortara en el overflow, no lo listaría.
    const other = await newUser('cost-after');
    await legacyShort(other, cheap, 500_000n, 100_000_000n, 10n);
    const rows = (await admin.query<{ userid: number; problem: string }>('SELECT userid, problem FROM app.verify_ledger()')).rows;
    expect(rows).toContainEqual({ userid: h.u, problem: 'overflow' });
    expect(rows.filter((r) => r.userid === h.u)).toHaveLength(1);
    expect(rows).toContainEqual({ userid: other, problem: 'short' });
  }, 60_000);

  // Cada orden entra en sus tipos; lo que desborda es lo acumulado: el cash (bigint en centavos) o
  // el costo (numeric(24,0) en micro-ARS). Un usuario posterior se sigue verificando.
  it.each([
    ['el cash acumulado supera bigint', async (h: History) => {
      await h.fill('BUY', cheap, 100, '0.01');
      for (let i = 0; i < 10; i++) await h.fill('SELL', cheap, 10, '1000000000000000.00');   // 10 × 10¹⁸ centavos
    }],
    ['el costo acumulado supera numeric(24,0) con el cash dentro', async (h: History) => {
      const P = '9999999999999999.99';   // 100 acciones: importe < 10²⁰ centavos, entra en numeric(20,0)
      await h.fill('BUY', inst, 200, '0.01');
      for (let i = 0; i < 2; i++) {
        await h.fill('SELL', inst, 100, P);
        await h.fill('BUY', cheap, 100, P);   // costo 2 × 10²⁴ micro al final
      }
    }],
  ] as const)('verify_ledger informa overflow cuando %s, y sigue con los demás', async (_case, seed) => {
    const h = new History(await newUser('cost-acc'));
    await seed(h);
    const other = await newUser('cost-acc-after');
    await legacyShort(other, cheap, 500_000n, 100_000_000n, 10n);
    const rows = (await admin.query<{ userid: number; problem: string }>('SELECT userid, problem FROM app.verify_ledger()')).rows;
    expect(rows.filter((r) => r.userid === h.u)).toEqual([{ userid: h.u, problem: 'overflow' }]);
    expect(rows).toContainEqual({ userid: other, problem: 'short' });
  }, 60_000);
});

describe('que no vuelva', () => {
  it('verify_ledger pliega una sola vez por usuario', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL track_functions = 'pl'");
      // Una llamada que termina en excepción (el usuario con overflow) no entra en las estadísticas.
      const overflow = Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM app.verify_ledger() WHERE problem = 'overflow'")).rows[0].n);
      const users = Number((await c.query<{ n: string }>("SELECT count(DISTINCT userid)::text AS n FROM app.orders WHERE status = 'FILLED'")).rows[0].n);
      const calls = Number((await c.query<{ c: string }>(
        "SELECT calls::text AS c FROM pg_stat_xact_user_functions WHERE funcname = 'c_state'")).rows[0]?.c ?? 0);
      expect(calls).toBe(users - overflow);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });

  it('ninguna función de app devuelve cost_total como int8', async () => {
    const rows = (await admin.query<{ fn: string; typ: string }>(
      `SELECT p.proname AS fn, format_type(t.typ, NULL) AS typ
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
              LATERAL unnest(p.proallargtypes, p.proargnames) AS t(typ, nm)
        WHERE n.nspname = 'app' AND t.nm = 'cost_total'`)).rows;
    expect(rows.map((r) => r.fn).sort()).toEqual(['c_state', 'read_portfolio']);
    for (const r of rows) expect(r.typ, r.fn).toBe('numeric');
  });

  it('un movimiento de cash por encima de D-05 llamando a place_order directo → APP02, no 22003', async () => {
    const u = await newUser('cost-d05');
    await expect(placeOrder(pool, { userid: u, key: 'a', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '10000000000.00' }))
      .rejects.toMatchObject({ code: 'APP02' });
    await expect(placeOrder(pool, { userid: u, key: 'b', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '100000000000000000.00' }))
      .rejects.toMatchObject({ code: 'APP02' });
    expect(await ordersOf(u)).toBe(0);
  });
});
