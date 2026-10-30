// Test funcional de "enviar una orden" (lo que pide el enunciado), de punta a punta: HTTP →
// Express → app.place_order → Postgres real. Cada bloque crea su usuario.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { SEARCH_SQL } from '../../src/repositories/instruments.repo.js';
import { admin, arsId, cents, fmt, newUser, placeOrder as placeOrderDb, quotes, type Quote } from '../support/db.js';
import { requestHash } from '../../src/domain/orders.js';

let server: Server;
let base: string;
let q: Quote;

const key = () => `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, body: (await r.json()) as Record<string, any> };
}
const order = (body: unknown, k = key()) => post('/orders', body, { 'Idempotency-Key': k });
async function get(path: string) {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const portfolio = (u: number) => get(`/portfolio/${u}`);

beforeAll(async () => {
  [q] = await quotes(1);
  server = createApp({ internalToken: 'test-token', release: 'test-release' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
  await admin.end();
});

describe('POST /orders — forma del request, antes de la base', () => {
  it('sin Idempotency-Key → 400', async () => {
    expect((await post('/orders', { userid: 1, side: 'CASH_IN', amount: '1' })).status).toBe(400);
  });
  it('JSON inválido → 400', async () => {
    const r = await fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key() }, body: '{' });
    expect(r.status).toBe(400);
  });
  it('MARKET con price → 400', async () => {
    expect((await order({ userid: 1, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 1, price: '10' })).status).toBe(400);
  });
  it('size y amount a la vez → 400', async () => {
    expect((await order({ userid: 1, side: 'BUY', instrumentid: q.instrumentid, size: 1, amount: '10' })).status).toBe(400);
  });
  // Issue #28: la base también los rechaza (APP02 → 400); sin consultas se prueba que corta la API.
  it('LIMIT sin price → 400 sin consultar la base', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      const r = await order({ userid: 1, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1 });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'BAD_REQUEST', message: 'una orden LIMIT requiere price' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('LIMIT con price ≤ 0 → 400 sin consultar la base', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      for (const price of ['0', '0.00', '-1.00', 0]) {
        const r = await order({ userid: 1, side: 'SELL', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price });
        expect(r.status, String(price)).toBe(400);
        expect(r.body.error, String(price)).toBe('BAD_REQUEST');
        expect(r.body.message, String(price)).toMatch(/^price: /);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('usuario inexistente → 400 desde la base', async () => {
    const r = await order({ userid: 2_000_000_000, side: 'CASH_IN', amount: '1' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/inexistente/);
  });
});

describe('POST /orders — con la base', () => {
  let u: number;
  beforeAll(async () => { u = await newUser('orders'); });

  it('usuario sin órdenes: portfolio vacío', async () => {
    const r = await portfolio(u);
    expect(r.status).toBe(200);
    expect(r.body.cash).toEqual({ neto: '0.00', reservado: '0.00', disponible: '0.00' });
    expect(r.body.positions).toEqual([]);
  });

  it('CASH_IN 100,50 → FILLED en centavos; el replay devuelve lo mismo sin otra orden; otro body con la misma clave → 422', async () => {
    const k = key();
    const a = await order({ userid: u, side: 'CASH_IN', amount: '100.50' }, k);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: 'FILLED', size: '10050', price: '0.01', amount: '100.50', balance_seq: '1', instrumentid: String(await arsId()) });
    expect(a.headers.get('idempotent-replay')).toBe('false');
    expect(a.headers.get('location')).toBe(`/orders/${a.body.id}?userid=${u}`);
    const followed = await get(a.headers.get('location')!);   // el Location se puede seguir tal cual
    expect(followed.status).toBe(200);
    expect(followed.body).toEqual(a.body);

    const b = await order({ side: 'CASH_IN', amount: '100.50', userid: u }, k);   // mismas claves, otro orden
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect(b.headers.get('location')).toBe(a.headers.get('location'));   // el replay también da un Location que se puede seguir
    const followedReplay = await get(b.headers.get('location')!);
    expect(followedReplay.status).toBe(200);
    expect(followedReplay.body).toEqual(a.body);

    const c = await order({ userid: u, side: 'CASH_IN', amount: '100.51' }, k);
    expect(c.status).toBe(422);
    expect(c.body.error).toBe('IDEMPOTENCY_MISMATCH');

    const n = await admin.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u]);
    expect(n.rows[0].n).toBe(1);
    expect((await portfolio(u)).body.cash.neto).toBe('100.50');
  });

  it('el mismo monto en otra escala con la misma clave es un replay: amount 100 y después "100.00" → una sola orden (issue #4)', async () => {
    const v = await newUser('scale');
    const k = key();
    const a = await order({ userid: v, side: 'CASH_IN', amount: 100 }, k);
    expect(a.status).toBe(201);
    expect(a.headers.get('idempotent-replay')).toBe('false');

    const b = await order({ userid: v, side: 'CASH_IN', amount: '100.00' }, k);
    expect(b.status).toBe(201);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect(b.body).toEqual(a.body);

    expect((await order({ userid: v, side: 'CASH_IN', amount: '100.001' }, k)).status).toBe(400);   // la escala de más se sigue rechazando
    const n = await admin.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [v]);
    expect(n.rows[0].n).toBe(1);
    expect((await portfolio(v)).body.cash.neto).toBe('100.00');
  });

  it('una clave grabada antes del despliegue (hash de amount "100" sin canonizar) sigue dando replay al mismo request (issue #4)', async () => {
    const v = await newUser('legacy-hash');
    const k = key();
    // Lo que grababa la versión anterior: el hash del body validado con amount tal como llegó.
    const legacyHash = requestHash({ userid: v, side: 'CASH_IN', type: 'MARKET', amount: '100' });
    const first = await placeOrderDb(pool, { userid: v, key: k, hash: legacyHash, side: 'CASH_IN', type: 'MARKET', instrumentid: await arsId(), amount: '100' });
    expect(first.status).toBe(201);

    for (const amount of [100, '100']) {   // el mismo request que antes, como number y como string
      const r = await order({ userid: v, side: 'CASH_IN', amount }, k);
      expect(r.status).toBe(201);
      expect(r.headers.get('idempotent-replay')).toBe('true');
      expect(r.body).toEqual(first.body);
    }
    const other = await order({ userid: v, side: 'CASH_IN', amount: '100.01' }, k);   // otro monto: sigue siendo conflicto
    expect(other.status).toBe(422);
    expect(other.body.error).toBe('IDEMPOTENCY_MISMATCH');

    const n = await admin.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [v]);
    expect(n.rows[0].n).toBe(1);
    expect((await portfolio(v)).body.cash.neto).toBe('100.00');
  });

  // Issue #4 de este repositorio (plan de pruebas, punto 8): el vencimiento lo decide place_order,
  // así que el resultado no depende de si la limpieza llegó antes o después del request.
  it('transición: una clave legada vencida da lo mismo con la limpieza en cola detrás del request o delante: 201 nueva, replay false, hash canónico, una fila', async () => {
    const lockSql = "SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)";
    const waiting = async (v: number, n: number) => {
      for (let i = 0; i < 10_000; i++) {
        const r = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = $1::oid AND objsubid = 2", [v]);
        if (r.rows[0].n === n) return;
      }
      throw new Error(`no hay ${n} esperando el lock del usuario ${v}`);
    };
    for (const cleanupFirst of [false, true]) {
      const v = await newUser('legacy-cleanup');
      const k = key();
      const legacyHash = requestHash({ userid: v, side: 'CASH_IN', type: 'MARKET', amount: '100' });
      const canonicalHash = requestHash({ userid: v, side: 'CASH_IN', type: 'MARKET', amount: '100.00' });
      const first = await placeOrderDb(pool, { userid: v, key: k, hash: legacyHash, side: 'CASH_IN', type: 'MARKET', instrumentid: await arsId(), amount: '100' });
      await admin.query("UPDATE app.idempotency_keys SET created_at = now() - interval '25 hours' WHERE userid = $1 AND key = $2", [v, k]);   // vencida

      // Barreras con locks: A tiene el lock del usuario; el request y C (la limpieza real, bajo el lock de
      // usuario para que haga cola en vez de saltearlo con el try-lock) se encolan en el orden del caso.
      const a = await admin.connect();
      const c = await admin.connect();
      let r: Awaited<ReturnType<typeof order>>;
      let deleted: number;
      try {
        await a.query('BEGIN');
        await a.query(lockSql, [v]);
        const cleanup = async () => {
          await c.query('BEGIN');
          await c.query(lockSql, [v]);
          const n = (await c.query<{ n: number }>('SELECT app.cleanup_idempotency($1) AS n', [v])).rows[0].n;
          await c.query('COMMIT');
          return n;
        };
        let pending: ReturnType<typeof order>;
        let cleaning: Promise<number>;
        if (cleanupFirst) {
          cleaning = cleanup();
          await waiting(v, 1);
          pending = order({ userid: v, side: 'CASH_IN', amount: 100 }, k);
        } else {
          pending = order({ userid: v, side: 'CASH_IN', amount: 100 }, k);
          await waiting(v, 1);
          cleaning = cleanup();
        }
        await waiting(v, 2);
        await a.query('COMMIT');
        r = await pending;
        deleted = await cleaning;
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        await c.query('ROLLBACK').catch(() => undefined);
        a.release();
        c.release();
      }
      const label = cleanupFirst ? 'limpieza primero' : 'request primero';
      expect(r.status, label).toBe(201);
      expect(r.headers.get('idempotent-replay'), label).toBe('false');
      expect(r.body.id, label).not.toBe(first.body.id);
      // La limpieza borró la clave solo si llegó primero; detrás del request, ya estaba renovada y no toca nada.
      expect(deleted, label).toBe(cleanupFirst ? 1 : 0);

      // Una sola fila, con el hash canonizado y la orden nueva; dos órdenes; ninguna clave con el hash anterior.
      const stored = await admin.query('SELECT request_hash, order_id::text FROM app.idempotency_keys WHERE userid = $1', [v]);
      expect(stored.rows, label).toEqual([{ request_hash: canonicalHash, order_id: r.body.id }]);
      expect((await admin.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [v])).rows[0].n, label).toBe(2);
      // El reintento con "100.00" es replay de la orden nueva.
      const retry = await order({ userid: v, side: 'CASH_IN', amount: '100.00' }, k);
      expect(retry.headers.get('idempotent-replay'), label).toBe('true');
      expect(retry.body, label).toEqual(r.body);
    }
  });

  it('BUY MARKET por monto: size = floor(monto / close) y el cash baja exactamente size × close', async () => {
    await order({ userid: u, side: 'CASH_IN', amount: '100000.00' });
    const before = await portfolio(u);
    const r = await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, amount: '10000.00' });
    expect(r.status).toBe(201);
    const size = 1_000_000n / q.closeCents;
    expect(r.body).toMatchObject({ status: 'FILLED', size: size.toString(), price: fmt(q.closeCents) });

    const after = await portfolio(u);
    expect(cents(before.body.cash.neto) - cents(after.body.cash.neto)).toBe(size * q.closeCents);
    const p = after.body.positions.find((x: any) => x.instrumentid === q.instrumentid);
    expect(p).toMatchObject({ qty: size.toString(), rendimiento_pct: '0.00', resultado: '0.00' });   // comprado al close vigente
  });

  it('monto que no alcanza para una acción → 400, sin orden', async () => {
    const r = await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, amount: fmt(q.closeCents - 1n) });
    expect(r.status).toBe(400);
  });

  it('BUY por más de lo disponible → 201 REJECTED, persistida, sin secuencia', async () => {
    const r = await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 1_000_000 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'REJECTED', balance_seq: null });
    expect((await get(`/orders/${r.body.id}?userid=${u}`)).body.status).toBe('REJECTED');
  });

  it('SELL por más acciones de las que tiene → REJECTED', async () => {
    const r = await order({ userid: u, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size: 1_000_000 });
    expect(r.body.status).toBe('REJECTED');
  });

  it('BUY LIMIT queda NEW y reserva cash; CASH_OUT del disponible → FILLED; un centavo más → REJECTED', async () => {
    const p0 = await portfolio(u);
    const lim = await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '1.00' });
    expect(lim.body).toMatchObject({ status: 'NEW', price: '1.00', balance_seq: null });
    const p1 = await portfolio(u);
    expect(p1.body.cash.reservado).toBe(fmt(cents(p0.body.cash.reservado) + 100n));
    expect(cents(p1.body.cash.disponible)).toBe(cents(p0.body.cash.disponible) - 100n);

    expect((await order({ userid: u, side: 'CASH_OUT', amount: p1.body.cash.disponible })).body.status).toBe('FILLED');
    expect((await order({ userid: u, side: 'CASH_OUT', amount: '0.01' })).body.status).toBe('REJECTED');
    expect((await portfolio(u)).body.cash.disponible).toBe('0.00');
  });

  it('SELL LIMIT reserva acciones: no se pueden volver a vender', async () => {
    const p = (await portfolio(u)).body.positions.find((x: any) => x.instrumentid === q.instrumentid);
    const qty = Number(p.qty);
    const lim = await order({ userid: u, side: 'SELL', type: 'LIMIT', instrumentid: q.instrumentid, size: qty, price: fmt(q.closeCents * 10n) });
    expect(lim.body.status).toBe('NEW');
    const after = (await portfolio(u)).body.positions.find((x: any) => x.instrumentid === q.instrumentid);
    expect(after).toMatchObject({ acciones_reservadas: String(qty), acciones_disponibles: '0' });
    expect((await order({ userid: u, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size: 1 })).body.status).toBe('REJECTED');
  });

  it('BUY/SELL sobre ARS → 400: la moneda no se opera como activo', async () => {
    const ars = await arsId();
    for (const side of ['BUY', 'SELL']) {
      const r = await order({ userid: u, side, type: 'MARKET', instrumentid: ars, size: 1 });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/moneda/);
    }
  });

  it('el cash nunca aparece como posición', async () => {
    const ars = await arsId();
    const r = await portfolio(u);
    expect(r.body.positions.some((p: any) => p.instrumentid === ars || p.ticker === 'ARS')).toBe(false);
  });

  it('el rol de la API no puede escribir orders directamente (D-17)', async () => {
    await expect(pool.query("UPDATE app.orders SET status = 'CANCELLED' WHERE userid = $1", [u])).rejects.toMatchObject({ code: '42501' });
    // Issue #21: la columna nueva no abre una escritura; el motivo solo lo escriben las funciones.
    await expect(pool.query("UPDATE app.orders SET cancel_reason = 'USER' WHERE userid = $1", [u])).rejects.toMatchObject({ code: '42501' });
    const privs = (await admin.query(
      `SELECT has_table_privilege('api', 'app.orders', 'INSERT') AS ins, has_table_privilege('api', 'app.orders', 'UPDATE') AS upd,
              has_table_privilege('api', 'app.orders', 'DELETE') AS del,
              has_any_column_privilege('api', 'app.orders', 'INSERT') AS col_ins, has_any_column_privilege('api', 'app.orders', 'UPDATE') AS col_upd,
              has_column_privilege('api', 'app.orders', 'cancel_reason', 'SELECT') AS read_reason`)).rows[0];
    expect(privs).toEqual({ ins: false, upd: false, del: false, col_ins: false, col_upd: false, read_reason: true });
    await expect(pool.query('INSERT INTO app.idempotency_keys (userid, key, request_hash) VALUES ($1, $2, $3)', [u, 'x', 'y']))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('el rol de la API no lee app.users: el usuario lo resuelve app.read_portfolio (issue #18)', async () => {
    await expect(pool.query('SELECT 1 FROM app.users')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT 1 FROM app.users WHERE id = $1', [u])).rejects.toMatchObject({ code: '42501' });
  });
});

// Issue #28: compra y venta MARKET por HTTP, con el cash y la posición verificados en el portfolio.
describe('POST /orders — BUY y SELL MARKET por HTTP', () => {
  const position = (p: Record<string, any>) => p.positions.find((x: any) => x.instrumentid === q.instrumentid);
  /** Usuario nuevo con `cash` centavos depositados y `shares` acciones compradas al close. */
  async function funded(tag: string, cash: bigint, shares = 0) {
    const u = await newUser(tag);
    expect((await order({ userid: u, side: 'CASH_IN', amount: fmt(cash) })).body.status).toBe('FILLED');
    if (shares > 0) {
      expect((await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: shares })).body.status).toBe('FILLED');
    }
    return u;
  }

  it('BUY MARKET por size: FILLED al close por exactamente esa cantidad, el cash baja size × close y la posición nueva aparece', async () => {
    const u = await funded('buy-size', q.closeCents * 10n);
    const r = await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 3 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      side: 'BUY', type: 'MARKET', instrumentid: String(q.instrumentid),
      status: 'FILLED', size: '3', price: fmt(q.closeCents), amount: fmt(q.closeCents * 3n),
    });
    const p = (await portfolio(u)).body;
    expect(p.cash.neto).toBe(fmt(q.closeCents * 7n));
    expect(position(p)).toMatchObject({ qty: '3', acciones_disponibles: '3', costo_total: `${fmt(q.closeCents * 3n)}0000` });
  });

  it('SELL MARKET por size: FILLED al close, el cash sube exactamente size × close y la posición baja en size', async () => {
    const u = await funded('sell-size', q.closeCents * 5n, 5);
    const before = (await portfolio(u)).body;
    expect(position(before).qty).toBe('5');
    const r = await order({ userid: u, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size: 2 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      side: 'SELL', type: 'MARKET', status: 'FILLED', size: '2', price: fmt(q.closeCents), amount: fmt(q.closeCents * 2n),
    });
    const after = (await portfolio(u)).body;
    expect(cents(after.cash.neto) - cents(before.cash.neto)).toBe(2n * q.closeCents);
    expect(position(after)).toMatchObject({ qty: '3', acciones_disponibles: '3' });
  });

  it('SELL MARKET por amount: size = floor(amount / close), no redondeado; el cash sube size × close, no el monto pedido', async () => {
    const u = await funded('sell-amount', q.closeCents * 5n, 5);
    const before = (await portfolio(u)).body;
    // 2 acciones y casi una tercera: floor da 2, el redondeo daría 3.
    const amount = fmt(q.closeCents * 3n - 1n);
    const r = await order({ userid: u, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, amount });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ side: 'SELL', status: 'FILLED', size: '2', price: fmt(q.closeCents), amount: fmt(q.closeCents * 2n) });
    const after = (await portfolio(u)).body;
    expect(cents(after.cash.neto) - cents(before.cash.neto)).toBe(2n * q.closeCents);
    expect(position(after)).toMatchObject({ qty: '3' });
  });

  it('SELL por un amount que no alcanza para una acción → 400, sin orden', async () => {
    const u = await funded('sell-amount-short', q.closeCents, 1);
    const r = await order({ userid: u, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, amount: fmt(q.closeCents - 1n) });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/no alcanza para una acción/);
    expect((await admin.query("SELECT count(*)::int AS n FROM app.orders WHERE userid = $1 AND side = 'SELL'", [u])).rows[0].n).toBe(0);
    expect(position((await portfolio(u)).body).qty).toBe('1');
  });

  it('instrumento inexistente → 400 BAD_REQUEST, sin orden ni clave: la misma clave sirve después para otra orden', async () => {
    const u = await funded('no-instrument', q.closeCents);
    const k = key();
    const before = (await portfolio(u)).body;
    for (const side of ['BUY', 'SELL']) {
      const r = await order({ userid: u, side, type: 'MARKET', instrumentid: 2_000_000_000, size: 1 }, k);
      expect(r.status, side).toBe(400);
      expect(r.body, side).toEqual({ error: 'BAD_REQUEST', message: 'instrumento 2000000000 inexistente' });
    }
    expect((await admin.query("SELECT count(*)::int AS n FROM app.orders WHERE userid = $1 AND side <> 'CASH_IN'", [u])).rows[0].n).toBe(0);
    expect((await admin.query('SELECT count(*)::int AS n FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, k])).rows[0].n).toBe(0);
    expect((await portfolio(u)).body).toEqual(before);
    const reused = await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 1 }, k);
    expect(reused.status).toBe(201);
    expect(reused.headers.get('idempotent-replay')).toBe('false');
  });
});

// Issue #8: un entero JSON fuera de ±2⁵³ llega redondeado desde JSON.parse; se rechaza como número y
// se acepta exacto como string. Los ids del body tienen el tope de int4, como parseId: antes llegaban
// a Postgres y respondían 500 (22003).
describe('POST /orders — enteros JSON fuera de ±2⁵³ y topes de los ids (issue #8)', () => {
  const RANGE = 'entero fuera del rango exacto de JSON (±2^53); enviarlo como string';
  /** Usuario con `shares` acciones del instrumento de prueba, compradas al close. */
  async function holder(tag: string, shares: number) {
    const u = await newUser(tag);
    expect((await order({ userid: u, side: 'CASH_IN', amount: fmt(q.closeCents * BigInt(shares)) })).body.status).toBe('FILLED');
    expect((await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: shares })).body.status).toBe('FILLED');
    return u;
  }
  const sellLimit = (userid: number, price: unknown, k = key()) =>
    order({ userid, side: 'SELL', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price }, k);
  /** El request no llega a la base: 400 BAD_REQUEST con `message`, y ni un pool.query. */
  async function rejected(req: () => Promise<Awaited<ReturnType<typeof post>>>, message: string | RegExp) {
    const spy = vi.spyOn(pool, 'query');
    try {
      const r = await req();
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('BAD_REQUEST');
      expect(r.body.message).toMatch(message);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }

  it('price 9007199254740993 y amount 12345678901234567890 como número → 400 con el mensaje de rango, sin tocar la base', async () => {
    await rejected(() => sellLimit(1, 9007199254740993), `price: ${RANGE}`);
    await rejected(() => order({ userid: 1, side: 'CASH_IN', amount: 12345678901234567890 }), `amount: ${RANGE}`);
  });

  // Como string llega exacto a place_order, que decide el tope por orden de D-14 (importe ≤ 10¹⁵ ARS):
  // 9007199254740993 lo supera (422 LIMIT, no 400 de rango). La exactitud se ve debajo del tope, con
  // 17 dígitos que Number redondea hacia abajo (999999999999999.93 → 999999999999999.875, "999999999999999.9"):
  // convertido, el monto ya no alcanza para una acción a ese precio y el precio grabado sería otro.
  it('price "9007199254740993" como string → llega exacto a place_order (422 LIMIT, no 400); "999999999999999.93" → 201 exacto', async () => {
    const u = await holder('big-string', 1);
    const over = await sellLimit(u, '9007199254740993');
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('LIMIT');
    const r = await sellLimit(u, '999999999999999.93');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'NEW', size: '1', price: '999999999999999.93', amount: '999999999999999.93' });
    expect((await get(r.headers.get('location')!)).body).toEqual(r.body);
  });

  it('price 9007199254740991 (2⁵³ − 1) pasa la validación (422 LIMIT del tope, no 400); 9007199254740992 (2⁵³) → 400; 999999999999999 → 201 exacto', async () => {
    const u = await holder('safe-max', 1);
    const atMax = await sellLimit(u, 9007199254740991);
    expect(atMax.status).toBe(422);
    expect(atMax.body.error).toBe('LIMIT');
    await rejected(() => sellLimit(u, 9007199254740992), `price: ${RANGE}`);
    const r = await sellLimit(u, 999999999999999);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'NEW', price: '999999999999999.00' });
  });

  it('userid 2147483648 en POST /orders y en el cancel, e instrumentid 2147483648 → 400 en español sin tocar la base', async () => {
    await rejected(() => order({ userid: 2_147_483_648, side: 'CASH_IN', amount: '1' }), /^userid: debe ser ≤ 2147483647$/);
    await rejected(() => post('/orders/1/cancel', { userid: 2_147_483_648 }), /^userid: debe ser ≤ 2147483647$/);
    await rejected(() => order({ userid: 1, side: 'BUY', type: 'MARKET', instrumentid: 2_147_483_648, size: 1 }), /^instrumentid: debe ser ≤ 2147483647$/);
  });

  // JSON.stringify escribe 1e3 como 1000 y 1e21 como 1e+21: ese literal con exponente lo rechaza el
  // reviver antes que la regla de rango (issue #42).
  it('price 1e3 → 201 con "1000.00"; price 1e21 → 400 por el exponente del literal, antes del rango', async () => {
    const u = await holder('exp', 1);
    const r = await sellLimit(u, 1e3);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'NEW', price: '1000.00' });
    await rejected(() => sellLimit(u, 1e21), /^price: número JSON con punto decimal o exponente/);
  });

  it('size 1e9 → 201 (REJECTED por falta de cash, pero la orden se grabó); size 1e10 → 400 por el tope, no 22003', async () => {
    const u = await newUser('size-exp');
    const r = await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 1e9 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'REJECTED', size: '1000000000' });
    await rejected(() => order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 1e10 }), /^size: debe ser ≤ 2147483647$/);
  });

  it('idempotencia: price 100 y "100.00", y 999999999999999 y "999999999999999", son el mismo request', async () => {
    const u = await holder('same-hash', 2);
    for (const [asNumber, asString] of [[100, '100.00'], [999999999999999, '999999999999999']] as const) {
      const k = key();
      const first = await sellLimit(u, asNumber, k);
      expect(first.status, String(asNumber)).toBe(201);
      expect(first.headers.get('idempotent-replay')).toBe('false');
      const replay = await sellLimit(u, asString, k);
      expect(replay.status, asString).toBe(201);
      expect(replay.headers.get('idempotent-replay')).toBe('true');
      expect(replay.body).toEqual(first.body);
    }
    expect((await admin.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1 AND side = $2', [u, 'SELL'])).rows[0].n).toBe(2);
  });

  const keysOf = async (u: number, k: string) =>
    (await admin.query('SELECT count(*)::int AS n FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, k])).rows[0].n;
  const ordersOf = async (u: number) =>
    (await admin.query("SELECT count(*)::int AS n FROM app.orders WHERE userid = $1 AND side <> 'CASH_IN'", [u])).rows[0].n;

  // Con Number en el camino, amount llegaría como 999999999999999.9 < price: size 0 → 400 "no alcanza".
  it('amount "999999999999999.93" como string → 201 exacto por HTTP (size = floor(amount / price), sin pasar por Number)', async () => {
    const u = await newUser('big-amount');
    const r = await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, amount: '999999999999999.93', price: '999999999999999.93' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'REJECTED', size: '1', price: '999999999999999.93', amount: '999999999999999.93' });
    expect((await get(r.headers.get('location')!)).body).toEqual(r.body);
  });

  // Ninguna orden puede usar este monto: size ≤ 2³¹ − 1 y size × price ≤ 10¹⁵ (D-14). Llega exacto a
  // place_order, que responde con el motivo; nada queda grabado y la clave sigue libre.
  it('amount "12345678901234567890" como string → llega a place_order: 422 LIMIT a 9007199254740993, 400 por cantidad a 1,00; sin orden ni clave', async () => {
    const u = await newUser('amount-over');
    for (const [price, status, message] of [['9007199254740993', 422, /10\^15 ARS/], ['1.00', 400, /cantidad supera el máximo/]] as const) {
      const k = key();
      const r = await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, amount: '12345678901234567890', price }, k);
      expect(r.status, price).toBe(status);
      expect(r.body.message, price).toMatch(message);
      expect(await keysOf(u, k), price).toBe(0);
    }
    expect(await ordersOf(u)).toBe(0);
  });
});

// Issue #42: un literal con decimales que el double redondea a entero pasaba como ese entero, y la orden
// se grababa por otra cantidad. El body va como texto, sin JSON.stringify, para mandar el literal exacto.
describe('POST /orders — número JSON con decimales que JSON.parse redondea a entero (issue #42)', () => {
  const sendRaw = async (text: string, k = key()) => {
    const r = await fetch(`${base}/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': k }, body: text,
    });
    return { status: r.status, headers: r.headers, body: (await r.json()) as Record<string, any> };
  };
  const ordersOf = async (u: number, side: string) =>
    (await admin.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1 AND side = $2', [u, side])).rows[0].n;
  const keysOf = async (u: number, k: string) =>
    (await admin.query('SELECT count(*)::int AS n FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, k])).rows[0].n;
  /** 400 BAD_REQUEST por el literal de `field`, sin un pool.query, sin orden nueva y con la clave libre. */
  async function rejectedLiteral(u: number, side: string, field: string, text: string) {
    const before = await ordersOf(u, side);
    const spy = vi.spyOn(pool, 'query');
    const k = key();
    try {
      const r = await sendRaw(text, k);
      expect(r.status, text).toBe(400);
      expect(r.body.error, text).toBe('BAD_REQUEST');
      expect(r.body.message, text).toMatch(new RegExp(`^${field}: número JSON con punto decimal o exponente`));
      expect(spy, text).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await keysOf(u, k), text).toBe(0);
    expect(await ordersOf(u, side), text).toBe(before);
  }

  // Con 2 acciones, el número llegaba como 1000000000000000: size 2 en vez de 1, sin error.
  it('SELL LIMIT a "500000000000000.00": amount 999999999999999.99 como número → 400 sin orden ni clave; como string → 201 NEW por 1 acción', async () => {
    const u = await newUser('literal-42');
    expect((await order({ userid: u, side: 'CASH_IN', amount: fmt(q.closeCents * 2n) })).body.status).toBe('FILLED');
    expect((await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 2 })).body.status).toBe('FILLED');
    const sell = (amount: string) =>
      `{"userid":${u},"side":"SELL","type":"LIMIT","instrumentid":${q.instrumentid},"amount":${amount},"price":"500000000000000.00"}`;
    await rejectedLiteral(u, 'SELL', 'amount', sell('999999999999999.99'));
    const r = await sendRaw(sell('"999999999999999.99"'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'NEW', size: '1', price: '500000000000000.00', amount: '500000000000000.00' });
    expect(await ordersOf(u, 'SELL')).toBe(1);
  });

  it('price, size, userid e instrumentid con punto o exponente → 400 sin tocar la base', async () => {
    const u = await newUser('literal-42-fields');
    const iid = q.instrumentid;
    await rejectedLiteral(u, 'SELL', 'price', `{"userid":${u},"side":"SELL","type":"LIMIT","instrumentid":${iid},"size":1,"price":1e2}`);
    await rejectedLiteral(u, 'BUY', 'size', `{"userid":${u},"side":"BUY","instrumentid":${iid},"size":1.0000000000000001}`);
    await rejectedLiteral(u, 'BUY', 'userid', `{"userid":${u}.0,"side":"BUY","instrumentid":${iid},"size":1}`);
    await rejectedLiteral(u, 'BUY', 'instrumentid', `{"userid":${u},"side":"BUY","instrumentid":${iid}e0,"size":1}`);
  });

  // Generativa (semilla fija): montos con 2 decimales entre 10¹³ y 10¹⁵, como BUY LIMIT con amount = price
  // (size 1, REJECTED por falta de cash pero grabada): como número nunca 201; como string, exactos.
  it('generativa: como número → 400 sin orden; como string → la orden lleva exactamente el monto enviado', async () => {
    let a = 4242;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const u = await newUser('literal-42-gen');
    const buy = (amount: string, price: string) =>
      `{"userid":${u},"side":"BUY","type":"LIMIT","instrumentid":${q.instrumentid},"amount":${amount},"price":${price}}`;
    for (let i = 0; i < 25; i++) {
      const lit = `${1e13 + Math.floor(rnd() * (1e15 - 1e13))}.${String(1 + Math.floor(rnd() * 99)).padStart(2, '0')}`;
      await rejectedLiteral(u, 'BUY', 'amount', buy(lit, `"${lit}"`));
      await rejectedLiteral(u, 'BUY', 'price', buy(`"${lit}"`, lit));
      const r = await sendRaw(buy(`"${lit}"`, `"${lit}"`));
      expect(r.status, lit).toBe(201);
      expect(r.body, lit).toMatchObject({ status: 'REJECTED', size: '1', price: lit, amount: lit });
      expect((await get(r.headers.get('location')!)).body, lit).toEqual(r.body);
    }
    expect(await ordersOf(u, 'BUY')).toBe(25);
  });
});

describe('una escritura = una sola llamada a la base', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('POST /orders de cash: un solo pool.query (place_order resuelve ARS adentro)', async () => {
    const u = await newUser('one-call');
    const spy = vi.spyOn(pool, 'query');
    const r = await order({ userid: u, side: 'CASH_IN', amount: '5.00' });
    expect(r.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/app\.place_order/);
  });

  it('place_order con p_instrumentid NULL en cash: la misma orden que con el id de ARS', async () => {
    const u = await newUser('cash-null');
    const ars = await arsId();
    const call = (key: string, instrumentid: number | null, side = 'CASH_IN') => pool.query<{ r: Record<string, any> }>(
      'SELECT app.place_order($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r', [u, key, 'h', side, 'MARKET', instrumentid, null, '2.50', null]);
    const withNull = (await call('null', null)).rows[0].r.body;
    const withId = (await call('id', ars)).rows[0].r.body;
    expect(withNull.instrumentid).toBe(String(ars));
    const sameShape = (b: Record<string, any>) => ({ ...b, id: undefined, datetime: undefined, balance_seq: undefined });
    expect(sameShape(withNull)).toEqual(sameShape(withId));
    expect((await call('out', null, 'CASH_OUT')).rows[0].r.body).toMatchObject({ instrumentid: String(ars), status: 'FILLED' });
    // Solo el cash se resuelve: una compra sin instrumento sigue siendo un argumento inválido.
    await expect(call('buy', null, 'BUY')).rejects.toMatchObject({ code: 'APP02' });
  });

  it('cancel_order_outcome: ok / not_new con la orden, not_found sin datos para una ajena o inexistente', async () => {
    const u = await newUser('outcome');
    const other = await newUser('outcome-other');
    await order({ userid: u, side: 'CASH_IN', amount: '100.00' });
    const lim = (await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '5.00' })).body;
    const call = async (userid: number, id: number | string) =>
      (await pool.query('SELECT * FROM app.cancel_order_outcome($1, $2)', [userid, id])).rows;
    const empty = { id: null, userid: null, instrumentid: null, side: null, type: null, size: null, price: null, status: null, balance_seq: null, datetime: null, cancel_reason: null };
    expect(await call(other, lim.id)).toEqual([{ outcome: 'not_found', ...empty }]);
    expect(await call(u, '2000000000')).toEqual([{ outcome: 'not_found', ...empty }]);
    const [ok] = await call(u, lim.id);
    expect(ok).toMatchObject({ outcome: 'ok', id: Number(lim.id), userid: u, status: 'CANCELLED', price: '5.00', balance_seq: null, cancel_reason: 'USER' });
    expect(await call(u, lim.id)).toEqual([{ ...ok, outcome: 'not_new' }]);
  });

  it('cancelar ajena / inexistente / no NEW → 404 / 404 / 409, cada una con un solo pool.query', async () => {
    const u = await newUser('cancel-one');
    const other = await newUser('cancel-one-other');
    await order({ userid: u, side: 'CASH_IN', amount: '100.00' });
    const lim = (await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '5.00' })).body;
    const filled = (await order({ userid: u, side: 'CASH_IN', amount: '1.00' })).body;
    const cases: [string, number, number, string][] = [
      ['ajena', other, Number(lim.id), 'NOT_FOUND'],
      ['inexistente', u, 2_000_000_000, 'NOT_FOUND'],
      ['no NEW', u, Number(filled.id), 'NOT_CANCELLABLE'],
    ];
    for (const [name, userid, id, error] of cases) {
      const spy = vi.spyOn(pool, 'query');
      const r = await post(`/orders/${id}/cancel`, { userid });
      expect(r.body.error, name).toBe(error);
      expect(r.status, name).toBe(error === 'NOT_FOUND' ? 404 : 409);
      expect(spy, name).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
    // La 409 trae la orden con su estado actual; la ajena sigue NEW.
    expect((await post(`/orders/${filled.id}/cancel`, { userid: u })).body.order).toEqual(filled);
    expect((await get(`/orders/${lim.id}?userid=${u}`)).body.status).toBe('NEW');
  });
});

describe('cancelaciones simultáneas', () => {
  it('dos cancelaciones de la misma NEW a la vez → un 200 y un 409, la misma orden CANCELLED y la reserva liberada una vez', async () => {
    const u = await newUser('cancel-race');
    await order({ userid: u, side: 'CASH_IN', amount: '100.00' });
    const lim = (await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '5.00' })).body;
    expect((await portfolio(u)).body.cash.reservado).toBe('5.00');
    // Barrera: el lock del usuario retenido hasta que las dos cancelaciones lo estén esperando.
    const lock = await admin.connect();
    let pending: Promise<{ status: number; body: Record<string, any> }>[] = [];
    try {
      await lock.query('BEGIN');
      await lock.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);
      pending = [post(`/orders/${lim.id}/cancel`, { userid: u }), post(`/orders/${lim.id}/cancel`, { userid: u })];
      for (;;) {
        const w = await admin.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND objid::bigint = $1 AND NOT granted", [u]);
        if (w.rows[0].n >= 2) break;
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      await lock.query('COMMIT');
      lock.release();
    }
    const rs = (await Promise.all(pending)).sort((a, b) => a.status - b.status);
    expect(rs.map((r) => r.status)).toEqual([200, 409]);
    expect(rs[0].body.status).toBe('CANCELLED');
    expect(rs[1].body.error).toBe('NOT_CANCELLABLE');
    expect(rs[1].body.order).toEqual(rs[0].body);
    expect((await portfolio(u)).body.cash).toEqual({ neto: '100.00', reservado: '0.00', disponible: '100.00' });
  });
});

describe('cancelación y consulta de órdenes', () => {
  let u: number;
  beforeAll(async () => {
    u = await newUser('cancel');
    await order({ userid: u, side: 'CASH_IN', amount: '1000.00' });
  });

  it('cancelar una NEW → 200 CANCELLED y libera la reserva; cancelarla otra vez → 409', async () => {
    const lim = await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '5.00' });
    expect((await portfolio(u)).body.cash.reservado).toBe('5.00');
    const c1 = await post(`/orders/${lim.body.id}/cancel`, { userid: u });
    expect(c1.status).toBe(200);
    expect(c1.body.status).toBe('CANCELLED');
    expect((await portfolio(u)).body.cash.reservado).toBe('0.00');
    const c2 = await post(`/orders/${lim.body.id}/cancel`, { userid: u });
    expect(c2.status).toBe(409);
    expect(c2.body.error).toBe('NOT_CANCELLABLE');
  });

  // Issue #21: el motivo de la cancelación queda en la orden.
  it('cancelación del usuario → 200 con cancel_reason "USER", el GET lo devuelve igual y el replay del POST sigue siendo la respuesta original', async () => {
    const k = key();
    const body = { userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '5.00' };
    const lim = await order(body, k);
    expect(lim.body).toMatchObject({ status: 'NEW', cancel_reason: null });
    const c = await post(`/orders/${lim.body.id}/cancel`, { userid: u });
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ ...lim.body, status: 'CANCELLED', cancel_reason: 'USER' });
    expect(await get(`/orders/${lim.body.id}?userid=${u}`)).toEqual({ status: 200, body: c.body });
    // R-3: el replay devuelve la respuesta grabada al crearla, no el estado actual de la orden.
    const replay = await order(body, k);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.body).toEqual(lim.body);
  });

  it('una orden no cancelada no tiene motivo: NEW, FILLED y REJECTED → cancel_reason null', async () => {
    const w = await newUser('no-reason');
    const filled = (await order({ userid: w, side: 'CASH_IN', amount: '10.00' })).body;
    const pending = (await order({ userid: w, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '5.00' })).body;
    const rejected = (await order({ userid: w, side: 'CASH_OUT', amount: '1000.00' })).body;
    expect([filled.status, pending.status, rejected.status]).toEqual(['FILLED', 'NEW', 'REJECTED']);
    for (const o of [filled, pending, rejected]) {
      const r = await get(`/orders/${o.id}?userid=${w}`);
      expect(r.body, o.status).toEqual(o);
      expect(r.body, o.status).toHaveProperty('cancel_reason', null);
    }
  });

  it('cancelar una FILLED → 409', async () => {
    const f = await order({ userid: u, side: 'CASH_IN', amount: '1.00' });
    expect((await post(`/orders/${f.body.id}/cancel`, { userid: u })).status).toBe(409);
  });

  it('cancelar la orden de otro usuario → 404, y la orden sigue NEW', async () => {
    const lim = await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: '5.00' });
    const other = await newUser('other');
    expect((await post(`/orders/${lim.body.id}/cancel`, { userid: other })).status).toBe(404);
    expect((await get(`/orders/${lim.body.id}?userid=${u}`)).body.status).toBe('NEW');
  });

});

// Issue #3: el GET exige el userid y no distingue una orden ajena de una inexistente (D-26, D-27).
describe('GET /orders/:id?userid=', () => {
  let owner: number;
  let other: number;
  let placed: Record<string, any>;
  beforeAll(async () => {
    owner = await newUser('get-owner');
    other = await newUser('get-other');
    placed = (await order({ userid: owner, side: 'CASH_IN', amount: '10.00' })).body;
  });

  it('el dueño → 200 con la misma orden que devolvió el POST', async () => {
    const r = await get(`/orders/${placed.id}?userid=${owner}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(placed);
  });

  it('otro usuario → 404, sin datos de la orden', async () => {
    const r = await get(`/orders/${placed.id}?userid=${other}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND', message: `orden ${placed.id} inexistente para el usuario ${other}` });
  });

  it('orden ajena e inexistente responden igual (salvo el id), y como el 404 del cancel', async () => {
    const missing = '2000000000';
    const foreign = await get(`/orders/${placed.id}?userid=${other}`);
    const absent = await get(`/orders/${missing}?userid=${other}`);
    expect(absent.status).toBe(foreign.status);
    expect(absent.body).toEqual({ ...foreign.body, message: foreign.body.message.replace(placed.id, missing) });
    const cancel = await post(`/orders/${placed.id}/cancel`, { userid: other });
    expect(cancel.status).toBe(404);
    expect(cancel.body).toEqual(foreign.body);
  });

  it('sin userid, o userid inválido → 400; id inválido → 400', async () => {
    for (const qs of ['', '?userid=', '?userid=abc', '?userid=0', '?userid=-1', '?userid=1.5', `?userid=${owner}&userid=${owner}`]) {
      const r = await get(`/orders/${placed.id}${qs}`);
      expect(r.status, qs).toBe(400);
      expect(r.body.error, qs).toBe('BAD_REQUEST');
    }
    expect((await get(`/orders/abc?userid=${owner}`)).status).toBe(400);
  });

  it('un segundo userid después de 999 parámetros también → 400 (el parser de Express corta en 1000)', async () => {
    const filler = Array.from({ length: 999 }, (_, i) => `x${i}=1`).join('&');
    const r = await get(`/orders/${placed.id}?userid=${owner}&${filler}&userid=${other}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_REQUEST');
  });
});

describe('GET /portfolio/:userid', () => {
  /** Request al portfolio contando las consultas que la API manda a la base (round-trips). */
  async function portfolioCountingQueries(path: string) {
    const spy = vi.spyOn(pool, 'query');
    try {
      const r = await get(path);
      return { ...r, queries: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  }

  it('usuario 1 del challenge: 753.000 / 125.500 / 627.500, tres posiciones y la historia marcada', async () => {
    const r = await portfolio(1);
    expect(r.status).toBe(200);
    expect(r.body.cash).toEqual({ neto: '753000.00', reservado: '125500.00', disponible: '627500.00' });
    expect(r.body.has_inconsistent_history).toBe(true);
    expect(r.body.positions.map((p: any) => [p.ticker, p.qty, p.costo_unitario, p.inconsistent])).toEqual([
      ['BMA', '-10', null, true],
      ['PAMP', '40', '930.0000', false],
      ['METR', '500', '250.0000', false],
    ]);
  });
  it('usuario con historia: el cuerpo completo es el de docs/api/portfolio.md, en una sola consulta (regresión del contrato)', async () => {
    const r = await portfolioCountingQueries('/portfolio/1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      userid: 1,
      valor_total: '889756.00',
      cash: { neto: '753000.00', reservado: '125500.00', disponible: '627500.00' },
      valuation_complete: true,
      has_inconsistent_history: true,
      positions: [
        {
          instrumentid: 31, ticker: 'BMA', name: 'Banco Macro S.A.',
          qty: '-10', acciones_reservadas: '0', acciones_disponibles: '-10',
          costo_total: '0.000000', costo_unitario: null,
          price: '1502.80', price_date: '2023-07-14',
          valor: '-15028.00', resultado: null, rendimiento_pct: null, retorno_diario_pct: '-1.15',
          inconsistent: true,
        },
        {
          instrumentid: 47, ticker: 'PAMP', name: 'Pampa Holding S.A.',
          qty: '40', acciones_reservadas: '0', acciones_disponibles: '40',
          costo_total: '37200.000000', costo_unitario: '930.0000',
          price: '925.85', price_date: '2023-07-14',
          valor: '37034.00', resultado: '-166.00', rendimiento_pct: '-0.45', retorno_diario_pct: '0.44',
          inconsistent: false,
        },
        {
          instrumentid: 54, ticker: 'METR', name: 'MetroGAS S.A.',
          qty: '500', acciones_reservadas: '0', acciones_disponibles: '500',
          costo_total: '125000.000000', costo_unitario: '250.0000',
          price: '229.50', price_date: '2023-07-14',
          valor: '114750.00', resultado: '-10250.00', rendimiento_pct: '-8.20', retorno_diario_pct: '-1.08',
          inconsistent: false,
        },
      ],
    });
    expect(r.queries).toBe(1);
  });
  it('usuario existente sin órdenes → 200 con cash "0.00" y sin posiciones, en una sola consulta', async () => {
    const u = await newUser('portfolio-vacio');
    const r = await portfolioCountingQueries(`/portfolio/${u}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      userid: u,
      valor_total: '0.00',
      cash: { neto: '0.00', reservado: '0.00', disponible: '0.00' },
      valuation_complete: true,
      has_inconsistent_history: false,
      positions: [],
    });
    expect(r.queries).toBe(1);
  });
  it('usuario inexistente → 404 NOT_FOUND con el cuerpo de siempre, en una sola consulta', async () => {
    const r = await portfolioCountingQueries('/portfolio/2000000000');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'NOT_FOUND', message: 'usuario 2000000000 inexistente' });
    expect(r.queries).toBe(1);
  });
  it('app.read_portfolio con un usuario inexistente falla con APP06 también para el rol api', async () => {
    await expect(pool.query('SELECT * FROM app.read_portfolio($1)', [2_000_000_000]))
      .rejects.toMatchObject({ code: 'APP06', message: 'usuario 2000000000 inexistente' });
  });
  it('id inválido → 400 sin consultar la base', async () => {
    for (const path of ['/portfolio/0', '/portfolio/1.5']) {
      const r = await portfolioCountingQueries(path);
      expect(r.status).toBe(400);
      expect(r.queries).toBe(0);
    }
  });
});

describe('GET /instruments', () => {
  it('por ticker exacto: primero el exacto', async () => {
    const r = await get('/instruments?q=pamp');
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ ticker: 'PAMP' });
  });
  it('por nombre parcial, sin distinguir mayúsculas', async () => {
    const r = await get('/instruments?q=PATAGONIA');
    expect(r.body.results.map((x: any) => x.ticker).sort()).toEqual(['BPAT', 'PATA']);
  });
  it('la moneda se excluye salvo include_cash=true', async () => {
    expect((await get('/instruments?q=ARS')).body.results.some((x: any) => x.type === 'MONEDA')).toBe(false);
    expect((await get('/instruments?q=ARS&include_cash=true')).body.results[0]).toMatchObject({ ticker: 'ARS', type: 'MONEDA' });
  });
  it('los comodines se buscan literalmente; sin resultados → lista vacía', async () => {
    expect((await get('/instruments?q=%25')).body.results).toEqual([]);
    expect((await get('/instruments?q=zzzz')).body.results).toEqual([]);
  });
  it('limit acota la respuesta; q vacío → 400', async () => {
    expect((await get('/instruments?q=a&limit=3')).body.results).toHaveLength(3);
    expect((await get('/instruments?q=')).status).toBe(400);
    expect((await get('/instruments')).status).toBe(400);
  });

  // Issue #28: el orden por niveles de D-25. En el seed ningún ticker es prefijo de otro, así que
  // ningún q llega a los cuatro niveles a la vez: "car" cubre ticker por prefijo, nombre por prefijo
  // y el resto, y "moli" el ticker exacto antes de los nombres. Separar el exacto del prefijo no
  // cambia el resultado: todo ticker que empieza con q y no es q va después de q por ticker.
  const tickers = async (qs: string) => {
    const r = await get(`/instruments?${qs}`);
    expect(r.status, qs).toBe(200);
    return r.body.results.map((x: any) => x.ticker);
  };
  it('orden por niveles: ticker por prefijo, nombre por prefijo, el resto (q=car → CARC, CADO, BHIP, al revés del alfabético)', async () => {
    // CARC (Carboclor) empieza con "car" por ticker; CADO (Carlos Casado) por nombre; BHIP (Banco
    // Hipotecario) solo lo contiene. Por ticker solo, el orden sería BHIP, CADO, CARC.
    expect(await tickers('q=car')).toEqual(['CARC', 'CADO', 'BHIP']);
    expect(await tickers('q=CAR')).toEqual(['CARC', 'CADO', 'BHIP']);
  });
  it('el ticker exacto va primero aunque otros nombres empiecen con q (q=moli → MOLI, MOLA, SEMI)', async () => {
    // MOLA (Molinos Agro) y SEMI (Molinos Juan Semino) empiezan con "moli" por nombre; por ticker, MOLA iría primero.
    expect(await tickers('q=moli')).toEqual(['MOLI', 'MOLA', 'SEMI']);
  });

  it('_ se busca literalmente también por HTTP: no es "cualquier carácter"', async () => {
    expect((await get('/instruments?q=_')).body.results).toEqual([]);
    // Como comodín, PA_P encontraría PAMP. Desde #14 la similitud lo lee como las palabras "pa" y "p"
    // (lo que no es letra ni número separa palabras), y la palabra "p" se parece a la P de Y.P.F.
    expect(await tickers('q=PA_P')).toEqual(['YPFD']);
  });

  // El seed no tiene `_` ni `%`: para probar que se encuentran literalmente hacen falta instrumentos
  // propios. Viven solo en este bloque (otros tests de búsqueda esperan que `%` no encuentre nada).
  describe('con instrumentos que contienen _ y %', () => {
    let ids: number[] = [];
    beforeAll(async () => {
      const r = await admin.query<{ id: number }>(
        `INSERT INTO app.instruments (ticker, name, type)
         VALUES ('Q_28', 'Prueba D-25 al 100%', 'ACCIONES'), ('QX28', 'Prueba D-25 al 1000', 'ACCIONES') RETURNING id`);
      ids = r.rows.map((x) => x.id);
    });
    afterAll(async () => { await admin.query('DELETE FROM app.instruments WHERE id = ANY($1)', [ids]); });

    it('_ y % literales encuentran el instrumento que los contiene; lo que como comodín entraría, no', async () => {
      // Como comodín, "Q_2" encontraría también QX28.
      expect(await tickers('q=Q_2')).toEqual(['Q_28']);
      // "100%" como comodín encontraría también "al 1000"; literal, solo Q_28. Desde #14, QX28 entra
      // igual, por similitud (100 ~ 1000: 0,8), detrás del que lo contiene literalmente (1,0).
      expect(await tickers('q=100%25')).toEqual(['Q_28', 'QX28']);
      // Donde la similitud no llega se ve que % no es comodín: "ue%00" encontraría los dos
      // (Pr-ue-ba … 1-00) y literal no encuentra nada; "ue" y "00" no se parecen a ninguna palabra.
      expect(await tickers('q=ue%2500')).toEqual([]);
      expect(await tickers('q=D-25%20al')).toEqual(['Q_28', 'QX28']);   // control: los dos existen y se encuentran
    });
  });

  // Issue #14: pg_trgm + unaccent (migración 009). Lo que contiene q (LIKE) o se le parece por
  // trigramas (strict_word_similarity ≥ 0,45), sin acentos de los dos lados; las reglas de orden
  // de D-25 siguen por encima de la similitud.
  describe('errores de tipeo y acentos (#14)', () => {
    it('un error de tipeo en una palabra casi completa encuentra el nombre: galisia → GGAL', async () => {
      expect(await tickers('q=galisia')).toEqual(['GGAL']);
    });

    it('los acentos no cuentan, ni en los datos ni en q: rio y río → Molinos Río de la Plata; compania y Compañía → INTR', async () => {
      // Los cuatro contienen "rio" (Río, Laboratorios, Hipotecario, Concesionario): el mismo nivel de
      // D-25 (el resto), ordenados por similitud (la palabra entera primero) y después por ticker.
      expect(await tickers('q=rio')).toEqual(['MOLI', 'RICH', 'BHIP', 'OEST']);
      expect(await tickers(`q=${encodeURIComponent('río')}`)).toEqual(['MOLI', 'RICH', 'BHIP', 'OEST']);
      expect(await tickers('q=compania')).toEqual(['INTR']);
      expect(await tickers(`q=${encodeURIComponent('Compañía')}`)).toEqual(['INTR']);
    });

    // El seed no tiene "Petróleo" ni un segundo "Pampa": instrumentos propios, solo en este bloque.
    describe('con Petróleo Austral y Pampa Energía', () => {
      let ids: number[] = [];
      beforeAll(async () => {
        const r = await admin.query<{ id: number }>(
          `INSERT INTO app.instruments (ticker, name, type)
           VALUES ('PETR', 'Petróleo Austral S.A.', 'ACCIONES'), ('ENRG', 'Pampa Energía S.A.', 'ACCIONES') RETURNING id`);
        ids = r.rows.map((x) => x.id);
      });
      afterAll(async () => { await admin.query('DELETE FROM app.instruments WHERE id = ANY($1)', [ids]); });

      it('petroleo, Petróleo y PETROLEO encuentran Petróleo Austral', async () => {
        for (const q of ['petroleo', 'Petróleo', 'PETROLEO', 'petrolio']) {
          expect(await tickers(`q=${encodeURIComponent(q)}`), q).toEqual(['PETR']);
        }
      });

      it('falsos positivos: q=pampa no pone PAMP (parecido por ticker) por delante de Pampa Energía; los dos empiezan con pampa por nombre y van por ticker', async () => {
        expect(await tickers('q=pampa')).toEqual(['ENRG', 'PAMP']);
        expect(await tickers('q=energia')).toEqual(['ENRG']);
      });
    });

    it('las reglas de orden de D-25 van por encima de la similitud: q=GAL como hoy; q=banco → los bancos por ticker, no por similitud', async () => {
      expect(await tickers('q=GAL')).toEqual(['GGAL']);
      expect(await tickers('q=gal')).toEqual(['GGAL']);
      // Con el umbral de 0,45 "Gas Natural Ban" (banco ~ ban: 0,43) queda afuera.
      expect(await tickers('q=banco')).toEqual(['BBAR', 'BHIP', 'BMA', 'BPAT']);
    });

    // Instrumentos propios, solo en este bloque: un ticker que empieza con q pero se le parece menos
    // que un nombre, y dos nombres del mismo nivel donde el que contiene q se le parece menos.
    describe('nivel contra similitud, y similitud contra pertenencia literal', () => {
      let ids: number[] = [];
      beforeAll(async () => {
        const r = await admin.query<{ id: number }>(
          `INSERT INTO app.instruments (ticker, name, type) VALUES
             ('BANCOS', 'Fondo de prueba D-25', 'ACCIONES'), ('ZBDT', 'Banco del Test D-25', 'ACCIONES'),
             ('ZXBX', 'Fondo xbancox', 'ACCIONES'), ('ZBCA', 'Fondo banca', 'ACCIONES'),
             ('ZZAX', 'Fondo xzorzalx', 'ACCIONES'), ('ZZBA', 'Fondo zorzala', 'ACCIONES') RETURNING id`);
        ids = r.rows.map((x) => x.id);
      });
      afterAll(async () => { await admin.query('DELETE FROM app.instruments WHERE id = ANY($1)', [ids]); });

      it('un ticker que empieza con q va antes que un nombre que empieza con q, aunque el nombre se le parezca más (banco: BANCOS 0,63, "Banco del Test" 1)', async () => {
        const r = await tickers('q=banco&limit=50');
        expect(r[0]).toBe('BANCOS');
        expect(r.indexOf('ZBDT')).toBeGreaterThan(0);
      });

      it('dentro de un nivel ordena la similitud, no la pertenencia literal: "Fondo banca" (0,5) antes que "Fondo xbancox" (0,27), que contiene banco', async () => {
        const r = await tickers('q=banco&limit=50');
        expect(r).toContain('ZXBX');
        expect(r.indexOf('ZBCA')).toBeLessThan(r.indexOf('ZXBX'));
        // Solos en su nivel: con limit=1 queda el parecido y no el que lo contiene.
        expect(await tickers('q=zorzal')).toEqual(['ZZBA', 'ZZAX']);
        expect(await tickers('q=zorzal&limit=1')).toEqual(['ZZBA']);
      });
    });

    // unaccent convierte ％ ＿ ＼ (ancho completo) en % _ \: la búsqueda normaliza primero y escapa
    // después, así que siguen siendo literales.
    describe('comodines de ancho completo', () => {
      let ids: number[] = [];
      beforeAll(async () => {
        const r = await admin.query<{ id: number }>(
          `INSERT INTO app.instruments (ticker, name, type) VALUES
             ('ZPCT', 'Prueba D-25 50% fijo', 'ACCIONES'), ('ZUND', 'Prueba D-25 A_B', 'ACCIONES'), ('ZBSL', $1, 'ACCIONES') RETURNING id`,
          ['Prueba D-25 C\\D']);
        ids = r.rows.map((x) => x.id);
      });
      afterAll(async () => { await admin.query('DELETE FROM app.instruments WHERE id = ANY($1)', [ids]); });

      it('％, ＿ y ＼ encuentran solo el instrumento con %, _ o \\; como comodines encontrarían todo el catálogo', async () => {
        expect(await tickers(`q=${encodeURIComponent('％')}`)).toEqual(['ZPCT']);
        expect(await tickers(`q=${encodeURIComponent('＿')}`)).toEqual(['ZUND']);
        expect(await tickers(`q=${encodeURIComponent('＼')}`)).toEqual(['ZBSL']);
        expect(await tickers(`q=${encodeURIComponent('50％ f')}`)).toEqual(['ZPCT']);
        // Control: el catálogo entero tiene mucho más que esos tres.
        expect((await tickers('q=e&limit=50')).length).toBeGreaterThan(3);
      });
    });

    // Igualdad de conjuntos: LIKE o similitud, nunca en vez de. Lo que encontraba ILIKE '%q%' (la
    // consulta anterior, acá tal cual) sigue apareciendo, para los q de la doc y de estas pruebas.
    const legacy = async (q: string, includeCash = false) => (await admin.query<{ ticker: string }>(
      `SELECT ticker FROM app.instruments
        WHERE (ticker ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%') AND ($2 OR type <> 'MONEDA')`,
      [q.replace(/[\\%_]/g, (m) => `\\${m}`), includeCash])).rows.map((r) => r.ticker).sort();
    it('todo lo que encontraba ILIKE sigue apareciendo (LIKE o similitud)', async () => {
      for (const q of ['pa', 'pamp', 'PATAGONIA', 'ARS', 'car', 'CAR', 'moli', 'banco', 'gal', 'rio', 'galisia', 'zzzz', '%', '_', 'PA_P', 'Q_2', 'D-25 al']) {
        const before = await legacy(q);
        expect(before.length, q).toBeLessThanOrEqual(50);
        const after = await tickers(`q=${encodeURIComponent(q)}&limit=50`);
        expect(after.filter((t: string) => before.includes(t)).sort(), q).toEqual(before);
      }
      expect(await legacy('ARS', true)).toEqual(['ARS']);
      expect((await tickers('q=ARS&include_cash=true&limit=50'))).toContain('ARS');
    });

    // Escape: ILIKE interpreta % y _, la similitud no (ignora lo que no es alfanumérico). Los dos
    // caminos dan vacío con el seed, antes y después de #14.
    it('q=% y q=_ → [] por los dos caminos: no hay trigramas que buscar ni comodines que interpretar', async () => {
      expect(await legacy('%')).toEqual([]);
      expect(await tickers('q=%25&limit=50')).toEqual([]);
      expect(await legacy('_')).toEqual([]);
      expect(await tickers('q=_&limit=50')).toEqual([]);
    });

    // q de 1 carácter: sí tiene trigramas ("  a" y " a "), pero con el umbral de 0,45 solo alcanza
    // en una palabra que empiece o sea esa letra, que LIKE ya encuentra. En la práctica, la similitud
    // suma a partir de 4 caracteres; la consulta no distingue el largo de q.
    it('q de 1 carácter: el conjunto es exactamente el de ILIKE (la similitud no suma nada)', async () => {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL pg_trgm.strict_word_similarity_threshold = 0.45');   // el umbral del rol api, para la conexión administradora
        for (const q of ['a', 'e', 'i', 'o', 'u', 'r', '2', 'x']) {
          const after = (await c.query<{ ticker: string }>(SEARCH_SQL, [q, false, 1000])).rows.map((r) => r.ticker).sort();
          expect(after, q).toEqual(await legacy(q));
        }
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    });

    // Plan de pruebas 7: con 66 filas el planner recorre la tabla aunque exista el índice; con
    // 50.000 usa los dos índices GIN, para LIKE y para la similitud (BitmapOr de cuatro lecturas).
    // Las filas se siembran como administrador dentro de una transacción que se revierte.
    it('con 50.000 instrumentos la consulta usa los índices GIN de ticker y name, para LIKE y para la similitud; con 66, seq scan', async () => {
      type Plan = { 'Node Type': string; 'Index Name'?: string; 'Index Cond'?: string; Plans?: Plan[] };
      const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL pg_trgm.strict_word_similarity_threshold = 0.45');
        const explain = async () => nodes((await c.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SEARCH_SQL}`, ['galisia', false, 20])).rows[0]['QUERY PLAN'][0].Plan);
        expect(explain().then((n) => n.map((x) => x['Node Type']))).resolves.toContain('Seq Scan');

        await c.query(`INSERT INTO app.instruments (ticker, name, type)
          SELECT upper(substr(md5(i::text), 1, 5)), 'Compañía ' || substr(md5(i::text), 6, 12) || ' S.A.', 'ACCIONES'
            FROM generate_series(1, 50000) i`);
        await c.query('ANALYZE app.instruments');
        const scans = (await explain()).filter((n) => n['Node Type'] === 'Bitmap Index Scan')
          .map((n) => `${n['Index Name']}: ${n['Index Cond']!.includes('~~') ? 'LIKE' : n['Index Cond']!.includes('%>>') || n['Index Cond']!.includes('<<%') ? 'similitud' : n['Index Cond']}`)
          .sort();
        expect(scans).toEqual([
          'instruments_name_trgm: LIKE', 'instruments_name_trgm: similitud',
          'instruments_ticker_trgm: LIKE', 'instruments_ticker_trgm: similitud',
        ]);
        // Y entre 50.066 filas sigue encontrando solo Galicia (md5 no tiene g, l, s ni i).
        expect((await c.query<{ ticker: string }>(SEARCH_SQL, ['galisia', false, 20])).rows.map((r) => r.ticker)).toEqual(['GGAL']);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      await admin.query('VACUUM app.instruments');   // las 50.000 filas revertidas no quedan como tuplas muertas para las pruebas siguientes
    }, 120_000);
  });

  it('query devuelve q recortado y cada resultado tiene exactamente id, ticker, name y type', async () => {
    const r = await get('/instruments?q=%20%20pamp%20');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ query: 'pamp', results: [{ id: 47, ticker: 'PAMP', name: 'Pampa Holding S.A.', type: 'ACCIONES' }] });
  });

  it('la respuesta coincide con el ejemplo de docs/api/instruments.md', async () => {
    const doc = readFileSync(new URL('../../docs/api/instruments.md', import.meta.url), 'utf8');
    const block = doc.split('## Response `200`')[1].split('```json')[1].split('```')[0];
    // El ejemplo muestra los primeros resultados y sigue con "…": se quita el marcador y se parsea el objeto entero.
    const truncated = /,\s*…\s*\]/.test(block);
    const example = JSON.parse(block.replace(/,\s*…\s*\]/, ']')) as { query: string; results: unknown[] };
    expect(truncated).toBe(true);
    expect(example.results.length).toBeGreaterThan(0);
    const r = await get(`/instruments?q=${encodeURIComponent(example.query)}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(Object.keys(example));
    expect(r.body.query).toBe(example.query);
    expect(r.body.results.length).toBeGreaterThan(example.results.length);
    expect(r.body.results.slice(0, example.results.length)).toEqual(example.results);
  });

  it('q de 50 caracteres → 200 (también con el limit máximo; sin resultados: 50 "a" no se parecen a nada); de 51 → 400', async () => {
    expect((await get(`/instruments?q=${'a'.repeat(50)}`)).status).toBe(200);
    expect((await get(`/instruments?q=${'a'.repeat(50)}&limit=50`)).body).toEqual({ query: 'a'.repeat(50), results: [] });
    const r = await get(`/instruments?q=${'a'.repeat(51)}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_REQUEST');
  });

  it('el máximo se cuenta después de recortar: 50 caracteres entre espacios → 200 con query recortado; 51 → 400', async () => {
    const ok = await get(`/instruments?q=%20%20${'a'.repeat(50)}%20%20`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ query: 'a'.repeat(50), results: [] });
    expect((await get(`/instruments?q=%20%20${'a'.repeat(51)}%20%20`)).status).toBe(400);
  });

  it('q con solo espacios → 400, como q vacío', async () => {
    const r = await get('/instruments?q=%20%20%20');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_REQUEST');
  });

  it('limit fuera de 1 a 50, decimal o no numérico → 400; 1 y 50 → 200', async () => {
    for (const limit of ['0', '51', '-1', '1.5', 'abc', '']) {
      const r = await get(`/instruments?q=a&limit=${limit}`);
      expect(r.status, limit).toBe(400);
      expect(r.body.error, limit).toBe('BAD_REQUEST');
    }
    expect((await get('/instruments?q=a&limit=1')).body.results).toHaveLength(1);
    expect((await get('/instruments?q=a&limit=50')).body.results).toHaveLength(50);
  });

  it('sin limit devuelve 20 aunque haya más resultados', async () => {
    expect((await get('/instruments?q=a&limit=50')).body.results.length).toBeGreaterThan(20);
    expect((await get('/instruments?q=a')).body.results).toHaveLength(20);
  });

  it('include_cash con otro valor que true o false → 400', async () => {
    for (const v of ['TRUE', '1', 'yes', '']) {
      const r = await get(`/instruments?q=ARS&include_cash=${v}`);
      expect(r.status, v).toBe(400);
      expect(r.body.error, v).toBe('BAD_REQUEST');
    }
    expect((await get('/instruments?q=ARS&include_cash=false')).body.results).toEqual([]);
  });
});

describe('internos y salud', () => {
  it('GET /health → ok con la base arriba y el commit desplegado en release', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: 'up', release: 'test-release' });
  });
  // D-29: el gate del deploy lee release también cuando la base no responde, para saber qué
  // commit atiende antes de desplegar.
  it('GET /health con la consulta de salud fallando en Postgres → 503 con db down y el mismo release', async () => {
    await admin.query('REVOKE EXECUTE ON FUNCTION app.health() FROM api');
    try {
      const r = await get('/health');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ok: false, db: 'down', release: 'test-release' });
    } finally {
      await admin.query('GRANT EXECUTE ON FUNCTION app.health() TO api');
    }
    expect((await get('/health')).status).toBe(200);
  });
  it('GET /health sin RELEASE configurado → release null, como en docker compose', async () => {
    const s = createApp({ internalToken: 'test-token' }).listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${(s.address() as { port: number }).port}/health`);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, db: 'up', release: null });
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });
  // D-29: en producción RELEASE llega por el entorno y createApp() lo toma de config, sin
  // opciones. El servidor real (src/server.ts, el mismo que arranca la imagen) con RELEASE.
  it('el servidor real toma RELEASE del entorno: /health lo devuelve sano y en el 503', async () => {
    const free = createServer().listen(0);
    await once(free, 'listening');
    const port = (free.address() as { port: number }).port;
    await new Promise((resolve) => free.close(resolve));
    const proc = spawn(resolve('node_modules/.bin/tsx'), [resolve('src/server.ts')], {
      env: { ...process.env, PORT: String(port), RELEASE: 'sha-del-entorno', JOBS_ENABLED: 'false' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      let out = '';
      await new Promise<void>((ok, fail) => {
        proc.stdout.on('data', (d: Buffer) => { out += d; if (out.includes('escuchando')) ok(); });
        proc.on('exit', (code) => fail(new Error(`src/server.ts salió con ${code}: ${out}`)));
      });
      const health = async () => {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        return { status: r.status, body: await r.json() };
      };
      expect(await health()).toMatchObject({ status: 200, body: { ok: true, db: 'up', release: 'sha-del-entorno' } });
      await admin.query('REVOKE EXECUTE ON FUNCTION app.health() FROM api');
      try {
        expect(await health()).toEqual({ status: 503, body: { ok: false, db: 'down', release: 'sha-del-entorno' } });
      } finally {
        await admin.query('GRANT EXECUTE ON FUNCTION app.health() TO api');
      }
    } finally {
      proc.kill('SIGTERM');
      if (proc.exitCode === null) await once(proc, 'exit');
    }
  }, 30_000);
  it('/internal/* sin token → 401', async () => {
    expect((await post('/internal/execute-limits', {})).status).toBe(401);
  });
  it('executor: ejecuta una LIMIT que la cotización cruza, a su precio límite', async () => {
    const u = await newUser('exec');
    await order({ userid: u, side: 'CASH_IN', amount: fmt(q.closeCents * 4n) });
    const limit = fmt(q.closeCents * 2n);    // BUY: cruza si close ≤ límite
    const lim = await order({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, price: limit });
    const r = await post('/internal/execute-limits', {}, { 'X-Internal-Token': 'test-token' });
    expect(r.status).toBe(200);
    expect(r.body.executed).toContain(lim.body.id);
    const o = await get(`/orders/${lim.body.id}?userid=${u}`);
    expect(o.body).toMatchObject({ status: 'FILLED', price: limit });
    const p = (await portfolio(u)).body;
    expect(p.positions[0]).toMatchObject({ qty: '1', costo_unitario: `${limit}00` });
    expect(cents(p.cash.neto)).toBe(q.closeCents * 2n);
  });
});
