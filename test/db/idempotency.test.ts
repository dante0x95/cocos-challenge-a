// Vencimiento de las claves de idempotencia (D-19, issue #4 de este repositorio): lo decide
// app.place_order al reclamar la clave, con created_at y app.idempotency_ttl(); la limpieza solo
// recupera espacio. Plan de pruebas del issue, puntos 1 a 7 y 9; el 8 (la limpieza en cola antes o
// después del request) está en orders.api.test.ts, con la clave de la transición del hash.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
import { admin, apiClient, arsId, newUser, placeOrder as placeOrderDb } from '../support/db.js';
import { requestHash } from '../../src/domain/orders.js';

let server: Server;
let base: string;
let ars: number;
let noQuote: number;   // instrumento sin cotización: un BUY MARKET sobre él falla con NO_PRICE

const key = () => `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, replay: r.headers.get('idempotent-replay'), body: (await r.json()) as Record<string, any> };
}
const order = (body: unknown, k: string) => post('/orders', body, { 'Idempotency-Key': k });
async function get(path: string) {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

const cashIn = (userid: number, amount = '1.00') => ({ userid, side: 'CASH_IN', amount });
/** Lo que graba la API para un depósito: el hash del body validado, con amount canonizado. */
const cashInHash = (userid: number, amount = '1.00') => requestHash({ userid, side: 'CASH_IN', type: 'MARKET', amount });

interface KeyRow { request_hash: string; order_id: string | null; http_status: number | null; response_body: Record<string, any> | null; created_at: string }
const row = async (u: number, k: string) => (await admin.query<KeyRow>(
  'SELECT request_hash, order_id::text, http_status, response_body, created_at::text FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, k])).rows[0];
const rows = async (u: number, k: string) =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, k])).rows[0].n;
const ordersOf = async (u: number) =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n;
/** Envejece la clave: created_at = now() − `by`. */
const age = (u: number, k: string, by: string) =>
  admin.query('UPDATE app.idempotency_keys SET created_at = now() - $3::interval WHERE userid = $1 AND key = $2', [u, k, by]);
const ttl = async () => (await admin.query<{ ttl: string }>('SELECT app.idempotency_ttl()::text AS ttl')).rows[0].ttl;
/** Lo que corre el job, por usuario (cleanup_candidates elige a quién; cleanup_idempotency borra). */
const candidates = async () => (await pool.query<{ userid: number }>('SELECT userid FROM app.cleanup_candidates()')).rows.map((r) => r.userid);
const cleanup = async (u: number) => (await pool.query<{ n: number }>('SELECT app.cleanup_idempotency($1) AS n', [u])).rows[0].n;

const userLock = "SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)";
/** Espera hasta que exactamente `n` sesiones estén esperando el lock del usuario. */
async function waiting(u: number, n: number) {
  for (;;) {
    const r = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = $1::oid AND objsubid = 2", [u]);
    if (r.rows[0].n === n) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeAll(async () => {
  ars = await arsId();
  noQuote = (await admin.query<{ id: number }>(
    "INSERT INTO app.instruments (ticker, name, type) VALUES ('TTLNOQ', 'Prueba D-19 sin cotización', 'ACCIONES') RETURNING id")).rows[0].id;
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await admin.query('UPDATE app.settings SET idempotency_ttl = DEFAULT');   // por si el punto 3 quedó a mitad
  await admin.query('DELETE FROM app.instruments WHERE id = $1', [noQuote]);
  await pool.end();
  await admin.end();
});

describe('el vencimiento lo decide place_order con created_at y app.idempotency_ttl()', () => {
  it('1. a exactamente 24 h la clave está viva (replay / 422); a 24 h + 1 µs está vencida (201 nueva): la comparación es estricta', async () => {
    const u = await newUser('ttl-borde');
    const k = 'borde';
    const first = await placeOrderDb(pool, { userid: u, key: k, hash: 'h1', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '1.00' });
    expect(first).toMatchObject({ status: 201, replay: false });

    // place_order compara con el now() de su transacción. Para ponerse exactamente en el borde, la
    // clave se envejece a 24 h de ESE now(), con precisión de microsegundos (como texto: un Date de
    // JS perdería los microsegundos), y place_order corre en la misma transacción.
    const c = await apiClient();
    const atBoundary = async (offset: string, hash: string) => {
      await c.query('BEGIN');
      try {
        const t0 = (await c.query<{ t0: string }>('SELECT now()::text AS t0')).rows[0].t0;
        await admin.query(`UPDATE app.idempotency_keys SET created_at = $3::timestamptz - app.idempotency_ttl() ${offset} WHERE userid = $1 AND key = $2`, [u, k, t0]);
        const r = await placeOrderDb(c, { userid: u, key: k, hash, side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '1.00' });
        await c.query('COMMIT');
        return { ...r, t0 };
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    };
    try {
      // created_at = now() − 24 h exacto: viva. Mismo hash → replay; otro hash → 422.
      const replay = await atBoundary('', 'h1');
      expect(replay).toMatchObject({ status: 201, replay: true, order_id: first.order_id, body: first.body });
      await expect(atBoundary('', 'h2')).rejects.toMatchObject({ code: 'APP03' });
      expect(await row(u, k)).toMatchObject({ request_hash: 'h1', order_id: first.order_id });
      expect(await ordersOf(u)).toBe(1);

      // created_at = now() − 24 h − 1 µs: vencida. Mismo hash → orden nueva, y la fila se renueva con ese now().
      const fresh = await atBoundary("- interval '1 microsecond'", 'h1');
      expect(fresh).toMatchObject({ status: 201, replay: false });
      expect(fresh.order_id).not.toBe(first.order_id);
      expect(await row(u, k)).toMatchObject({ request_hash: 'h1', order_id: fresh.order_id, http_status: 201, response_body: fresh.body, created_at: fresh.t0 });
      // Y otro hash sobre una clave vencida también crea: no es un 422.
      const other = await atBoundary("- interval '1 microsecond'", 'h2');
      expect(other).toMatchObject({ status: 201, replay: false });
      expect(await row(u, k)).toMatchObject({ request_hash: 'h2', order_id: other.order_id });
      expect(await ordersOf(u)).toBe(3);
      expect(await rows(u, k)).toBe(1);
    } finally {
      await c.end();
    }
  });

  it('2. la clave vence por reloj mientras el request espera el lock 1,5 s → sigue viva: decide con el now() del inicio de su transacción, como la limpieza', async () => {
    const u = await newUser('ttl-espera');
    const k = key();
    const first = await order(cashIn(u), k);
    expect(first).toMatchObject({ status: 201, replay: 'false' });

    const a = await admin.connect();
    try {
      await a.query('BEGIN');
      await a.query(userLock, [u]);
      const pending = order(cashIn(u), k);
      await waiting(u, 1);
      // El now() del request ya quedó fijado. Desde acá, la clave vence dentro de 1 s: viva para ese
      // now(), vencida para el reloj cuando el request obtenga el lock, 1,5 s después.
      await admin.query("UPDATE app.idempotency_keys SET created_at = now() - app.idempotency_ttl() + interval '1 second' WHERE userid = $1 AND key = $2", [u, k]);
      await a.query('SELECT pg_sleep(1.5)');
      await a.query('COMMIT');
      const r = await pending;
      expect(r).toMatchObject({ status: 201, replay: 'true', body: first.body });
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
    }
    // Por reloj ya venció (si no, la prueba no probó nada), así que un request nuevo, con otro now(), la reusa.
    expect((await admin.query<{ expired: boolean }>(
      'SELECT clock_timestamp() > created_at + app.idempotency_ttl() AS expired FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, k])).rows[0].expired).toBe(true);
    const fresh = await order(cashIn(u), k);
    expect(fresh).toMatchObject({ status: 201, replay: 'false' });
    expect(fresh.body.id).not.toBe(first.body.id);
    expect(await ordersOf(u)).toBe(2);
  });

  it('3. settings.idempotency_ttl es la única fuente del plazo: a 1 minuto, una clave de 2 min la reusa place_order y la borra la limpieza; a 24 h, ninguno la toca', async () => {
    const u = await newUser('ttl-1min');
    const w = await newUser('ttl-1min-limpieza');
    const k = key();
    const first = await order(cashIn(u), k);
    expect(first.status).toBe(201);
    expect((await order(cashIn(w), k)).status).toBe(201);
    expect(await ttl()).toBe('24:00:00');

    let reused: Awaited<ReturnType<typeof order>>;
    try {
      await admin.query("UPDATE app.settings SET idempotency_ttl = '1 minute'");
      expect(await ttl()).toBe('00:01:00');
      await age(u, k, '2 minutes');
      await age(w, k, '2 minutes');
      // place_order la reusa…
      reused = await order(cashIn(u), k);
      expect(reused).toMatchObject({ status: 201, replay: 'false' });
      expect(reused.body.id).not.toBe(first.body.id);
      // …y la limpieza la borra (la de w; la de u acaba de renovarse y ya no es candidata).
      const c = await candidates();
      expect(c).toContain(w);
      expect(c).not.toContain(u);
      expect(await cleanup(w)).toBe(1);
      expect(await rows(w, k)).toBe(0);
    } finally {
      await admin.query('UPDATE app.settings SET idempotency_ttl = DEFAULT');
    }
    expect(await ttl()).toBe('24:00:00');

    // De vuelta a 24 h, la misma clave de 2 min está viva para los dos.
    await age(u, k, '2 minutes');
    expect(await order(cashIn(u), k)).toMatchObject({ status: 201, replay: 'true', body: reused.body });
    expect(await candidates()).not.toContain(u);
    expect(await cleanup(u)).toBe(0);
    expect(await rows(u, k)).toBe(1);
    expect(await ordersOf(u)).toBe(2);
  });

  it('4. clave vencida con otro body → 201 nueva; la orden vieja sigue; la fila tiene hash, order_id, http_status, response_body y created_at nuevos, y es una sola', async () => {
    const u = await newUser('ttl-otro-body');
    const k = key();
    const first = await order(cashIn(u, '1.00'), k);
    expect(first.status).toBe(201);
    await age(u, k, '25 hours');
    const before = await row(u, k);
    expect(before).toMatchObject({ request_hash: cashInHash(u, '1.00'), order_id: first.body.id, http_status: 201, response_body: first.body });

    const second = await order(cashIn(u, '2.00'), k);
    expect(second).toMatchObject({ status: 201, replay: 'false' });
    expect(second.body).toMatchObject({ amount: '2.00', status: 'FILLED' });
    expect(second.body.id).not.toBe(first.body.id);

    expect(await get(`/orders/${first.body.id}?userid=${u}`)).toEqual({ status: 200, body: first.body });
    const after = await row(u, k);
    expect(after).toEqual({ request_hash: cashInHash(u, '2.00'), order_id: second.body.id, http_status: 201, response_body: second.body, created_at: expect.any(String) });
    expect(new Date(after.created_at).getTime()).toBeGreaterThan(new Date(before.created_at).getTime());
    expect(await rows(u, k)).toBe(1);
    expect(await ordersOf(u)).toBe(2);
    // La clave renovada es la del segundo request: su replay es la segunda orden, y el body de ayer ahora es otro request.
    expect(await order(cashIn(u, '2.00'), k)).toMatchObject({ status: 201, replay: 'true', body: second.body });
    expect((await order(cashIn(u, '1.00'), k)).body.error).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('5. clave vencida reclamada por un request que falla (BUY MARKET sin cotización → 422 NO_PRICE) → la fila queda como estaba, con el created_at viejo', async () => {
    const u = await newUser('ttl-no-price');
    const k = key();
    const first = await order(cashIn(u, '100.00'), k);
    expect(first.status).toBe(201);
    await age(u, k, '25 hours');
    const before = await row(u, k);

    const failed = await order({ userid: u, side: 'BUY', type: 'MARKET', instrumentid: noQuote, size: 1 }, k);
    expect(failed.status).toBe(422);
    expect(failed.body.error).toBe('NO_PRICE');
    expect(await row(u, k)).toEqual(before);
    expect(await rows(u, k)).toBe(1);
    expect(await ordersOf(u)).toBe(1);
    // Sigue vencida: el próximo request con esa clave la reusa.
    const fresh = await order(cashIn(u, '100.00'), k);
    expect(fresh).toMatchObject({ status: 201, replay: 'false' });
    expect(fresh.body.id).not.toBe(first.body.id);
  });

  it('6. clave legada vencida con p_legacy_hash que coincide → 201, replay false, orden nueva y el hash canónico grabado', async () => {
    const v = await newUser('ttl-legacy');
    const k = key();
    // Lo que grababa la versión anterior: el hash del body con amount tal como llegó ("100").
    const legacyHash = requestHash({ userid: v, side: 'CASH_IN', type: 'MARKET', amount: '100' });
    const canonicalHash = requestHash({ userid: v, side: 'CASH_IN', type: 'MARKET', amount: '100.00' });
    const first = await placeOrderDb(pool, { userid: v, key: k, hash: legacyHash, side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '100' });
    expect(first.status).toBe(201);
    // Control: viva, el mismo request es replay por el hash anterior.
    expect(await order({ userid: v, side: 'CASH_IN', amount: 100 }, k)).toMatchObject({ status: 201, replay: 'true', body: first.body });

    await age(v, k, '25 hours');
    const r = await order({ userid: v, side: 'CASH_IN', amount: 100 }, k);
    expect(r).toMatchObject({ status: 201, replay: 'false' });
    expect(r.body.id).not.toBe(first.body.id);
    expect(await row(v, k)).toMatchObject({ request_hash: canonicalHash, order_id: r.body.id, http_status: 201, response_body: r.body });
    expect(await rows(v, k)).toBe(1);
    expect(await ordersOf(v)).toBe(2);
    expect(await order({ userid: v, side: 'CASH_IN', amount: '100.00' }, k)).toMatchObject({ status: 201, replay: 'true', body: r.body });
  });

  it('9. con JOBS_ENABLED=false (ninguna limpieza corre), una clave a 25 h se reusa igual: el vencimiento no depende del job', async () => {
    // Las pruebas corren sin jobs: createApp no los arranca (solo server.ts, con JOBS_ENABLED=true).
    expect(config.JOBS_ENABLED).toBe(false);
    const u = await newUser('ttl-sin-jobs');
    const k = key();
    const first = await order(cashIn(u), k);
    expect(first.status).toBe(201);
    await age(u, k, '25 hours');
    expect(await candidates()).toContain(u);   // nadie llama a la limpieza

    const r = await order(cashIn(u), k);
    expect(r).toMatchObject({ status: 201, replay: 'false' });
    expect(r.body.id).not.toBe(first.body.id);
    expect(await row(u, k)).toMatchObject({ order_id: r.body.id, http_status: 201, response_body: r.body });
    expect(await rows(u, k)).toBe(1);
    expect(await ordersOf(u)).toBe(2);
    expect(await candidates()).not.toContain(u);   // la fila renovada ya no está vencida: a la limpieza no le queda nada
  });
});

// Dos requests reales con la misma clave vencida, con el lock del usuario como barrera: los dos
// llegan a decidir bajo el lock, uno detrás del otro (nunca setTimeout para coordinar).
describe('7. dos requests a la vez sobre la misma clave vencida', () => {
  /** Envía los dos requests mientras el lock está tomado y lo suelta cuando los dos lo esperan. */
  async function race(u: number, k: string, bodies: [unknown, unknown]) {
    const a = await admin.connect();
    try {
      await a.query('BEGIN');
      await a.query(userLock, [u]);
      const pending = bodies.map((b) => order(b, k));
      await waiting(u, 2);
      await a.query('COMMIT');
      return Promise.all(pending);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
    }
  }

  it('mismo body → uno crea (201, replay false) y el otro es replay de esa orden; una sola orden nueva y una fila', async () => {
    const u = await newUser('ttl-carrera');
    const k = key();
    const first = await order(cashIn(u), k);
    expect(first.status).toBe(201);
    await age(u, k, '25 hours');

    const rs = (await race(u, k, [cashIn(u), cashIn(u)])).sort((x, y) => x.replay!.localeCompare(y.replay!));
    expect(rs.map((r) => [r.status, r.replay])).toEqual([[201, 'false'], [201, 'true']]);
    expect(rs[1].body).toEqual(rs[0].body);
    expect(rs[0].body.id).not.toBe(first.body.id);
    expect(await row(u, k)).toMatchObject({ order_id: rs[0].body.id, response_body: rs[0].body });
    expect(await rows(u, k)).toBe(1);
    expect(await ordersOf(u)).toBe(2);
  });

  it('bodies distintos → un 201 y un 422 IDEMPOTENCY_MISMATCH; una sola orden nueva y una fila', async () => {
    const u = await newUser('ttl-carrera-mismatch');
    const k = key();
    const first = await order(cashIn(u, '1.00'), k);
    expect(first.status).toBe(201);
    await age(u, k, '25 hours');

    const rs = (await race(u, k, [cashIn(u, '2.00'), cashIn(u, '3.00')])).sort((x, y) => x.status - y.status);
    expect(rs.map((r) => r.status)).toEqual([201, 422]);
    expect(rs[0].replay).toBe('false');
    expect(['2.00', '3.00']).toContain(rs[0].body.amount);
    expect(rs[1].body.error).toBe('IDEMPOTENCY_MISMATCH');
    expect(await row(u, k)).toMatchObject({ request_hash: cashInHash(u, rs[0].body.amount), order_id: rs[0].body.id, response_body: rs[0].body });
    expect(await rows(u, k)).toBe(1);
    expect(await ordersOf(u)).toBe(2);
  });
});
