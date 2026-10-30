// Test funcional de "enviar una orden" (lo que pide el enunciado), de punta a punta: HTTP →
// Express → app.place_order → Postgres real. Cada bloque crea su usuario.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
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

  it('transición: la clave vieja se resuelve con un solo lock; una limpieza en cola no la reemplaza por una nueva con el hash anterior', async () => {
    const v = await newUser('legacy-cleanup');
    const k = key();
    const legacyHash = requestHash({ userid: v, side: 'CASH_IN', type: 'MARKET', amount: '100' });
    const canonicalHash = requestHash({ userid: v, side: 'CASH_IN', type: 'MARKET', amount: '100.00' });
    const first = await placeOrderDb(pool, { userid: v, key: k, hash: legacyHash, side: 'CASH_IN', type: 'MARKET', instrumentid: await arsId(), amount: '100' });
    await admin.query("UPDATE app.idempotency_keys SET created_at = now() - interval '25 hours' WHERE userid = $1 AND key = $2", [v, k]);   // vencida: la limpieza la puede borrar

    // Barreras con locks: A tiene el lock del usuario; el request queda esperando; detrás, C (la limpieza) también.
    // Al soltar A, el request obtiene el lock primero y decide; C recién después. Un segundo intento del request
    // quedaría detrás de C: C borraría la clave y ese intento crearía otra orden grabando el hash anterior.
    const waiting = async (n: number) => {
      for (let i = 0; i < 10_000; i++) {
        const r = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = $1::oid AND objsubid = 2", [v]);
        if (r.rows[0].n === n) return;
      }
      throw new Error(`no hay ${n} esperando el lock del usuario ${v}`);
    };
    const lockSql = "SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)";
    const a = await admin.connect();
    const c = await admin.connect();
    try {
      await a.query('BEGIN');
      await a.query(lockSql, [v]);
      const pending = order({ userid: v, side: 'CASH_IN', amount: 100 }, k);
      await waiting(1);
      await c.query('BEGIN');
      const cleanup = c.query(lockSql, [v])
        .then(() => c.query("DELETE FROM app.idempotency_keys WHERE userid = $1 AND created_at < now() - interval '24 hours'", [v]))
        .then(() => c.query('COMMIT'));
      await waiting(2);
      await a.query('COMMIT');

      const r = await pending;
      await cleanup;
      expect(r.status).toBe(201);
      expect(r.headers.get('idempotent-replay')).toBe('true');
      expect(r.body).toEqual(first.body);
    } finally {
      a.release();
      c.release();
    }
    // Ninguna clave quedó grabada con el hash anterior, y hay una sola orden.
    expect((await admin.query('SELECT 1 FROM app.idempotency_keys WHERE userid = $1 AND request_hash = $2', [v, legacyHash])).rowCount).toBe(0);
    expect((await admin.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [v])).rows[0].n).toBe(1);

    // Vencida y borrada, la clave se puede reusar (D-19): la nueva guarda el hash canonizado,
    // así que el reintento con "100.00" es replay de la nueva orden.
    const fresh = await order({ userid: v, side: 'CASH_IN', amount: 100 }, k);
    expect(fresh.headers.get('idempotent-replay')).toBe('false');
    const stored = await admin.query('SELECT request_hash FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [v, k]);
    expect(stored.rows[0].request_hash).toBe(canonicalHash);
    const retry = await order({ userid: v, side: 'CASH_IN', amount: '100.00' }, k);
    expect(retry.headers.get('idempotent-replay')).toBe('true');
    expect(retry.body).toEqual(fresh.body);
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

// Issue #1: cada escritura es una sola sentencia; su statement_timeout es el presupuesto (D-20).
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
    expect((await get('/instruments?q=PA_P')).body.results).toEqual([]);   // como comodín, encontraría PAMP
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

    it('_ y % literales encuentran el instrumento que los contiene, y solo ese', async () => {
      // Como comodines, "Q_2" encontraría también QX28 y "100%" también "al 1000".
      expect(await tickers('q=Q_2')).toEqual(['Q_28']);
      expect(await tickers('q=100%25')).toEqual(['Q_28']);
      expect(await tickers('q=D-25%20al')).toEqual(['Q_28', 'QX28']);   // control: los dos existen y se encuentran
    });
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

  it('q de 50 caracteres → 200; de 51 → 400', async () => {
    expect((await get(`/instruments?q=${'a'.repeat(50)}`)).status).toBe(200);
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
