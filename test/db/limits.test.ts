// Límites de dominio (D-14) al ejecutar una LIMIT: execute_limit valida el tope antes de pasar
// a FILLED. Si lo violaría, la orden queda CANCELLED, libera su reserva, sale del executor y el
// reporte la lista aparte con motivo LIMIT (issue #2).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { executeLimits } from '../../src/repositories/ops.repo.js';
import { OrderBody, requestHash } from '../../src/domain/orders.js';
import { admin, apiClient, arsId, fmt, newUser, placeOrder } from '../support/db.js';

const CAP_CENTS = 100_000_000_000_000_000n;   // 10¹⁵ ARS en centavos

let ars: number;
let inst: number;   // close 5.000,00: las cuentas del issue, exactas
let big: number;    // close 9.500.000.000.000,00: 1.000 acciones suman 9,5 × 10¹⁵ ARS
let high: number;   // close 6.000,00: una SELL LIMIT a 5.000 cruza y se ejecuta a 5.000, no a 6.000

/** Instrumento propio, con una cotización de hoy: ninguna otra prueba lo usa. */
async function instrument(ticker: string, close: string): Promise<number> {
  const id = (await admin.query<{ id: number }>(
    "INSERT INTO app.instruments (ticker, name, type) VALUES ($1, $2, 'ACCIONES') RETURNING id", [ticker, `Prueba D-14 ${ticker}`],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
     VALUES ($1, $2, $2, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`, [id, close]);
  return id;
}

beforeAll(async () => {
  ars = await arsId();
  inst = await instrument('D14TEST', '5000.00');
  big = await instrument('D14BIG', '9500000000000.00');
  high = await instrument('D14HIGH', '6000.00');
});
afterAll(async () => { await admin.end(); await pool.end(); });

const cash = async (u: number) =>
  BigInt((await admin.query<{ c: string }>('SELECT cash_cents::text AS c FROM app.c_state($1) WHERE kind = 0', [u])).rows[0].c);
const reservedShares = async (u: number, iid = inst) =>
  (await admin.query<{ r: string }>('SELECT reserved::text AS r FROM app.read_portfolio($1) WHERE kind = 1 AND instrumentid = $2', [u, iid])).rows[0].r;
const orderRow = async (id: string) =>
  (await admin.query('SELECT status, balance_seq FROM app.orders WHERE id = $1', [id])).rows[0];
const ordersOf = async (u: number) =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n;
/** Ejecuta la orden por una de las dos entradas; devuelve su resultado tal cual. */
const run = async (fn: 'execute_limit' | 'execute_limit_outcome', id: string) =>
  (await pool.query<{ r: boolean | string }>(`SELECT app.${fn}($1) AS r`, [Number(id)])).rows[0].r;
/** Las dos entradas y lo que devuelven para una orden cancelada por el tope. */
const VIA_LIMIT = [['execute_limit', false], ['execute_limit_outcome', 'LIMIT']] as const;
const candidates = async () =>
  (await admin.query<{ order_id: string }>('SELECT order_id::text FROM app.limit_candidates(1000000)')).rows.map((r) => r.order_id);

/**
 * Usuario con 1.000 acciones de `iid` y exactamente `cashCents` de cash. La historia se escribe
 * como heredada (admin): un CASH_IN admite a lo sumo 2³¹ − 1 centavos (D-05), así que llegar
 * cerca de 10¹⁵ ARS por la API pediría millones de depósitos.
 * CASH_IN 1.000,00 → BUY 1.001 @ 0,01 → SELL 1 al precio que deja el cash en `cashCents`.
 */
async function richUser(cashCents: bigint, iid = inst): Promise<number> {
  const u = await newUser('d14');
  const ins = (side: string, iid: number, size: bigint, priceCents: bigint, seq: number) => admin.query(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
     VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`,
    [iid, u, size.toString(), fmt(priceCents), side, seq]);
  await ins('CASH_IN', ars, 100_000n, 1n, 1);
  await ins('BUY', iid, 1001n, 1n, 2);
  await ins('SELL', iid, 1n, cashCents - 100_000n + 1001n, 3);
  expect(await cash(u)).toBe(cashCents);
  return u;
}

/** LIMIT `NEW` escrita directo como administrador (historia heredada): la API no la validó. */
const legacyNew = async (u: number, iid: number, side: 'BUY' | 'SELL', size: number, price: string) =>
  (await admin.query<{ id: string }>(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
     VALUES ($1, $2, $3, $4, 'LIMIT', $5, 'NEW', timezone('UTC', now())) RETURNING id::text`,
    [iid, u, size, price, side])).rows[0].id;

/** SELL LIMIT 1.000 @ 5.000,00: cruza con el close de `iid` y suma 5.000.000,00 ARS al cash. */
const sellLimit = (u: number, iid = inst) =>
  placeOrder(pool, { userid: u, key: 'sl', side: 'SELL', type: 'LIMIT', instrumentid: iid, size: 1000, limit: '5000.00' });

describe('execute_limit valida D-14 antes de confirmar', () => {
  it('cash 999.999.999.999.000,00 y SELL LIMIT 1.000 @ 5.000 que cruza → false, CANCELLED, cash sin cambios, sin balance_seq, reserva liberada', async () => {
    const start = 99_999_999_999_900_000n;            // 999.999.999.999.000,00 ARS
    const u = await richUser(start);
    const lim = await sellLimit(u);
    expect(lim.body.status).toBe('NEW');
    expect(await reservedShares(u)).toBe('1000');

    const r = await pool.query<{ r: boolean }>('SELECT app.execute_limit($1) AS r', [Number(lim.order_id)]);
    expect(r.rows[0].r).toBe(false);
    expect(await orderRow(lim.order_id)).toEqual({ status: 'CANCELLED', balance_seq: null });
    expect(await cash(u)).toBe(start);
    expect(await reservedShares(u)).toBe('0');
  });

  it('control: SELL LIMIT que cruza y deja el cash exactamente en 10¹⁵ ARS → FILLED como antes', async () => {
    const u = await richUser(CAP_CENTS - 500_000_000n);   // 999.999.995.000.000,00 ARS
    const lim = await sellLimit(u);
    const r = await pool.query<{ r: boolean }>('SELECT app.execute_limit($1) AS r', [Number(lim.order_id)]);
    expect(r.rows[0].r).toBe(true);
    expect(await orderRow(lim.order_id)).toEqual({ status: 'FILLED', balance_seq: '4' });
    expect(await cash(u)).toBe(CAP_CENTS);
  });

  it('el importe se calcula al precio límite, no al close: close 6.000, SELL LIMIT 1.000 @ 5.000 que deja el cash en 10¹⁵ → FILLED', async () => {
    const u = await richUser(CAP_CENTS - 500_000_000n, high);   // al close (6.000) superaría el tope por 1.000.000,00
    const lim = await sellLimit(u, high);
    expect(await run('execute_limit_outcome', lim.order_id)).toBe('FILLED');
    expect(await orderRow(lim.order_id)).toEqual({ status: 'FILLED', balance_seq: '4' });
    expect(await cash(u)).toBe(CAP_CENTS);
  });

  it('MARKET que dejaría el cash por encima del tope → 422 LIMIT (APP05), sin orden', async () => {
    const u = await richUser(99_999_999_999_900_000n);
    const before = await ordersOf(u);
    await expect(placeOrder(pool, { userid: u, key: 'm', side: 'SELL', type: 'MARKET', instrumentid: inst, size: 1000 }))
      .rejects.toMatchObject({ code: 'APP05' });
    expect(await ordersOf(u)).toBe(before);
  });
});

// El tope de posición (2⁶² acciones, D-14) no tiene prueba de frontera: `size` es integer, así que
// sembrar una posición de ese tamaño pediría ~2³¹ órdenes. La regla está en execute_limit_outcome y
// place_order, junto a la del cash, que sí se prueba arriba.

describe('executor con LIMITs que violarían D-14 en el lote', () => {
  let bad: string;    // el ejemplo del issue: supera 10¹⁵ ARS; antes se confirmaba FILLED
  let huge: string;   // el cash quedaría en ~1,05 × 10¹⁶ ARS: diez veces el tope
  let good: string;

  beforeAll(async () => {
    // Las que violan van primero (id menor): antes ocupaban su lugar del lote en cada corrida.
    bad = (await sellLimit(await richUser(99_999_999_999_900_000n))).order_id;
    // Importe 9,5 × 10¹⁵: por la API ya no se puede crear (tope por orden); se escribe como heredada.
    huge = await legacyNew(await richUser(99_999_999_999_900_000n, big), big, 'SELL', 1000, '9500000000000.00');
    const w = await newUser('d14-ok');
    await placeOrder(pool, { userid: w, key: 'c', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '5000.00' });
    const ok = await placeOrder(pool, { userid: w, key: 'b', side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, limit: '5000.00' });
    expect(ok.body.status).toBe('NEW');
    good = ok.order_id;
    expect(await candidates()).toEqual(expect.arrayContaining([bad, huge, good]));
  });

  it('misma corrida: la válida se ejecuta y las otras se listan aparte con motivo LIMIT; una sentencia por candidata', async () => {
    const query = vi.spyOn(pool, 'query');
    const connect = vi.spyOn(pool, 'connect');
    let r: Awaited<ReturnType<typeof executeLimits>>;
    let sqls: string[];
    let connects: number;
    try {
      r = await executeLimits(1_000_000);
      sqls = query.mock.calls.map((c) => String(c[0]));
      connects = connect.mock.calls.length;
    } finally { query.mockRestore(); connect.mockRestore(); }
    // Issue #1 (D-20): la selección y después exactamente una sentencia por candidata, sin
    // consultas auxiliares ni transacciones explícitas (cada pool.query toma su conexión una vez).
    expect(sqls[0]).toMatch(/app\.limit_candidates/);
    expect(sqls.slice(1)).toEqual(Array(r.candidates).fill('SELECT app.execute_limit_outcome($1) AS r'));
    expect(connects).toBe(sqls.length);
    expect(r.executed).toContain(good);
    expect(r.cancelled).toEqual(expect.arrayContaining([{ order_id: bad, reason: 'LIMIT' }, { order_id: huge, reason: 'LIMIT' }]));
    for (const id of [bad, huge]) {
      expect(r.executed).not.toContain(id);
      expect(r.not_crossed).not.toContain(id);
      expect(r.errors.map((e) => e.order_id)).not.toContain(id);
      expect(await orderRow(id)).toEqual({ status: 'CANCELLED', balance_seq: null });
    }
    expect(await orderRow(good)).toMatchObject({ status: 'FILLED' });
  });

  it('siguiente corrida: las canceladas ya no son candidatas ni aparecen en el reporte', async () => {
    const next = await candidates();
    expect(next).not.toContain(bad);
    expect(next).not.toContain(huge);
    const r = await executeLimits(1_000_000);
    const listed = [...r.executed, ...r.not_crossed, ...r.cancelled.map((c) => c.order_id), ...r.errors.map((e) => e.order_id)];
    expect(listed).not.toContain(bad);
    expect(listed).not.toContain(huge);
  });
});

// Issue #21: el motivo queda en la orden, no solo en el reporte del executor.
describe('el motivo de la cancelación por el tope se ve en la orden', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp({ internalToken: 'test-token' }).listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  it('LIMIT cancelada por D-14 → GET /orders/:id devuelve CANCELLED con cancel_reason "LIMIT"', async () => {
    const u = await richUser(99_999_999_999_900_000n);
    const lim = await sellLimit(u);
    expect(lim.body.cancel_reason).toBeNull();
    expect(await run('execute_limit_outcome', lim.order_id)).toBe('LIMIT');
    const r = await fetch(`${base}/orders/${lim.order_id}?userid=${u}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ...lim.body, status: 'CANCELLED', cancel_reason: 'LIMIT' });
  });

  it('el 409 de cancelar una LIMIT ya cancelada por el tope trae la orden con cancel_reason "LIMIT"', async () => {
    const u = await richUser(99_999_999_999_900_000n);
    const lim = await sellLimit(u);
    expect(await run('execute_limit', lim.order_id)).toBe(false);
    const r = await fetch(`${base}/orders/${lim.order_id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userid: u }) });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { order: unknown }).order).toEqual({ ...lim.body, status: 'CANCELLED', cancel_reason: 'LIMIT' });
  });
});

describe('una cancelación del usuario no se confunde con una por LIMIT', () => {
  it('LIMIT que el usuario ya canceló → execute_limit_outcome da SKIPPED, no LIMIT', async () => {
    const w = await newUser('d14-user');
    await placeOrder(pool, { userid: w, key: 'c', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '5000.00' });
    const lim = await placeOrder(pool, { userid: w, key: 'b', side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, limit: '5000.00' });
    expect((await pool.query<{ r: boolean }>('SELECT app.cancel_order($1, $2) AS r', [w, Number(lim.order_id)])).rows[0].r).toBe(true);
    // Bajo el lock ya no está NEW: no la toca y no la informa como cancelada por LIMIT.
    expect(await run('execute_limit_outcome', lim.order_id)).toBe('SKIPPED');
  });
});

// Dos conexiones reales y el lock del usuario como barrera (nunca setTimeout para coordinar).
describe('concurrencia: la decisión de D-14 se toma con el estado leído bajo el lock', () => {
  const userLock = "SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)";

  /** Espera hasta que alguna sesión que cumpla `where` esté bloqueada en un advisory lock. */
  async function waitingOnLock(where: string, arg: unknown, failed: () => unknown): Promise<void> {
    for (;;) {
      const err = failed();
      if (err) throw err;
      const w = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE ${where} AND wait_event_type = 'Lock' AND wait_event = 'advisory'`, [arg]);
      if (w.rowCount) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Cliente api; cada sentencia es su propia transacción. */
  async function session() {
    const c = await apiClient();
    const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return { c, pid };
  }

  it('un crédito confirmado mientras la ejecución espera el lock la vuelve inválida → LIMIT, CANCELLED, cash sin el importe', async () => {
    const start = CAP_CENTS - 500_000_000n;   // la SELL entra justo: el cash quedaría en 10¹⁵
    const u = await richUser(start);
    const lim = await sellLimit(u);
    const a = await apiClient();
    const b = await session();
    try {
      await a.query('BEGIN');
      await a.query(userLock, [u]);
      let failed: unknown = null;
      const exec = b.c.query<{ r: string }>('SELECT app.execute_limit_outcome($1) AS r', [Number(lim.order_id)])
        .catch((e) => { failed = e; throw e; });
      await waitingOnLock('pid = $1', b.pid, () => failed);   // la ejecución ya espera el lock
      const credit = await placeOrder(a, { userid: u, key: 'cr', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '0.01' });
      expect(credit.body.status).toBe('FILLED');
      await a.query('COMMIT');
      expect((await exec).rows[0].r).toBe('LIMIT');   // leyó el cash con el crédito: 10¹⁵ + 0,01
    } finally { await a.end(); await b.c.end(); }
    expect(await orderRow(lim.order_id)).toEqual({ status: 'CANCELLED', balance_seq: null });
    expect(await cash(u)).toBe(start + 1n);
  });

  it('dos ejecuciones de la misma LIMIT inválida → exactamente un LIMIT y un SKIPPED; una sola cancelación', async () => {
    const start = 99_999_999_999_900_000n;
    const u = await richUser(start);
    const lim = await sellLimit(u);
    const a = await apiClient();
    const b = await session();
    const c = await session();
    try {
      await a.query('BEGIN');
      await a.query(userLock, [u]);
      let failed: unknown = null;
      const execute = (s: { c: typeof a }) => s.c.query<{ r: string }>('SELECT app.execute_limit_outcome($1) AS r', [Number(lim.order_id)])
        .catch((e) => { failed = e; throw e; });
      const pb = execute(b);
      const pc = execute(c);
      await waitingOnLock('pid = $1', b.pid, () => failed);
      await waitingOnLock('pid = $1', c.pid, () => failed);
      await a.query('COMMIT');
      const results = (await Promise.all([pb, pc])).map((r) => r.rows[0].r).sort();
      expect(results).toEqual(['LIMIT', 'SKIPPED']);
    } finally { await a.end(); await b.c.end(); await c.c.end(); }
    expect(await orderRow(lim.order_id)).toEqual({ status: 'CANCELLED', balance_seq: null });
    expect(await cash(u)).toBe(start);
  });

  it('la cotización deja de ser válida entre la selección y la ejecución → error APP01, la orden sigue NEW y no figura como LIMIT', async () => {
    const gone = await instrument('D14GONE', '5000.00');
    const w = await newUser('d14-gone');
    await placeOrder(pool, { userid: w, key: 'c', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '5000.00' });
    const lim = await placeOrder(pool, { userid: w, key: 'b', side: 'BUY', type: 'LIMIT', instrumentid: gone, size: 1, limit: '5000.00' });
    expect(await candidates()).toContain(lim.order_id);
    const a = await apiClient();
    try {
      await a.query('BEGIN');
      await a.query(userLock, [w]);
      let failed: unknown = null;
      // Cuando queda esperando el lock de este usuario, el executor ya eligió sus candidatas.
      const report = executeLimits(1_000_000).catch((e) => { failed = e; throw e; });
      await waitingOnLock("query LIKE $1", 'SELECT app.execute_limit_outcome%', () => failed);
      await admin.query('DELETE FROM app.marketdata WHERE instrumentid = $1', [gone]);
      await a.query('COMMIT');
      const r = await report;
      expect(r.errors).toContainEqual({ order_id: lim.order_id, error: 'APP01' });
      expect(r.cancelled.map((x) => x.order_id)).not.toContain(lim.order_id);
      expect(r.executed).not.toContain(lim.order_id);
    } finally { await a.end(); }
    expect(await orderRow(lim.order_id)).toEqual({ status: 'NEW', balance_seq: null });
  });

  it('el usuario cancela entre la selección y la ejecución → el executor la lista en not_crossed, no en cancelled', async () => {
    const w = await newUser('d14-race');
    await placeOrder(pool, { userid: w, key: 'c', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '5000.00' });
    const lim = await placeOrder(pool, { userid: w, key: 'b', side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, limit: '5000.00' });
    expect(await candidates()).toContain(lim.order_id);
    const a = await apiClient();
    try {
      await a.query('BEGIN');
      await a.query(userLock, [w]);
      let failed: unknown = null;
      // Cuando queda esperando el lock de este usuario, el executor ya eligió sus candidatas.
      const report = executeLimits(1_000_000).catch((e) => { failed = e; throw e; });
      await waitingOnLock("query LIKE $1", 'SELECT app.execute_limit_outcome%', () => failed);
      expect((await a.query<{ r: boolean }>('SELECT app.cancel_order($1, $2) AS r', [w, Number(lim.order_id)])).rows[0].r).toBe(true);
      await a.query('COMMIT');
      const r = await report;
      expect(r.not_crossed).toContain(lim.order_id);
      expect(r.cancelled.map((x) => x.order_id)).not.toContain(lim.order_id);
      expect(r.executed).not.toContain(lim.order_id);
      expect(r.errors.map((x) => x.order_id)).not.toContain(lim.order_id);
    } finally { await a.end(); }
    expect(await orderRow(lim.order_id)).toEqual({ status: 'CANCELLED', balance_seq: null });
  });
});

// Tope por orden (D-14, issue #2): size × price ≤ 10¹⁵ ARS en cualquier estado. Sin el tope, una
// LIMIT grande que quedaba NEW o REJECTED (o una MARKET con size máximo sobre un close alto)
// reventaba en un cast y respondía 500.
describe('tope por orden: el importe no supera 10¹⁵ ARS en ningún estado', () => {
  const ONE_E15 = '1000000000000000.00';
  const limit = (u: number, key: string, side: 'BUY' | 'SELL', iid: number, size: number | null, price: string, amount: string | null = null) =>
    placeOrder(pool, { userid: u, key, side, type: 'LIMIT', instrumentid: iid, size, amount, limit: price });
  const statusAndCount = async (u: number) =>
    (await admin.query<{ status: string; n: string }>(
      'SELECT status, count(*)::text AS n FROM app.orders WHERE userid = $1 GROUP BY status', [u])).rows;

  describe('frontera por cada camino que calcula el importe', () => {
    it.each([
      ['1 × 10¹⁵', 1, ONE_E15],
      ['10⁸ × 10⁷', 100_000_000, '10000000.00'],
    ])('LIMIT por size, %s exacto → camino normal (REJECTED sin cash); + 0,01 → 422 LIMIT sin orden', async (_n, size, price) => {
      const u = await newUser('cap');
      const ok = await limit(u, 'ok', 'BUY', inst, size, price);
      expect(ok.body.status).toBe('REJECTED');
      expect(ok.body.amount).toBe(ONE_E15);
      const over = size === 1 ? '1000000000000000.01' : '10000000.01';
      await expect(limit(u, 'over', 'BUY', inst, size, over)).rejects.toMatchObject({ code: 'APP05' });
      expect(await statusAndCount(u)).toEqual([{ status: 'REJECTED', n: '1' }]);
    });

    it('LIMIT por amount: el tope es sobre size × price, no sobre el monto', async () => {
      const u = await newUser('cap-amount');
      // amount 10¹⁶ con price 2 × 10¹² → size 5.000 → importe 10¹⁶: 422, no 400 ni 500.
      await expect(limit(u, 'a1', 'BUY', inst, null, '2000000000000.00', '10000000000000000.00')).rejects.toMatchObject({ code: 'APP05' });
      // amount 10¹⁵ con price 6 × 10¹⁴ → size 1 → importe 6 × 10¹⁴ < amount: camino normal.
      const r = await limit(u, 'a2', 'BUY', inst, null, '600000000000000.00', ONE_E15);
      expect(r.body).toMatchObject({ status: 'REJECTED', size: '1', amount: '600000000000000.00' });
      // amount por encima del tope y el mismo importe: lo que se acota es size × price, no el monto.
      const r2 = await limit(u, 'a3', 'BUY', inst, null, '600000000000000.00', '1000000000000000.01');
      expect(r2.body).toMatchObject({ status: 'REJECTED', size: '1', amount: '600000000000000.00' });
      expect(await ordersOf(u)).toBe(2);
    });

    it('MARKET por size sobre un close de 9,5 × 10¹²: size máximo → 422 LIMIT, no 500', async () => {
      const u = await newUser('cap-market');
      await expect(placeOrder(pool, { userid: u, key: 'm', side: 'BUY', type: 'MARKET', instrumentid: big, size: 2_147_483_647 }))
        .rejects.toMatchObject({ code: 'APP05' });
      expect(await ordersOf(u)).toBe(0);
    });

    it('MARKET por amount sobre ese close: amount 2 × 10¹⁶ → 422 LIMIT, no 500 con REJECTED', async () => {
      const u = await newUser('cap-market-amount');
      await expect(placeOrder(pool, { userid: u, key: 'm', side: 'BUY', type: 'MARKET', instrumentid: big, amount: '20000000000000000.00' }))
        .rejects.toMatchObject({ code: 'APP05' });
      expect(await ordersOf(u)).toBe(0);
    });
  });

  describe('el precio solo', () => {
    it('BUY LIMIT size 1 a 10¹⁶ → 422 LIMIT (antes: 500 al asignar price, antes del lock)', async () => {
      const u = await newUser('cap-price');
      await expect(limit(u, 'p', 'BUY', inst, 1, '10000000000000000.00')).rejects.toMatchObject({ code: 'APP05' });
      expect(await ordersOf(u)).toBe(0);
    });

    it('price de 10.000 dígitos por HTTP → 422, nunca 500', async () => {
      const server = createApp({ internalToken: 'test-token' }).listen(0);
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const u = await newUser('cap-digits');
        const r = await fetch(`${base}/orders`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'digits' },
          body: JSON.stringify({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, price: '9'.repeat(10_000) + '.00' }) });
        expect(r.status).toBe(422);
        expect(((await r.json()) as { error: string }).error).toBe('LIMIT');
        expect(await ordersOf(u)).toBe(0);
      } finally { server.close(); }
    });
  });

  describe('orden de evaluación y efectos del 422', () => {
    it('con el lock del usuario tomado por otra sesión, una LIMIT por size fuera del tope responde 422 enseguida, no 503', async () => {
      const u = await newUser('cap-lock');
      const a = await apiClient();
      try {
        await a.query('BEGIN');
        await a.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);
        const t0 = Date.now();
        await expect(limit(u, 'l', 'BUY', inst, 2, ONE_E15)).rejects.toMatchObject({ code: 'APP05' });
        expect(Date.now() - t0).toBeLessThan(1000);   // lock_timeout es 2 s: no lo esperó
        await a.query('ROLLBACK');
      } finally { await a.end(); }
    });

    it('amount cuyo cociente no entra en bigint, LIMIT y MARKET por HTTP → 400, sin orden, y la clave sigue libre', async () => {
      const server = createApp({ internalToken: 'test-token' }).listen(0);
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const u = await newUser('cap-quotient');
        await placeOrder(pool, { userid: u, key: 'c', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '10000.00' });
        const post = (key: string, body: Record<string, unknown>) => fetch(`${base}/orders`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({ userid: u, side: 'BUY', instrumentid: inst, ...body }) });
        // 10²⁰ / 1,00 y 10²³ / 5.000,00: cocientes de 10²⁰ y 2 × 10¹⁹, por encima de 2⁶³ − 1. Antes: 500 (22003).
        for (const [key, body] of [
          ['ql', { type: 'LIMIT', amount: '100000000000000000000.00', price: '1.00' }],
          ['qm', { type: 'MARKET', amount: '100000000000000000000000.00' }],
        ] as const) {
          const r = await post(key, body);
          expect(r.status, key).toBe(400);
          expect(((await r.json()) as { message: string }).message, key).toMatch(/cantidad supera el máximo/);
          const ok = await post(key, { type: 'MARKET', size: 1 });
          expect(ok.status, key).toBe(201);
          expect(ok.headers.get('idempotent-replay'), key).toBe('false');
        }
        expect(await statusAndCount(u)).toEqual([{ status: 'FILLED', n: '3' }]);   // el CASH_IN y las dos válidas
      } finally { server.close(); }
    });

    it('la clave no se consume: misma clave y mismo body → otra vez 422; otro body → 201', async () => {
      const u = await newUser('cap-key');
      await expect(limit(u, 'k', 'BUY', inst, 2, ONE_E15)).rejects.toMatchObject({ code: 'APP05' });
      await expect(limit(u, 'k', 'BUY', inst, 2, ONE_E15)).rejects.toMatchObject({ code: 'APP05' });
      const r = await limit(u, 'k', 'BUY', inst, 1, ONE_E15);
      expect(r.replay).toBe(false);
      expect(r.body.status).toBe('REJECTED');
      expect(await ordersOf(u)).toBe(1);
    });
  });

  describe('compatibilidad con una NEW heredada por encima del tope', () => {
    it('SELL LIMIT NEW de 9,5 × 10¹⁵: GET, portfolio, cancel y executor siguen funcionando', async () => {
      const server = createApp({ internalToken: 'test-token' }).listen(0);
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const u = await richUser(1_000_000n, big);
        const id = await legacyNew(u, big, 'SELL', 1000, '9500000000000.00');
        const get = await fetch(`${base}/orders/${id}?userid=${u}`);
        expect(get.status).toBe(200);
        expect(await get.json()).toMatchObject({ status: 'NEW', amount: '9500000000000000.00' });
        const pf = await fetch(`${base}/portfolio/${u}`);
        expect(((await pf.json()) as { positions: { instrumentid: number; acciones_reservadas: string }[] }).positions
          .find((p) => p.instrumentid === big)!.acciones_reservadas).toBe('1000');
        // El executor la cancela por el tope de cash (D-14), como a cualquier otra.
        expect(await run('execute_limit_outcome', id)).toBe('LIMIT');
        expect(await orderRow(id)).toEqual({ status: 'CANCELLED', balance_seq: null });
        // Otra del mismo importe, que cancela el usuario: libera su reserva.
        const id2 = await legacyNew(u, big, 'SELL', 1000, '9500000000000.00');
        expect(await reservedShares(u, big)).toBe('1000');
        const cancel = await fetch(`${base}/orders/${id2}/cancel`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userid: u }) });
        expect(cancel.status).toBe(200);
        expect(await cancel.json()).toMatchObject({ id: id2, status: 'CANCELLED', cancel_reason: 'USER', amount: '9500000000000000.00' });
        expect(await reservedShares(u, big)).toBe('0');
      } finally { server.close(); }
    });

    // D-19: una clave vigente al desplegar guarda la respuesta que dio la versión anterior, que
    // aceptaba esta orden. El mismo request tiene que seguir dando esa respuesta, no 422.
    it('una clave grabada antes del tope sigue dando replay: 201, el mismo cuerpo, sin orden nueva', async () => {
      const server = createApp({ internalToken: 'test-token' }).listen(0);
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const u = await richUser(1_000_000n, big);
        const req = { userid: u, side: 'SELL', type: 'LIMIT', instrumentid: big, size: 1000, price: '9500000000000.00' };
        // Lo que grabó la versión anterior: la orden NEW y su clave, con el hash del request y la
        // respuesta del 201 (la misma forma que GET /orders/:id).
        const id = await legacyNew(u, big, 'SELL', 1000, '9500000000000.00');
        const original = await (await fetch(`${base}/orders/${id}?userid=${u}`)).json();
        await admin.query(
          `INSERT INTO app.idempotency_keys (userid, key, request_hash, order_id, http_status, response_body)
           VALUES ($1, 'pre', $2, $3, 201, $4)`, [u, requestHash(OrderBody.parse(req)), id, original]);
        const before = await ordersOf(u);
        const post = (key: string, body: Record<string, unknown>) => fetch(`${base}/orders`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });

        const r = await post('pre', req);
        expect(r.status).toBe(201);
        expect(r.headers.get('idempotent-replay')).toBe('true');
        expect(await r.json()).toEqual(original);
        // La misma clave con otro body sigue siendo un conflicto de clave; una clave libre, el tope.
        const other = await post('pre', { ...req, size: 999 });
        expect([other.status, ((await other.json()) as { error: string }).error]).toEqual([422, 'IDEMPOTENCY_MISMATCH']);
        const fresh = await post('nueva', req);
        expect([fresh.status, ((await fresh.json()) as { error: string }).error]).toEqual([422, 'LIMIT']);
        expect(await ordersOf(u)).toBe(before);
      } finally { server.close(); }
    });
  });

  describe('la clase de bug: ningún 500 dentro del rango, 422 fuera', () => {
    const sizes = [1, 1000, 2_147_483_647];
    const prices = ['0.01', '1.00', '10000000.00', ONE_E15];
    const cases = sizes.flatMap((size) => prices.map((price) => [size, price] as const));
    it.each(cases)('LIMIT BUY y SELL con size %s y price %s → 201 si size × price ≤ 10¹⁵, 422 LIMIT si no; nunca otro error', async (size, price) => {
      const u = await newUser('cap-grid');
      const over = BigInt(size) * BigInt(price.replace('.', '')) > CAP_CENTS;
      for (const side of ['BUY', 'SELL'] as const) {
        const p = limit(u, side, side, inst, size, price);
        if (over) await expect(p).rejects.toMatchObject({ code: 'APP05' });
        else expect((await p).body.status).toBe('REJECTED');   // sin cash ni acciones, pero con orden
      }
    });
  });
});
