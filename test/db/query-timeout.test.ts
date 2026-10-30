// Issue #11: sin query_timeout, una consulta cuya respuesta se pierde (red que descarta sin cerrar
// el socket) esperaba para siempre y ocupaba su conexión del pool. Este archivo levanta la API con
// la base detrás de un proxy TCP que puede quedarse con las respuestas, así que importa la app
// después de fijar DATABASE_URL y un plazo corto.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { TEST_ADMIN_URL, TEST_API_URL } from '../support/urls.js';

const QUERY_TIMEOUT_MS = 1500;
const POOL_MAX = 10;

/** Proxy hacia Postgres. `swallow(n)`: las próximas n consultas reciben su petición pero no su respuesta. */
function proxy(target: { host: string; port: number }) {
  let toSwallow = 0;
  const srv = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    let swallowing = false;
    client.on('data', (chunk: Buffer) => {
      if (!swallowing && toSwallow > 0 && (chunk[0] === 0x51 || chunk[0] === 0x50)) { swallowing = true; toSwallow--; }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => { if (!swallowing) client.write(chunk); });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
  });
  return {
    listen: () => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port))),
    swallow: (n: number) => { toSwallow = n; },
    close: () => srv.close(),
  };
}

const target = new URL(TEST_API_URL);
const px = proxy({ host: target.hostname, port: Number(target.port || 5432) });
const admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 2 });
let server: Server;
let base: string;
let pool: pg.Pool;
let fromDbError: (e: unknown) => { status: number; code: string; retryAfter?: number };

beforeAll(async () => {
  const port = await px.listen();
  const url = new URL(TEST_API_URL); url.hostname = '127.0.0.1'; url.port = String(port);
  process.env.DATABASE_URL = url.toString();
  process.env.PG_QUERY_TIMEOUT_MS = String(QUERY_TIMEOUT_MS);
  process.env.PG_POOL_MAX = String(POOL_MAX);
  process.env.PG_CONNECT_TIMEOUT_MS = '1000';
  ({ pool } = await import('../../src/db/pool.js'));
  ({ fromDbError } = await import('../../src/http/errors.js'));
  const { createApp } = await import('../../src/app.js');
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await pool.end(); await admin.end(); px.close(); });

const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn; const e = console.error;
  console.warn = () => undefined; console.error = () => undefined;
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};
const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, string> }; };
const post = async (u: number, key: string) => {
  const r = await fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ userid: u, side: 'CASH_IN', amount: '10.00' }) });
  return { status: r.status, replay: r.headers.get('idempotent-replay'), body: (await r.json()) as Record<string, string> };
};
const newUser = async () => (await admin.query<{ id: number }>(
  "INSERT INTO app.users (email, accountnumber) VALUES ($1, $2) RETURNING id", [`qt-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, String(Date.now()).slice(-10)])).rows[0].id;

describe('query_timeout: la respuesta de la base no llega', () => {
  it('GET /portfolio termina en 503 TIMEOUT en el plazo local, la conexión no vuelve al pool y la siguiente request responde 200', async () => {
    await get('/portfolio/1');                                  // una conexión ociosa en el pool
    const before = pool.totalCount;
    px.swallow(1);
    const t0 = Date.now();
    const r = await quiet(() => get('/portfolio/1'));
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ status: 503, retryAfter: '1', body: { error: 'TIMEOUT' } });
    expect(r.body.message).toMatch(/desconocido.*misma Idempotency-Key/);
    expect(ms).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(QUERY_TIMEOUT_MS + 1000);
    expect(pool.totalCount).toBe(before - 1);                   // destruida, no devuelta
    expect((await get('/portfolio/1')).status).toBe(200);
  });

  it('POST /orders confirmado en la base con la respuesta perdida → 503; el reintento con la misma clave es replay y hay una sola orden', async () => {
    const u = await newUser();
    px.swallow(1);
    const r = await quiet(() => post(u, 'k'));
    expect(r.status).toBe(503);
    expect((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n).toBe(1);
    const retry = await post(u, 'k');
    expect(retry).toMatchObject({ status: 201, replay: 'true' });
    expect((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n).toBe(1);
  });

  it('con el pool entero colgado (PG_POOL_MAX requests), todas terminan en 503 al vencer el plazo y la request siguiente responde 200', async () => {
    px.swallow(POOL_MAX);
    const results = await quiet(() => Promise.all(Array.from({ length: POOL_MAX }, () => get('/portfolio/1'))));
    expect(results.map((r) => r.status)).toEqual(Array(POOL_MAX).fill(503));
    expect(results.every((r) => r.body.error === 'TIMEOUT')).toBe(true);
    expect((await get('/portfolio/1')).status).toBe(200);       // el pool se recuperó solo
  }, 30_000);

  it('después del plazo no queda ninguna sesión activa de la API en la base (la sentencia ya había terminado)', async () => {
    px.swallow(1);
    await quiet(() => get('/portfolio/1'));
    await new Promise((r) => setTimeout(r, 300));
    const active = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'cocos-api' AND state = 'active'")).rows[0].n;
    expect(active).toBe(0);
  });
});

describe('el orden de los dos relojes', () => {
  it('una sentencia lenta con la base sana vence por statement_timeout de la base (57014), no por el plazo local', async () => {
    // El rol api tiene statement_timeout = 5 s; el plazo local de este archivo es más corto a propósito,
    // así que acá se sube para la prueba: la base debe ganar.
    const slow = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, query_timeout: 8000 });
    try {
      const err = await slow.query('SELECT pg_sleep(6)').then(() => null, (e) => e as { code?: string });
      expect(err?.code).toBe('57014');
      const e = fromDbError(err);
      expect({ status: e.status, code: e.code }).toEqual({ status: 503, code: 'TIMEOUT' });
    } finally { await slow.end(); }
  }, 15_000);
});
