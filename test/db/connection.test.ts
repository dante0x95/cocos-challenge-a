// Issue #7: un corte de conexión con la base responde 503 CONNECTION_LOST con Retry-After, y el
// reintento con la misma Idempotency-Key resuelve el resultado desconocido (D-20): replay si la
// orden se confirmó, orden nueva si no. Antes, todo esto era 500 INTERNAL sin guía.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { fromDbError } from '../../src/http/errors.js';
import { admin, apiClient, arsId, newUser } from '../support/db.js';
import { TEST_API_URL } from '../support/urls.js';

let server: Server;
let base: string;
let ars: number;

beforeAll(async () => {
  ars = await arsId();
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await admin.end(); await pool.end(); });

const post = async (u: number, key: string) => {
  const r = await fetch(`${base}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ userid: u, side: 'CASH_IN', amount: '100.00' }) });
  return { status: r.status, replay: r.headers.get('idempotent-replay'), retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, string> };
};
const ordersOf = async (u: number) =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n;
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn; const e = console.error;
  console.warn = () => undefined; console.error = () => undefined;
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

describe('corte antes del commit', () => {
  it('POST /orders esperando el lock, su backend terminado → 503 CONNECTION_LOST; reintento con la misma clave → 201 nuevo, una orden', async () => {
    const u = await newUser('lost-before');
    const a = await apiClient();
    try {
      await a.query('BEGIN');
      await a.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);
      const pending = quiet(() => post(u, 'k'));
      // La escritura está esperando el lock: una sesión cocos-api bloqueada en un advisory lock.
      let pid: number | undefined;
      for (let i = 0; i < 2000 && pid === undefined; i++) {
        const r = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = 'cocos-api' AND wait_event_type = 'Lock' AND wait_event = 'advisory'");
        pid = r.rows[0]?.pid;
        if (pid === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      expect(pid).toBeDefined();
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      const r = await pending;
      expect(r).toMatchObject({ status: 503, retryAfter: '1', body: { error: 'CONNECTION_LOST' } });
      expect(r.body.message).toMatch(/misma Idempotency-Key/);
      await a.query('ROLLBACK');
    } finally { await a.end(); }
    expect(await ordersOf(u)).toBe(0);
    const retry = await post(u, 'k');
    expect(retry).toMatchObject({ status: 201, replay: 'false' });
    expect(await ordersOf(u)).toBe(1);
  });
});

describe('corte después del commit: la respuesta se pierde', () => {
  /**
   * Proxy TCP hacia Postgres que, al ver la primera sentencia del cliente (mensaje 'Q' o 'P'),
   * deja pasar la petición, espera la respuesta del servidor y en vez de reenviarla corta el
   * socket del cliente: la base confirmó, el cliente no se enteró.
   */
  function lossyProxy(target: { host: string; port: number }): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
      const srv = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        let armed = false;
        client.on('data', (chunk: Buffer) => {
          if (!armed && (chunk[0] === 0x51 || chunk[0] === 0x50)) armed = true;   // 'Q' simple query / 'P' parse (extended)
          upstream.write(chunk);
        });
        upstream.on('data', (chunk: Buffer) => {
          if (armed) { client.destroy(); upstream.end(); return; }
          client.write(chunk);
        });
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.on('error', () => undefined);
        upstream.on('error', () => undefined);
      });
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() }));
    });
  }

  it('la escritura se confirma, el cliente recibe el corte → 503 CONNECTION_LOST; reintento con la misma clave → replay, una orden', async () => {
    const u = await newUser('lost-after');
    const target = new URL(TEST_API_URL);
    const proxy = await lossyProxy({ host: target.hostname, port: Number(target.port || 5432) });
    const url = new URL(TEST_API_URL); url.hostname = '127.0.0.1'; url.port = String(proxy.port);
    const c = new pg.Client({ connectionString: url.toString() });
    c.on('error', () => undefined);
    try {
      await c.connect();
      const hash = 'h';
      let error: unknown;
      try {
        await c.query('SELECT app.place_order($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r', [u, 'k', hash, 'CASH_IN', 'MARKET', ars, null, '100.00', null]);
      } catch (e) { error = e; }
      expect(error).toBeDefined();
      const e = fromDbError(error);
      expect({ status: e.status, code: e.code, retryAfter: e.retryAfter }).toEqual({ status: 503, code: 'CONNECTION_LOST', retryAfter: 1 });
    } finally { await c.end().catch(() => undefined); proxy.close(); }
    // La base sí confirmó: una orden, y el reintento con la misma clave la devuelve como replay.
    expect(await ordersOf(u)).toBe(1);
    const r = (await pool.query<{ r: { replay: boolean; status: number } }>(
      'SELECT app.place_order($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r', [u, 'k', 'h', 'CASH_IN', 'MARKET', ars, null, '100.00', null])).rows[0].r;
    expect(r).toMatchObject({ replay: true, status: 201 });
    expect(await ordersOf(u)).toBe(1);
  });
});

describe('lecturas y conexiones ociosas', () => {
  it('una consulta en vuelo cuyo backend se termina → 503 CONNECTION_LOST; la siguiente responde (conexión nueva)', async () => {
    const running = quiet(() => pool.query('SELECT pg_sleep(5)'));
    let pid: number | undefined;
    for (let i = 0; i < 2000 && pid === undefined; i++) {
      pid = (await admin.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = 'cocos-api' AND query LIKE 'SELECT pg_sleep%' AND state = 'active'")).rows[0]?.pid;
      if (pid === undefined) await new Promise((r) => setTimeout(r, 5));
    }
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    const e = fromDbError(await running.then(() => null, (err) => err));
    expect({ status: e.status, code: e.code }).toEqual({ status: 503, code: 'CONNECTION_LOST' });
    expect((await fetch(`${base}/portfolio/1`)).status).toBe(200);
  });

  it('una conexión ociosa muerta no le toca a ninguna request: dos GET seguidos responden 200', async () => {
    const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;   // vuelve al pool, ociosa
    const errored = new Promise((resolve) => pool.once('error', resolve));
    await quiet(async () => { await admin.query('SELECT pg_terminate_backend($1)', [pid]); await errored; });
    const [a, b] = await Promise.all([fetch(`${base}/portfolio/1`), fetch(`${base}/portfolio/1`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});
