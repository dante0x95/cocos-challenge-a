// Issue #6: una LIMIT NEW heredada (insertada en orders por una base preexistente, sin pasar por
// place_order) puede no tener respaldo: SELL sin acciones, BUY sin cash, o sobre una moneda. El
// executor la cancela con cancel_reason UNBACKED en vez de ejecutarla (execute_limit_outcome
// revalida el respaldo bajo el lock, sin contar la propia reserva); el bootstrap la detecta
// (verify_ledger, problem 'reserva') y la cancela bajo el lock (cancel_unbacked) en vez de abortar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type pg from 'pg';
import { createApp } from '../../src/app.js';
import { verifyLedger } from '../../src/db/bootstrap.js';
import { pool } from '../../src/db/pool.js';
import { executeLimits } from '../../src/repositories/ops.repo.js';
import { admin, apiClient, arsId, fmt, newUser, placeOrder } from '../support/db.js';

let ars: number;
let inst: number;   // close 925,85: las cifras del issue (SELL LIMIT 10 @ 900 cruza y suma 9.000,00)

/** Instrumento propio, con una cotización de hoy: ninguna otra prueba lo usa. */
async function instrument(ticker: string, close: string): Promise<number> {
  const id = (await admin.query<{ id: number }>(
    "INSERT INTO app.instruments (ticker, name, type) VALUES ($1, $2, 'ACCIONES') RETURNING id", [ticker, `Prueba issue #6 ${ticker}`],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
     VALUES ($1, $2, $2, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`, [id, close]);
  return id;
}

beforeAll(async () => {
  ars = await arsId();
  inst = await instrument('UNB6', '925.85');
});
afterAll(async () => { await admin.end(); await pool.end(); });

/**
 * Usuario con historia heredada (admin): CASH_IN y, si `shares` > 0, BUY de `shares` @ 0,01 de
 * `iid`. El cash neto queda en `cashCents`. Devuelve el usuario.
 */
async function legacyUser(tag: string, cashCents: bigint, shares = 0n, iid = inst): Promise<number> {
  const u = await newUser(tag);
  const ins = (side: string, iid: number, size: bigint, seq: number) => admin.query(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
     VALUES ($1, $2, $3, 0.01, 'MARKET', $4, 'FILLED', timezone('UTC', now()), $5)`, [iid, u, size.toString(), side, seq]);
  await ins('CASH_IN', ars, cashCents + shares, 1);
  if (shares > 0n) await ins('BUY', iid, shares, 2);
  expect(await cash(u)).toBe(cashCents);
  return u;
}

/** LIMIT NEW heredada: directo en orders, como la deja una base preexistente. Devuelve su id. */
async function legacyNew(u: number, side: 'BUY' | 'SELL', size: number, price: string, iid = inst): Promise<string> {
  return (await admin.query<{ id: string }>(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
     VALUES ($1, $2, $3, $4, 'LIMIT', $5, 'NEW', timezone('UTC', now())) RETURNING id::text`, [iid, u, size, price, side])).rows[0].id;
}

const cash = async (u: number) =>
  BigInt((await admin.query<{ c: string }>('SELECT cash_cents::text AS c FROM app.c_state($1) WHERE kind = 0', [u])).rows[0].c);
/** Cantidad de `iid` según el fold; null si no hay posición. */
const position = async (u: number, iid = inst) =>
  (await admin.query<{ q: string }>('SELECT qty::text AS q FROM app.c_state($1) WHERE kind = 1 AND instrumentid = $2', [u, iid])).rows[0]?.q ?? null;
const orderRow = async (id: string) =>
  (await admin.query('SELECT status, cancel_reason, balance_seq FROM app.orders WHERE id = $1', [id])).rows[0];
/** Lo que reserva el usuario según read_portfolio: cash en centavos y acciones de `iid` (null si no lista la posición). */
const reserved = async (u: number, iid = inst) => {
  const rows = (await admin.query<{ kind: number; instrumentid: number | null; r: string }>(
    'SELECT kind, instrumentid, reserved::text AS r FROM app.read_portfolio($1)', [u])).rows;
  return { cash: rows.find((r) => r.kind === 0)!.r, shares: rows.find((r) => r.kind === 1 && r.instrumentid === iid)?.r ?? null };
};
const run = async (fn: 'execute_limit' | 'execute_limit_outcome', id: string) =>
  (await pool.query<{ r: boolean | string }>(`SELECT app.${fn}($1) AS r`, [Number(id)])).rows[0].r;
const candidates = async () =>
  (await admin.query<{ order_id: string }>('SELECT order_id::text FROM app.limit_candidates(1000000)')).rows.map((r) => r.order_id);
const listed = (r: Awaited<ReturnType<typeof executeLimits>>) =>
  [...r.executed, ...r.not_crossed, ...r.cancelled.map((c) => c.order_id), ...r.errors.map((e) => e.order_id)];
const UNBACKED = { status: 'CANCELLED', cancel_reason: 'UNBACKED', balance_seq: null };

describe('execute_limit revalida el respaldo al ejecutar', () => {
  it('1. SELL LIMIT legítima por toda la tenencia → FILLED: la propia reserva no cuenta como falta de respaldo', async () => {
    const u = await legacyUser('unb-all', 0n, 10n);
    const lim = await placeOrder(pool, { userid: u, key: 's', side: 'SELL', type: 'LIMIT', instrumentid: inst, size: 10, limit: '900.00' });
    expect(lim.body.status).toBe('NEW');
    expect((await reserved(u)).shares).toBe('10');
    expect(await run('execute_limit_outcome', lim.order_id)).toBe('FILLED');
    expect(await orderRow(lim.order_id)).toEqual({ status: 'FILLED', cancel_reason: null, balance_seq: '3' });
    expect(await position(u)).toBeNull();
    expect(await cash(u)).toBe(900_000n);
  });

  it('2. SELL LIMIT NEW heredada de 10 sin acciones → UNBACKED, CANCELLED sin balance_seq, sin posición en corto, cash intacto, reserva liberada', async () => {
    const u = await legacyUser('unb-sell', 100n);
    const id = await legacyNew(u, 'SELL', 10, '900.00');
    expect(await reserved(u)).toEqual({ cash: '0', shares: null });   // sin posición, la reserva ni se ve
    expect(await run('execute_limit_outcome', id)).toBe('UNBACKED');
    expect(await orderRow(id)).toEqual(UNBACKED);
    expect(await position(u)).toBeNull();
    expect(await cash(u)).toBe(100n);
    expect(await reserved(u)).toEqual({ cash: '0', shares: null });
    // Ya no está NEW: una segunda ejecución no la toca ni la vuelve a informar.
    expect(await run('execute_limit_outcome', id)).toBe('SKIPPED');
  });

  it('2. BUY LIMIT NEW heredada de 10 @ 1.000 con 100,00 de cash → execute_limit da false, CANCELLED con UNBACKED, cash intacto, reserva liberada', async () => {
    const u = await legacyUser('unb-buy', 10_000n);
    const id = await legacyNew(u, 'BUY', 10, '1000.00');   // cruza: close 925,85 ≤ 1.000
    expect((await reserved(u)).cash).toBe('1000000');
    expect(await run('execute_limit', id)).toBe(false);
    expect(await orderRow(id)).toEqual(UNBACKED);
    expect(await position(u)).toBeNull();
    expect(await cash(u)).toBe(10_000n);
    expect((await reserved(u)).cash).toBe('0');
  });

  it('2. el executor las lista en cancelled con motivo UNBACKED, no en executed ni en errors, y en la corrida siguiente ya no son candidatas', async () => {
    const sell = await legacyNew(await legacyUser('unb-exec-s', 100n), 'SELL', 10, '900.00');
    const buy = await legacyNew(await legacyUser('unb-exec-b', 100n), 'BUY', 1, '925.85');
    expect(await candidates()).toEqual(expect.arrayContaining([sell, buy]));
    const r = await executeLimits({ max: 1_000_000 });
    expect(r.cancelled).toEqual(expect.arrayContaining([{ order_id: sell, reason: 'UNBACKED' }, { order_id: buy, reason: 'UNBACKED' }]));
    for (const id of [sell, buy]) {
      expect(r.executed).not.toContain(id);
      expect(r.not_crossed).not.toContain(id);
      expect(r.errors.map((e) => e.order_id)).not.toContain(id);
      expect(await orderRow(id)).toEqual(UNBACKED);
    }
    expect(await candidates()).not.toEqual(expect.arrayContaining([sell]));
    expect(await candidates()).not.toEqual(expect.arrayContaining([buy]));
    const next = await executeLimits({ max: 1_000_000 });
    expect(listed(next)).not.toContain(sell);
    expect(listed(next)).not.toContain(buy);
  });
});

describe('3. tenencia 10 y dos SELL LIMIT NEW de 10 heredadas: el respaldo se evalúa al ejecutar', () => {
  it('(a) cruzan las dos → la de id menor FILLED y la otra UNBACKED; la posición queda en 0, no en −10', async () => {
    const u = await legacyUser('unb-two-a', 0n, 10n);
    const first = await legacyNew(u, 'SELL', 10, '900.00');
    const second = await legacyNew(u, 'SELL', 10, '900.00');
    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
    expect(await reserved(u)).toEqual({ cash: '0', shares: '20' });
    const r = await executeLimits({ max: 1_000_000 });
    expect(r.executed).toContain(first);
    expect(r.cancelled).toContainEqual({ order_id: second, reason: 'UNBACKED' });
    expect(await orderRow(first)).toEqual({ status: 'FILLED', cancel_reason: null, balance_seq: '3' });
    expect(await orderRow(second)).toEqual(UNBACKED);
    expect(await position(u)).toBeNull();
    expect(await cash(u)).toBe(900_000n);
    expect(await reserved(u)).toEqual({ cash: '0', shares: null });
  });

  it('(b) solo cruza la de id mayor → esa FILLED; cuando la otra cruce, UNBACKED', async () => {
    const late = await instrument('UNB6LATE', '925.85');
    const u = await legacyUser('unb-two-b', 0n, 10n, late);
    const first = await legacyNew(u, 'SELL', 10, '1000.00', late);   // no cruza todavía
    const second = await legacyNew(u, 'SELL', 10, '900.00', late);
    const r = await executeLimits({ max: 1_000_000 });
    expect(r.executed).toContain(second);
    expect(r.not_crossed).not.toContain(first);   // ni siquiera es candidata
    expect(listed(r)).not.toContain(first);
    expect(await orderRow(second)).toEqual({ status: 'FILLED', cancel_reason: null, balance_seq: '3' });
    expect(await orderRow(first)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
    expect(await position(u, late)).toBeNull();
    // El close sube y la primera cruza: ya no hay acciones que la respalden.
    await admin.query('UPDATE app.marketdata SET close = 1000.00 WHERE instrumentid = $1', [late]);
    expect(await candidates()).toContain(first);
    const r2 = await executeLimits({ max: 1_000_000 });
    expect(r2.cancelled).toContainEqual({ order_id: first, reason: 'UNBACKED' });
    expect(await orderRow(first)).toEqual(UNBACKED);
    expect(await position(u, late)).toBeNull();
    expect(await cash(u)).toBe(900_000n);
  });
});

describe('5 y 6. lo que hace el bootstrap: verify_ledger señala y cancel_unbacked cancela', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp({ internalToken: 'test-token' }).listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });
  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const positionOf = (p: Record<string, any>, iid: number) => p.positions.find((x: any) => x.instrumentid === iid);
  const verify = async () => {
    const log: string[] = [];
    const r = await verifyLedger(admin, (m) => log.push(m));
    return { ...r, log };
  };

  it('5. tenencia 10, una SELL LIMIT legítima de 10 y una heredada de 10: el portfolio muestra −10 disponibles; la verificación cancela solo la heredada con UNBACKED y quedan 0', async () => {
    const u = await legacyUser('unb-http', 50_000n, 10n);
    const legit = await placeOrder(pool, { userid: u, key: 's', side: 'SELL', type: 'LIMIT', instrumentid: inst, size: 10, limit: '2000.00' });
    expect(legit.body.status).toBe('NEW');
    const legacy = await legacyNew(u, 'SELL', 10, '2000.00');
    expect(positionOf((await get(`/portfolio/${u}`)).body, inst))
      .toMatchObject({ qty: '10', acciones_reservadas: '20', acciones_disponibles: '-10' });

    const r = await verify();
    expect(r.ledger).toContainEqual({ userid: u, problem: 'reserva', detail: `instrumento ${inst}: 20 acciones reservadas > tenencia 10: venta LIMIT pendiente sin respaldo` });
    expect(r.ledger.filter((p) => p.userid === u)).toHaveLength(1);
    expect(r.unbacked).toContain(legacy);
    expect(r.unbacked).not.toContain(legit.order_id);
    expect(r.log).toContain(`  historia: usuario ${u} — orden ${legacy} cancelada: LIMIT pendiente sin respaldo (cancel_reason UNBACKED)`);

    expect(positionOf((await get(`/portfolio/${u}`)).body, inst))
      .toMatchObject({ qty: '10', acciones_reservadas: '10', acciones_disponibles: '0' });
    expect(await orderRow(legit.order_id)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
    const o = await get(`/orders/${legacy}?userid=${u}`);
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ id: legacy, status: 'CANCELLED', cancel_reason: 'UNBACKED', balance_seq: null });
    const c = await fetch(`${base}/orders/${legacy}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userid: u }) });
    expect(c.status).toBe(409);
    expect(((await c.json()) as { order: Record<string, unknown> }).order).toEqual(o.body);
    // Una segunda verificación no encuentra nada que señalar para este usuario.
    expect((await verify()).ledger.filter((p) => p.userid === u)).toEqual([]);
  });

  it('5. BUY LIMIT NEW heredada con más cash reservado que cash: la verificación la cancela y libera la reserva', async () => {
    const u = await legacyUser('unb-cash', 10_000n);
    const legit = await placeOrder(pool, { userid: u, key: 'b', side: 'BUY', type: 'LIMIT', instrumentid: inst, size: 1, limit: '50.00' });
    expect(legit.body.status).toBe('NEW');
    const legacy = await legacyNew(u, 'BUY', 1, '100.00');
    expect((await get(`/portfolio/${u}`)).body.cash).toEqual({ neto: '100.00', reservado: '150.00', disponible: '-50.00' });
    const r = await verify();
    expect(r.ledger).toContainEqual({ userid: u, problem: 'reserva', detail: 'cash reservado 15000 > cash 10000 (centavos): compra LIMIT pendiente sin respaldo' });
    expect(r.unbacked).toContain(legacy);
    expect(r.unbacked).not.toContain(legit.order_id);
    expect((await get(`/portfolio/${u}`)).body.cash).toEqual({ neto: '100.00', reservado: '50.00', disponible: '50.00' });
    expect(await orderRow(legacy)).toEqual(UNBACKED);
  });

  it('cash heredado negativo sin compras NEW: no hay reserva de cash que señalar (una SELL NEW con respaldo sigue NEW)', async () => {
    const u = await legacyUser('unb-neg', 10_000n, 10n);
    await admin.query(
      `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
       VALUES ($1, $2, 1, 1000.00, 'MARKET', 'BUY', 'FILLED', timezone('UTC', now()), 3)`, [inst, u]);
    expect(await cash(u)).toBe(-90_000n);
    const sell = await legacyNew(u, 'SELL', 11, '2000.00');
    const r = await verify();
    expect(r.ledger.filter((p) => p.userid === u)).toEqual([]);
    expect(r.unbacked).not.toContain(sell);
    expect(await orderRow(sell)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
  });

  it('1.000 BUY LIMIT NEW heredadas de 1 @ 10¹⁵ que reservan 10²⁰ centavos (más que numeric(20,0)): la verificación lo señala con el número exacto y las cancela; el otro usuario sigue igual', async () => {
    const u = await legacyUser('unb-huge', 10_000n);
    // Cada una en el tope de D-14 (issue #41): la reserva grande sale de la suma, no de una orden.
    const ids = (await admin.query<{ id: string }>(
      `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
       SELECT $1, $2, 1, 1000000000000000.00, 'LIMIT', 'BUY', 'NEW', timezone('UTC', now()) FROM generate_series(1, 1000)
       RETURNING id::text`, [inst, u])).rows.map((x) => x.id);
    const other = await legacyUser('unb-huge-ok', 10_000n);
    const ok = await legacyNew(other, 'BUY', 1, '50.00');
    const r = await verify();   // no lanza: el bootstrap sigue
    expect(r.ledger.filter((p) => p.userid === u)).toEqual([
      { userid: u, problem: 'reserva', detail: 'cash reservado 100000000000000000000 > cash 10000 (centavos): compra LIMIT pendiente sin respaldo' }]);
    expect(r.unbacked).toEqual(expect.arrayContaining(ids));
    for (const id of [ids[0], ids[999]]) expect(await orderRow(id)).toEqual(UNBACKED);
    expect(r.ledger.filter((p) => p.userid === other)).toEqual([]);
    expect(await orderRow(ok)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
  });

  // Issue #41: una NEW por encima del tope de D-14 se señala con 'tope' y se cancela con LIMIT,
  // antes que las sin respaldo: no cuenta en 'reserva', aunque tampoco tenga respaldo.
  it('BUY LIMIT NEW heredada de 1.000 @ 10¹⁵ (importe 10¹⁸, sin respaldo): la verificación la señala con tope, no con reserva, y la cancela con LIMIT', async () => {
    const u = await legacyUser('unb-tope', 10_000n);
    const id = await legacyNew(u, 'BUY', 1000, '1000000000000000.00');
    const ok = await legacyNew(u, 'BUY', 1, '50.00');
    const r = await verify();
    expect(r.ledger.filter((p) => p.userid === u)).toEqual([
      { userid: u, problem: 'tope', detail: `orden ${id} pendiente con importe 1000000000000000000.00 ARS > 10^15 ARS: no se ejecuta (D-14)` }]);
    expect(r.overCap).toEqual([id]);
    expect(r.unbacked).not.toContain(id);
    expect(r.log).toContain(`  historia: usuario ${u} — orden ${id} cancelada: importe por encima de 10^15 ARS (cancel_reason LIMIT)`);
    expect(await orderRow(id)).toEqual({ status: 'CANCELLED', cancel_reason: 'LIMIT', balance_seq: null });
    expect(await orderRow(ok)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
    expect((await verify()).ledger.filter((p) => p.userid === u)).toEqual([]);
  });

  // Una base heredada puede tener usuarios cuya única orden es una NEW: la verificación los recorre
  // aunque no tengan ninguna FILLED.
  it('usuario sin ninguna orden FILLED, con una SELL NEW sin acciones y una BUY NEW sobre ARS: se señalan y se cancelan las dos', async () => {
    const u = await newUser('unb-only-new');
    const sell = await legacyNew(u, 'SELL', 10, '900.00');
    const buy = await legacyNew(u, 'BUY', 1, '10.00', ars);
    expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.orders WHERE userid = $1 AND status = 'FILLED'", [u])).rows[0].n).toBe(0);
    const r = await verify();
    expect(r.ledger.filter((p) => p.userid === u)).toEqual([
      { userid: u, problem: 'reserva', detail: 'cash reservado 1000 > cash 0 (centavos): compra LIMIT pendiente sin respaldo' },
      { userid: u, problem: 'reserva', detail: `instrumento ${inst}: 10 acciones reservadas > tenencia 0: venta LIMIT pendiente sin respaldo` },
      { userid: u, problem: 'reserva', detail: `orden ${buy} pendiente sobre la moneda ARS: BUY/SELL no aplica sobre una moneda` },
    ]);
    expect(r.unbacked).toEqual(expect.arrayContaining([sell, buy]));
    expect(await orderRow(sell)).toEqual(UNBACKED);
    expect(await orderRow(buy)).toEqual(UNBACKED);
  });

  it('6. BUY LIMIT NEW heredada sobre ARS → la verificación la cancela; el executor no la lista en errors en ninguna corrida', async () => {
    const u = await legacyUser('unb-ars', 100_000n);
    const id = await legacyNew(u, 'BUY', 1, '10.00', ars);   // con cash de sobra: el problema es el instrumento
    const before = await executeLimits({ max: 1_000_000 });
    expect(before.errors.map((e) => e.order_id)).not.toContain(id);
    expect(before.executed).not.toContain(id);
    const r = await verify();
    expect(r.ledger).toContainEqual({ userid: u, problem: 'reserva', detail: `orden ${id} pendiente sobre la moneda ARS: BUY/SELL no aplica sobre una moneda` });
    expect(r.unbacked).toContain(id);
    expect(await orderRow(id)).toEqual(UNBACKED);
    expect(await cash(u)).toBe(100_000n);
    const after = await executeLimits({ max: 1_000_000 });
    expect(listed(after)).not.toContain(id);
    expect((await verify()).ledger.filter((p) => p.userid === u)).toEqual([]);
  });

  const cancelUnbacked = async (u: number) =>
    (await admin.query<{ order_id: string }>('SELECT order_id::text FROM app.cancel_unbacked($1)', [u])).rows.map((r) => r.order_id);

  it('cancel_unbacked conserva por id lo que el executor ejecutaría: tenencia 10 y dos SELL NEW de 10 → cancela la segunda; lo reservado vuelve a caber', async () => {
    const u = await legacyUser('unb-oldest', 0n, 10n);
    const first = await legacyNew(u, 'SELL', 10, '5000.00');
    const second = await legacyNew(u, 'SELL', 10, '5000.00');
    expect(await cancelUnbacked(u)).toEqual([second]);
    expect(await orderRow(first)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
    expect(await orderRow(second)).toEqual(UNBACKED);
    expect(await reserved(u)).toEqual({ cash: '0', shares: '10' });
  });

  it('cancel_unbacked: una SELL de 100 sin respaldo y después una de 10 con respaldo sobre 10 acciones → cancela la primera, conserva la segunda', async () => {
    const u = await legacyUser('unb-first-bad', 0n, 10n);
    const big = await legacyNew(u, 'SELL', 100, '5000.00');
    const small = await legacyNew(u, 'SELL', 10, '5000.00');
    expect(await cancelUnbacked(u)).toEqual([big]);
    expect(await orderRow(big)).toEqual(UNBACKED);
    expect(await orderRow(small)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
    expect(await reserved(u)).toEqual({ cash: '0', shares: '10' });
    expect(await cancelUnbacked(u)).toEqual([]);
  });
});

// Dos conexiones reales y el lock del usuario como barrera (nunca setTimeout para coordinar).
describe('4. concurrencia: bootstrap y executor sobre la misma NEW sin respaldo', () => {
  const userLock = "SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)";

  /** Espera hasta que la sesión `pid` esté bloqueada en un advisory lock. */
  async function waitingOnLock(pid: number, failed: () => unknown): Promise<void> {
    for (;;) {
      const err = failed();
      if (err) throw err;
      const w = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'", [pid]);
      if (w.rowCount) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  const pidOf = async (c: pg.Client | pg.PoolClient) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

  it('cancelación del bootstrap y ejecución del executor esperando el mismo lock → exactamente una transición, nunca FILLED', async () => {
    const u = await legacyUser('unb-race', 100n);
    const id = await legacyNew(u, 'SELL', 10, '900.00');
    const holder = await apiClient();
    const boot = await admin.connect();     // el bootstrap corre como administrador
    const exec = await apiClient();
    let results: [string[], string];
    try {
      const [bootPid, execPid] = [await pidOf(boot), await pidOf(exec)];   // antes de que queden bloqueadas
      await holder.query('BEGIN');
      await holder.query(userLock, [u]);
      let failed: unknown = null;
      const cancel = boot.query<{ order_id: string }>('SELECT order_id::text FROM app.cancel_unbacked($1)', [u])
        .catch((e) => { failed = e; throw e; });
      const execute = exec.query<{ r: string }>('SELECT app.execute_limit_outcome($1) AS r', [Number(id)])
        .catch((e) => { failed = e; throw e; });
      await waitingOnLock(bootPid, () => failed);
      await waitingOnLock(execPid, () => failed);
      await holder.query('COMMIT');
      results = [(await cancel).rows.map((r) => r.order_id), (await execute).rows[0].r];
    } finally { await holder.end(); boot.release(); await exec.end(); }
    // El que entra primero cancela; el otro la encuentra CANCELLED y no hace nada.
    expect([[[id], 'SKIPPED'], [[], 'UNBACKED']]).toContainEqual(results);
    expect(await orderRow(id)).toEqual(UNBACKED);
    expect(await position(u)).toBeNull();
    expect(await cash(u)).toBe(100n);
  });

  it('un crédito confirmado mientras la cancelación espera el lock la respalda → cancel_unbacked no la cancela y el executor la ejecuta', async () => {
    const u = await legacyUser('unb-credit', 100n);
    const id = await legacyNew(u, 'BUY', 10, '1000.00');   // cruza; importe 10.000,00 con 1,00 de cash
    const holder = await apiClient();
    const boot = await admin.connect();
    try {
      const bootPid = await pidOf(boot);
      await holder.query('BEGIN');
      await holder.query(userLock, [u]);
      let failed: unknown = null;
      const cancel = boot.query<{ order_id: string }>('SELECT order_id::text FROM app.cancel_unbacked($1)', [u])
        .catch((e) => { failed = e; throw e; });
      await waitingOnLock(bootPid, () => failed);
      const credit = await placeOrder(holder, { userid: u, key: 'cr', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '10000.00' });
      expect(credit.body.status).toBe('FILLED');
      await holder.query('COMMIT');
      expect((await cancel).rows).toEqual([]);   // decidió bajo el lock, con el crédito
    } finally { await holder.end(); boot.release(); }
    expect(await orderRow(id)).toEqual({ status: 'NEW', cancel_reason: null, balance_seq: null });
    expect(await run('execute_limit_outcome', id)).toBe('FILLED');
    expect(await position(u)).toBe('10');
    expect(await cash(u)).toBe(100n);
  });
});
