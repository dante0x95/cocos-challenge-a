// Issue #7: un corte de conexión con la base responde 503 CONNECTION_LOST con Retry-After, y el
// reintento con la misma Idempotency-Key resuelve el resultado desconocido (D-20): replay si la
// orden se confirmó, orden nueva si no. Antes, todo esto era 500 INTERNAL sin guía. El corte
// después del commit (respuesta perdida) está en connection-lost-response.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { admin, apiClient, newUser } from '../support/db.js';

// Literal, no importado del código: el contrato del mensaje (resultado desconocido, D-20).
const CONNECTION_LOST_MESSAGE = 'la conexión con la base se cortó; el resultado es desconocido: reintentar con la misma Idempotency-Key';

let server: Server;
let base: string;

beforeAll(async () => {
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

describe('lecturas y conexiones ociosas', () => {
  it('GET /portfolio en vuelo cuyo backend se termina → 503 CONNECTION_LOST con Retry-After; el GET siguiente responde 200 (conexión nueva)', async () => {
    const u = await newUser('lost-read');
    // Barrera real: app.read_portfolio lee app.users, que `lock` tiene tomada en ACCESS EXCLUSIVE.
    const lock = await admin.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE app.users IN ACCESS EXCLUSIVE MODE');
      const pending = quiet(() => fetch(`${base}/portfolio/${u}`));
      let pid: number | undefined;
      for (let i = 0; i < 2000 && pid === undefined; i++) {
        pid = (await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = 'cocos-api' AND wait_event_type = 'Lock' AND wait_event = 'relation' AND query LIKE '%read_portfolio%'")).rows[0]?.pid;
        if (pid === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      expect(pid).toBeDefined();
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      const r = await pending;
      expect({ status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json() })
        .toEqual({ status: 503, retryAfter: '1', body: { error: 'CONNECTION_LOST', message: CONNECTION_LOST_MESSAGE } });
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    expect((await fetch(`${base}/portfolio/${u}`)).status).toBe(200);
  });

  it('una conexión ociosa muerta no le toca a ninguna request: dos GET seguidos responden 200', async () => {
    const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;   // vuelve al pool, ociosa
    const errored = new Promise((resolve) => pool.once('error', resolve));
    await quiet(async () => { await admin.query('SELECT pg_terminate_backend($1)', [pid]); await errored; });
    const [a, b] = await Promise.all([fetch(`${base}/portfolio/1`), fetch(`${base}/portfolio/1`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});
