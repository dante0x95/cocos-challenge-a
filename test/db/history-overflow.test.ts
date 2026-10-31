// Un usuario cuya historia FILLED no entra en los tipos del fold (issue #57, D-14, D-24). verify_ledger
// lo informa como 'overflow' y el bootstrap no aborta; desde acá es un estado conocido: c_state
// responde APP07, la API 409 HISTORY_OVERFLOW sin "reintentar", y el executor saltea al usuario sin
// tocar sus NEW. Antes: 500 INTERNAL para siempre en portfolio y órdenes, y un error por corrida del
// executor. También la reserva de read_portfolio, que ya no se castea a bigint.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { executeLimits } from '../../src/repositories/ops.repo.js';
import { admin, arsId, fmt, newUser } from '../support/db.js';

let ars: number;
let inst: number;      // close 100,00: una BUY LIMIT a 100,00 cruza
let unquoted: number;  // sin cotización: sus NEW nunca son candidatas del executor
let server: Server;
let base: string;

async function instrument(ticker: string, close: string | null): Promise<number> {
  const id = (await admin.query<{ id: number }>(
    "INSERT INTO app.instruments (ticker, name, type) VALUES ($1, $2, 'ACCIONES') RETURNING id", [ticker, `Overflow 57 ${ticker}`])).rows[0].id;
  if (close !== null) {
    await admin.query(
      `INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
       VALUES ($1, $2, $2, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`, [id, close]);
  }
  return id;
}

/** FILLED heredada con balance_seq dado, como administrador. */
const filled = (u: number, iid: number, side: string, size: number, price: string, seq: number) => admin.query(
  `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
   VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`, [iid, u, size, price, side, seq]);

/** n LIMIT NEW heredadas, en una sentencia. Ids en orden. */
async function pending(u: number, iid: number, side: string, n: number, size: number, price: string): Promise<string[]> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
     SELECT $1, $2, $3, $4, 'LIMIT', $5, 'NEW', timezone('UTC', now()) FROM generate_series(1, $6::int)
     RETURNING id::text`, [iid, u, size, price, side, n]);
  return r.rows.map((x) => x.id).sort((a, b) => Number(a) - Number(b));
}

/** Usuario con la historia del issue: un importe (2³¹ − 1) × (10¹⁶ − 0,01) fuera de numeric(20,0). */
async function overflowUser(): Promise<number> {
  const u = await newUser('ovf57');
  await filled(u, ars, 'CASH_IN', 100_000, '0.01', 1);
  await filled(u, inst, 'BUY', 2_147_483_647, '9999999999999999.99', 2);
  return u;
}

const orderState = async (ids: string[]) =>
  (await admin.query<{ id: string; status: string; cancel_reason: string | null }>(
    'SELECT id::text, status, cancel_reason FROM app.orders WHERE id = ANY($1::bigint[]) ORDER BY id', [ids])).rows;
const countOf = async (sql: string, u: number) => (await admin.query<{ n: number }>(sql, [u])).rows[0].n;

const postOrder = async (key: string, body: Record<string, unknown>) => {
  const r = await fetch(`${base}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return {
    status: r.status, retryAfter: r.headers.get('retry-after'), replay: r.headers.get('idempotent-replay'),
    body: (await r.json()) as Record<string, string>,
  };
};

beforeAll(async () => {
  ars = await arsId();
  inst = await instrument('OVF57', '100.00');
  unquoted = await instrument('OVF57R', null);
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  // Sin cotización, las NEW que quedan del usuario con overflow dejan de ser candidatas para las demás suites.
  await admin.query('DELETE FROM app.marketdata WHERE instrumentid = $1', [inst]);
  server.close(); await admin.end(); await pool.end();
});

describe('historia fuera de los tipos: un estado conocido, no un 500', () => {
  it('verify_ledger la sigue informando como overflow, con la causa del fold', async () => {
    const u = await overflowUser();
    const rows = (await admin.query<{ problem: string; detail: string }>(
      'SELECT problem, detail FROM app.verify_ledger() WHERE userid = $1', [u])).rows;
    expect(rows).toEqual([{ problem: 'overflow', detail: expect.stringMatching(/supera los tipos.*numeric field overflow/) }]);
  }, 60_000);

  it('c_state falla con APP07 (no 22003) y el error de origen en el detalle', async () => {
    const u = await overflowUser();
    await expect(admin.query('SELECT * FROM app.c_state($1)', [u]))
      .rejects.toMatchObject({ code: 'APP07', message: expect.stringMatching(/no reintentar/), detail: expect.stringMatching(/overflow/) });
  });

  it('GET /portfolio → 409 HISTORY_OVERFLOW, sin Retry-After ni "reintentar"', async () => {
    const u = await overflowUser();
    const r = await fetch(`${base}/portfolio/${u}`);
    expect(r.status).toBe(409);
    expect(r.headers.get('retry-after')).toBeNull();
    const body = (await r.json()) as { error: string; message: string };
    expect(body).toEqual({ error: 'HISTORY_OVERFLOW', message: `la historia del usuario ${u} supera los tipos del cálculo (D-14): no puede operar hasta que se corrija; no reintentar` });
  });

  it('POST /orders → 409 sin orden ni clave; el reintento con la misma clave da lo mismo, nunca 500', async () => {
    const u = await overflowUser();
    const before = await countOf('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', u);
    for (const [key, body] of [
      ['dep', { userid: u, side: 'CASH_IN', amount: '1.00' }],
      ['dep', { userid: u, side: 'CASH_IN', amount: '1.00' }],
      ['mkt', { userid: u, side: 'SELL', type: 'MARKET', instrumentid: inst, size: 1 }],
      ['lim', { userid: u, side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, price: '1.00' }],
    ] as const) {
      const r = await postOrder(key, body);
      expect({ status: r.status, error: r.body.error, retryAfter: r.retryAfter }, key).toEqual({ status: 409, error: 'HISTORY_OVERFLOW', retryAfter: null });
      expect(r.body.message, key).not.toMatch(/Idempotency-Key/);
    }
    expect(await countOf('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', u)).toBe(before);
    expect(await countOf('SELECT count(*)::int AS n FROM app.idempotency_keys WHERE userid = $1', u)).toBe(0);
  });

  it('una clave grabada antes de que la historia desborde sigue dando su replay idéntico; una clave nueva → 409', async () => {
    const u = await newUser('ovf57-replay');
    const req = { userid: u, side: 'CASH_IN', amount: '1.00' };
    const first = await postOrder('dep', req);
    expect({ status: first.status, replay: first.replay }).toEqual({ status: 201, replay: 'false' });
    const key = async () => (await admin.query(
      'SELECT request_hash, created_at, http_status, response_body, order_id FROM app.idempotency_keys WHERE userid = $1', [u])).rows;
    const keyBefore = await key();
    // Después, la historia pasa a desbordar (balance_seq 2, después del depósito).
    await filled(u, inst, 'BUY', 2_147_483_647, '9999999999999999.99', 2);
    await expect(admin.query('SELECT * FROM app.c_state($1)', [u])).rejects.toMatchObject({ code: 'APP07' });
    const orders = await countOf('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', u);

    const again = await postOrder('dep', req);
    expect({ status: again.status, replay: again.replay, body: again.body }).toEqual({ status: 201, replay: 'true', body: first.body });
    expect(await key()).toEqual(keyBefore);
    const fresh = await postOrder('dep2', req);
    expect({ status: fresh.status, error: fresh.body.error }).toEqual({ status: 409, error: 'HISTORY_OVERFLOW' });
    expect(await countOf('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', u)).toBe(orders);
    expect(await countOf('SELECT count(*)::int AS n FROM app.idempotency_keys WHERE userid = $1', u)).toBe(1);
  });

  it('el executor saltea a cada usuario con overflow (overflow_users, todos y una vez cada uno), no los anota en errors, deja sus NEW intactas y ejecuta las de los demás', async () => {
    const u = await overflowUser();
    const u2 = await overflowUser();
    // Intercaladas por id: u, u2, u, u2, u. Después de la primera de cada uno, las demás se saltean.
    const mine: string[] = [];
    for (const who of [u, u2, u, u2, u]) mine.push(...await pending(who, inst, 'BUY', 1, 1, '100.00'));
    // Otro usuario con cash, con una NEW posterior que cruza en el mismo instrumento.
    const other = await newUser('ovf57-other');
    await filled(other, ars, 'CASH_IN', 100_000, '0.01', 1);
    const [theirs] = await pending(other, inst, 'BUY', 1, 1, '100.00');

    for (let run = 0; run < 2; run++) {
      const r = await executeLimits({ max: 10_000, perUser: 10_000, maxMs: 60_000 });
      expect(r.overflow_users, `corrida ${run}`).toEqual([String(u), String(u2)]);
      expect(r.skipped_users, `corrida ${run}`).not.toContain(String(u));
      expect(r.skipped_users, `corrida ${run}`).not.toContain(String(u2));
      expect(r.errors.filter((e) => mine.includes(e.order_id)), `corrida ${run}`).toEqual([]);
      expect(r.cancelled.filter((c) => mine.includes(c.order_id)), `corrida ${run}`).toEqual([]);
      if (run === 0) expect(r.executed).toContain(theirs);
    }
    expect(await orderState(mine)).toEqual(mine.map((id) => ({ id, status: 'NEW', cancel_reason: null })));
    expect(await orderState([theirs])).toEqual([{ id: theirs, status: 'FILLED', cancel_reason: null }]);
  }, 60_000);

  it('por HTTP, el reporte trae overflow_users; el usuario puede cancelar sus NEW (cancelar no pliega)', async () => {
    const u = await overflowUser();
    const [id] = await pending(u, inst, 'BUY', 1, 1, '100.00');
    const r = await fetch(`${base}/internal/execute-limits?max=10000&per_user=10000`, { method: 'POST', headers: { 'X-Internal-Token': 'test-token' } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { overflow_users: string[] }).overflow_users).toContain(String(u));
    const c = await fetch(`${base}/orders/${id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userid: u }) });
    expect(c.status).toBe(200);
    expect(await orderState([id])).toEqual([{ id, status: 'CANCELLED', cancel_reason: 'USER' }]);
  }, 60_000);
});

describe('la reserva del portfolio sale como numeric', () => {
  it('100 BUY NEW heredadas de ~10¹⁵ ARS (más de un bigint de centavos en total) → 200 con la reserva exacta; antes, 500', async () => {
    const u = await newUser('ovf57-res');
    await filled(u, ars, 'CASH_IN', 100_000, '0.01', 1);
    // Cada una dentro del tope de D-14 (2³¹ − 1 × 465.661,28 < 10¹⁵ ARS); juntas, 1,0 × 10¹⁹ centavos.
    await pending(u, unquoted, 'BUY', 100, 2_147_483_647, '465661.28');
    const r = await fetch(`${base}/portfolio/${u}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { cash: { neto: string; reservado: string; disponible: string } };
    const reserved = 100n * 2_147_483_647n * 46_566_128n;
    expect(reserved).toBeGreaterThan(2n ** 63n - 1n);
    expect(body.cash).toEqual({ neto: '1000.00', reservado: fmt(reserved), disponible: fmt(100_000n - reserved) });
  }, 60_000);

  it('read_portfolio devuelve reserved como numeric', async () => {
    const t = (await admin.query<{ t: string }>(
      `SELECT format_type(t.typ, NULL) AS t
         FROM pg_proc p, LATERAL unnest(p.proallargtypes, p.proargnames) AS t(typ, nm)
        WHERE p.oid = 'app.read_portfolio(int)'::regprocedure AND t.nm = 'reserved'`)).rows;
    expect(t).toEqual([{ t: 'numeric' }]);
  });
});
