// Tiempos de una escritura (D-20), por HTTP contra Postgres real: lock_timeout, statement_timeout,
// espera por una conexión del pool, y la regresión del issue #1 (una cancelación pendiente de un
// request alcanzaba al siguiente que usaba la misma conexión).
//
// El pool de este archivo tiene 2 conexiones: las pruebas retienen una o las dos para controlar
// qué conexión toma cada request. Se configura antes de importar la API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type pg from 'pg';
import { admin, newUser } from '../support/db.js';

process.env.PG_POOL_MAX = '2';
process.env.PG_CONNECT_TIMEOUT_MS = '2000';
// Deadline de la versión anterior (withTx + pg_cancel_backend). La versión actual no lo lee; se
// fija para que la regresión reproduzca el defecto contra esa versión sin esperar 4 s.
process.env.REQUEST_DEADLINE_MS = '300';
const { createApp } = await import('../../src/app.js');
const { pool } = await import('../../src/db/pool.js');

let server: Server;
let base: string;

beforeAll(() => {
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
  await admin.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cashIn(userid: number, key: string) {
  const r = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ userid, side: 'CASH_IN', amount: '1.00' }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, string> };
}

/** Transacción de admin que retiene el lock de un usuario hasta COMMIT. */
async function holdUserLock(userid: number): Promise<pg.PoolClient> {
  const c = await admin.connect();
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [userid]);
  return c;
}
async function release(c: pg.PoolClient) {
  await c.query('COMMIT');
  c.release();
}

/** Espera a que alguna sesión esté bloqueada esperando el lock de este usuario. */
async function waitingOnUserLock(userid: number) {
  for (;;) {
    const r = await admin.query(
      "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND objid::bigint = $1 AND NOT granted", [userid]);
    if (r.rowCount) return;
    await sleep(5);
  }
}

async function nothingWritten(userid: number, key: string) {
  expect((await admin.query('SELECT 1 FROM app.orders WHERE userid = $1', [userid])).rowCount).toBe(0);
  expect((await admin.query('SELECT 1 FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [userid, key])).rowCount).toBe(0);
}

describe('POST /orders — tiempos máximos (D-20)', () => {
  it('lock retenido más que el lock_timeout (2 s) → 503 LOCK_TIMEOUT con Retry-After, sin orden ni clave', async () => {
    const u = await newUser('lt');
    const lock = await holdUserLock(u);
    try {
      const r = await cashIn(u, 'lt');
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('LOCK_TIMEOUT');
      expect(r.retryAfter).toBe('1');
    } finally { await release(lock); }
    await nothingWritten(u, 'lt');
  });

  it('place_order más larga que el statement_timeout del rol api (5 s) → 503 TIMEOUT, sin orden ni clave', async () => {
    const u = await newUser('st');
    // Lentitud inyectada al insertar la orden: la clave ya está reclamada cuando vence el tiempo,
    // así que la prueba también muestra que el reclamo se revierte.
    await admin.query(`CREATE FUNCTION app.test_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(30); RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER test_slow_insert BEFORE INSERT ON app.orders
      FOR EACH ROW WHEN (NEW.userid = ${u}) EXECUTE FUNCTION app.test_slow_insert()`);
    try {
      const t0 = Date.now();
      const r = await cashIn(u, 'st');
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('TIMEOUT');
      expect(r.retryAfter).toBe('1');
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      await admin.query('DROP TRIGGER test_slow_insert ON app.orders');
      await admin.query('DROP FUNCTION app.test_slow_insert()');
    }
    await nothingWritten(u, 'st');
  });

  it('sin conexión libre en el pool durante PG_CONNECT_TIMEOUT_MS → 503 TIMEOUT, sin orden ni clave', async () => {
    const u = await newUser('ct');
    const held = [await pool.connect(), await pool.connect()];
    try {
      const r = await cashIn(u, 'ct');
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('TIMEOUT');
      expect(r.retryAfter).toBe('1');
    } finally { held.forEach((c) => c.release()); }
    await nothingWritten(u, 'ct');
  });

  it('regresión: una escritura que pasó el umbral no cancela al request siguiente que toma su conexión', async () => {
    // Con la versión anterior: el deadline de A vence mientras A espera el lock; el
    // pg_cancel_backend(pid de A) queda encolado porque el pool está lleno. A termina bien y B
    // toma su conexión (mismo pid). Cuando se libera otra conexión, el cancel corre y le da 57014
    // a B. Con una sola sentencia por escritura no hay ningún cancel que pueda quedar pendiente.
    const u = await newUser('slow');
    const v = await newUser('next');
    const held = await pool.connect();          // queda una sola conexión libre: la de A, después B
    const lockU = await holdUserLock(u);
    const lockV = await holdUserLock(v);
    let heldReleased = false;
    let a!: ReturnType<typeof cashIn>;
    let b!: ReturnType<typeof cashIn>;
    try {
      a = cashIn(u, 'a');
      await waitingOnUserLock(u);               // A tiene la conexión y espera el lock de u
      b = cashIn(v, 'b');                       // B espera una conexión libre
      // El umbral es de tiempo por definición. La versión anterior encolaba su cancel a los 300 ms
      // (waitingCount pasa a 2); la actual no encola nada, y A sigue por debajo del lock_timeout.
      for (const t0 = Date.now(); pool.waitingCount < 2 && Date.now() - t0 < 800;) await sleep(5);
      await release(lockU);                     // A termina; B toma su conexión
      await waitingOnUserLock(v);               // B ya está dentro de place_order, en esa conexión
      held.release();                           // la versión anterior corría acá el cancel pendiente
      heldReleased = true;
      while (pool.idleCount < 1) await sleep(5); // ...y esta conexión vuelve libre cuando terminó
    } finally {
      if (!heldReleased) held.release();
      await release(lockV);
    }
    expect((await a).status).toBe(201);
    expect(await b).toMatchObject({ status: 201, body: { status: 'FILLED' } });
  });
});
