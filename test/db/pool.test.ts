// Issue #5: una conexión ociosa del pool que el servidor corta emitía 'error' sin listener y el
// proceso salía con código 1. En archivo propio: si el listener faltara, vitest reportaría la
// excepción no capturada y este archivo fallaría solo.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { CONNECTION_LOST_MESSAGE } from '../../src/http/errors.js';
import { admin, apiClient, newUser } from '../support/db.js';
import { TEST_DB } from '../support/urls.js';

let server: Server;
let base: string;
beforeAll(() => {
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await admin.end(); await pool.end(); });

const pid = async () => (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
const apiPids = async () =>
  (await admin.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = 'cocos-api'")).rows.map((r) => r.pid);
const terminateApi = () => admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'cocos-api'");

/** Resuelve con el error cuando el pool emite 'error' (una conexión ociosa cortada). */
const nextPoolError = () => new Promise<Error>((resolve) => pool.once('error', resolve));

/** Resuelve con los n errores que emite el pool: uno por evento, no el mismo primero n veces. */
function poolErrors(n: number): Promise<Error[]> {
  return new Promise((resolve) => {
    const seen: Error[] = [];
    const onError = (err: Error) => {
      seen.push(err);
      if (seen.length === n) { pool.off('error', onError); resolve(seen); }
    };
    pool.on('error', onError);
  });
}

const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => undefined;
  try { return await fn(); } finally { console.error = e; }
};

describe('una conexión ociosa cortada por el servidor', () => {
  it('emite error en el pool, el proceso sigue, la conexión sale del pool y la siguiente consulta usa otro backend', async () => {
    const p = await pid();                      // la consulta terminó: la conexión volvió al pool, ociosa
    const total = pool.totalCount;
    const logged: string[] = [];
    const orig = console.error;
    console.error = (m: string) => { logged.push(String(m)); };
    let err: Error;
    try {
      const errored = nextPoolError();
      await admin.query('SELECT pg_terminate_backend($1)', [p]);
      err = await errored;                      // sin setTimeout: el evento es la señal
      expect(String(err)).toMatch(/terminating connection/);
      expect(pool.totalCount).toBe(total - 1);
    } finally { console.error = orig; }
    // El log del evento es una línea JSON del mismo formato que el resto de la API: solo nivel,
    // scope y el mensaje del error. Sin stack, sin datos del cliente ni connection string.
    const line = logged.find((l) => l.includes('pg-pool-idle'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({ level: 'error', scope: 'pg-pool-idle', err: 'error: terminating connection due to administrator command' });
    expect(line).not.toMatch(/\bat |postgres(ql)?:\/\//);
    expect(await pid()).not.toBe(p);
  });

  it('listener registrado sobre el pool exportado (que no vuelva)', () => {
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });
});

describe('keepalive', () => {
  it('cada conexión nueva del pool activa las sondas TCP con la demora configurada', async () => {
    const spy = vi.spyOn(net.Socket.prototype, 'setKeepAlive');
    try {
      // Una más que las ociosas: al menos una es una conexión nueva del pool exportado.
      const clients = await Promise.all(Array.from({ length: pool.idleCount + 1 }, () => pool.connect()));
      clients.forEach((c) => c.release());
      expect(spy).toHaveBeenCalledWith(true, 10_000);
    } finally { spy.mockRestore(); }
  });
});

describe('reinicio completo: todas las conexiones de la API cortadas a la vez', () => {
  it('el proceso sigue, se emite un error por conexión ociosa y las requests siguientes responden 200', async () => {
    // Varias conexiones ociosas a la vez.
    await Promise.all([1, 2, 3].map(() => pool.query('SELECT pg_sleep(0.05)')));
    const pids = await apiPids();
    expect(pids.length).toBeGreaterThanOrEqual(3);
    expect(pool.totalCount).toBe(pids.length);
    const errors = await quiet(async () => {
      const all = poolErrors(pids.length);
      await terminateApi();
      return all;
    });
    // Un evento por conexión, y cada uno ya sacó a su cliente del pool.
    expect(errors).toHaveLength(pids.length);
    expect(pool.totalCount).toBe(0);
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const results = await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/portfolio/1`)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });
});

describe('GET /health mientras la base no acepta conexiones', () => {
  it('responde 503 { ok: false, db: "down" } y vuelve a 200 sola, en la misma instancia', async () => {
    // La base rechaza conexiones nuevas del rol api (sin CONNECT) y se cortan las que había: la
    // misma ventana que un reinicio, sin apagar el servidor que comparten las pruebas.
    await admin.query(`REVOKE CONNECT ON DATABASE ${TEST_DB} FROM PUBLIC`);
    try {
      await quiet(terminateApi);
      const down = await quiet(() => fetch(`${base}/health`));
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ ok: false, db: 'down' });
    } finally {
      await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DB} TO PUBLIC`);
    }
    const up = await fetch(`${base}/health`);
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ ok: true, db: 'up' });
  });
});

describe('una request con la consulta en vuelo cuando se corta su conexión', () => {
  it('POST /orders esperando el lock, su backend terminado → 503 CONNECTION_LOST; el proceso sigue y el reintento con la misma clave crea una orden', async () => {
    const u = await newUser('pool-inflight');
    const post = async () => {
      const r = await fetch(`${base}/orders`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k' },
        body: JSON.stringify({ userid: u, side: 'CASH_IN', amount: '100.00' }) });
      return { status: r.status, retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, string> };
    };
    const ordersOf = async () =>
      (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n;
    const a = await apiClient();
    try {
      await a.query('BEGIN');
      await a.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);
      const pending = quiet(post);
      // Barrera real: la escritura está en vuelo, esperando el advisory lock que tiene `a`.
      let target: number | undefined;
      for (let i = 0; i < 2000 && target === undefined; i++) {
        target = (await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = 'cocos-api' AND wait_event_type = 'Lock' AND wait_event = 'advisory'")).rows[0]?.pid;
        if (target === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      expect(target).toBeDefined();
      await admin.query('SELECT pg_terminate_backend($1)', [target]);
      // Lo que publica docs/api/operacion.md: 503 CONNECTION_LOST, resultado desconocido (issue #7).
      expect(await pending).toEqual({ status: 503, retryAfter: '1', body: { error: 'CONNECTION_LOST', message: CONNECTION_LOST_MESSAGE } });
      await a.query('ROLLBACK');
    } finally { await a.end(); }
    expect(await ordersOf()).toBe(0);
    expect((await post()).status).toBe(201);
    expect(await ordersOf()).toBe(1);
  });
});
