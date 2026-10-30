// Issue #5: una conexión ociosa del pool que el servidor corta emitía 'error' sin listener y el
// proceso salía con código 1. En archivo propio: si el listener faltara, vitest reportaría la
// excepción no capturada y este archivo fallaría solo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { admin } from '../support/db.js';

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

/** Resuelve con el error cuando el pool emite 'error' (una conexión ociosa cortada). */
const nextPoolError = () => new Promise<Error>((resolve) => pool.once('error', resolve));

describe('una conexión ociosa cortada por el servidor', () => {
  it('emite error en el pool, el proceso sigue, la conexión sale del pool y la siguiente consulta usa otro backend', async () => {
    const p = await pid();                      // la consulta terminó: la conexión volvió al pool, ociosa
    const total = pool.totalCount;
    const logged: string[] = [];
    const orig = console.error;
    console.error = (m: string) => { logged.push(String(m)); };
    try {
      const errored = nextPoolError();
      await admin.query('SELECT pg_terminate_backend($1)', [p]);
      const err = await errored;                // sin setTimeout: el evento es la señal
      expect(String(err)).toMatch(/terminating connection/);
      expect(pool.totalCount).toBe(total - 1);
    } finally { console.error = orig; }
    // El log del evento es una línea JSON del mismo formato que el resto de la API, sin connection string.
    const line = logged.find((l) => l.includes('pg-pool-idle'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ level: 'error', scope: 'pg-pool-idle' });
    expect(line).not.toContain('postgresql://');
    expect(await pid()).not.toBe(p);
  });

  it('listener registrado sobre el pool exportado (que no vuelva)', () => {
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });
});

describe('reinicio completo: todas las conexiones de la API cortadas a la vez', () => {
  it('el proceso sigue, se emite un error por conexión ociosa y las requests siguientes responden 200', async () => {
    // Varias conexiones ociosas a la vez.
    await Promise.all([1, 2, 3].map(() => pool.query('SELECT pg_sleep(0.05)')));
    const pids = await apiPids();
    expect(pids.length).toBeGreaterThanOrEqual(3);
    const orig = console.error;
    console.error = () => undefined;
    try {
      const errors: Promise<Error>[] = pids.map(() => nextPoolError());
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', ['cocos-api']);
      await Promise.all(errors);
      // Un evento por conexión; las últimas pueden tardar un instante en salir del pool.
      for (let i = 0; i < 200 && pool.totalCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    } finally { console.error = orig; }
    expect(pool.totalCount).toBe(0);
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const results = await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/portfolio/1`)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });
});
