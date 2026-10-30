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
// Literal, no importado del código: el contrato del mensaje (resultado desconocido, D-20).
const TIMEOUT_BODY = { error: 'TIMEOUT', message: 'la base no respondió a tiempo; el resultado es desconocido: reintentar con la misma Idempotency-Key' };

/**
 * Proxy hacia Postgres. `swallow(n)`: las próximas n consultas reciben su petición pero no su
 * respuesta. `delay(ms)`: la próxima consulta recibe su respuesta, pero ms después de que llega.
 */
function proxy(target: { host: string; port: number }) {
  let toSwallow = 0;
  let nextDelay = 0;
  const srv = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    let swallowing = false;
    let delayMs = 0;
    client.on('data', (chunk: Buffer) => {
      if (!swallowing && delayMs === 0 && (chunk[0] === 0x51 || chunk[0] === 0x50)) {   // 'Q' simple / 'P' parse
        if (toSwallow > 0) { swallowing = true; toSwallow--; } else if (nextDelay > 0) { delayMs = nextDelay; nextDelay = 0; }
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (swallowing) return;
      if (delayMs > 0) { setTimeout(() => { if (!client.destroyed) client.write(chunk); }, delayMs); return; }
      client.write(chunk);
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
  });
  return {
    listen: () => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port))),
    swallow: (n: number) => { toSwallow = n; },
    delay: (ms: number) => { nextDelay = ms; },
    close: () => srv.close(),
  };
}

const target = new URL(TEST_API_URL);
const px = proxy({ host: target.hostname, port: Number(target.port || 5432) });
const admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 2 });
let server: Server;
let base: string;
let pool: pg.Pool;

beforeAll(async () => {
  const port = await px.listen();
  const url = new URL(TEST_API_URL); url.hostname = '127.0.0.1'; url.port = String(port);
  process.env.DATABASE_URL = url.toString();
  process.env.PG_QUERY_TIMEOUT_MS = String(QUERY_TIMEOUT_MS);
  process.env.PG_POOL_MAX = String(POOL_MAX);
  process.env.PG_CONNECT_TIMEOUT_MS = '1000';
  ({ pool } = await import('../../src/db/pool.js'));
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
  return { status: r.status, replay: r.headers.get('idempotent-replay'), retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, string> };
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
    expect(r).toEqual({ status: 503, retryAfter: '1', body: TIMEOUT_BODY });
    expect(ms).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(QUERY_TIMEOUT_MS + 1000);
    expect(pool.totalCount).toBe(before - 1);                   // destruida, no devuelta
    expect((await get('/portfolio/1')).status).toBe(200);
  });

  it('POST /orders confirmado en la base con la respuesta perdida → 503; el reintento con la misma clave es replay y hay una sola orden', async () => {
    const u = await newUser();
    px.swallow(1);
    const r = await quiet(() => post(u, 'k'));
    expect(r).toEqual({ status: 503, replay: null, retryAfter: '1', body: TIMEOUT_BODY });
    expect((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n).toBe(1);
    const retry = await post(u, 'k');
    expect(retry).toMatchObject({ status: 201, replay: 'true' });
    expect((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n).toBe(1);
  });

  it('con el pool entero colgado (PG_POOL_MAX requests), todas terminan en 503 al vencer el plazo y la request siguiente responde 200', async () => {
    px.swallow(POOL_MAX);
    const results = await quiet(() => Promise.all(Array.from({ length: POOL_MAX }, () => get('/portfolio/1'))));
    expect(results).toEqual(Array(POOL_MAX).fill({ status: 503, retryAfter: '1', body: TIMEOUT_BODY }));
    expect((await get('/portfolio/1')).status).toBe(200);       // el pool se recuperó solo
  }, 30_000);

  it('después del plazo no queda ninguna sesión activa de la API en la base (la sentencia ya había terminado)', async () => {
    px.swallow(1);
    await quiet(() => get('/portfolio/1'));
    await new Promise((r) => setTimeout(r, 300));
    const active = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'cocos-api' AND state = 'active'")).rows[0].n;
    expect(active).toBe(0);
  });

  it('una respuesta que llega justo después del plazo: un solo 503, sin errores no manejados, y la siguiente request responde 200 por otra conexión', async () => {
    await get('/portfolio/1');
    const before = pool.totalCount;
    const poolErrors: Error[] = [];
    const onError = (e: Error) => { poolErrors.push(e); };
    pool.on('error', onError);
    try {
      // El proxy entrega la respuesta QUERY_TIMEOUT_MS después de recibirla: su reloj arrancó después
      // del del driver, así que la respuesta llega cuando el plazo local ya venció y la conexión se
      // está cerrando.
      px.delay(QUERY_TIMEOUT_MS);
      const r = await quiet(() => get('/portfolio/1'));
      expect(r).toEqual({ status: 503, retryAfter: '1', body: TIMEOUT_BODY });
      await new Promise((res) => setTimeout(res, 200));   // la respuesta tardía ya llegó y se descartó
      expect(pool.totalCount).toBe(before - 1);
      const next = await get('/portfolio/1');
      expect(next.status).toBe(200);
    } finally { pool.off('error', onError); }
    expect(poolErrors).toEqual([]);
  });

  it('POST /orders vence el plazo local esperando el lock (antes del commit); el reintento con la misma clave, con la primera ejecución pendiente, resuelve en una sola orden', async () => {
    const u = await newUser();
    // Barrera real, por fuera del proxy: el lock de usuario que espera place_order (lock_timeout 2 s,
    // más que el plazo local de este archivo).
    const barrier = new pg.Client({ connectionString: TEST_API_URL });
    await barrier.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [u]);
      const first = await quiet(() => post(u, 'k'));
      expect(first).toEqual({ status: 503, replay: null, retryAfter: '1', body: TIMEOUT_BODY });
      // La primera ejecución sigue en la base, esperando el lock. El reintento queda detrás.
      const retry = post(u, 'k');
      await barrier.query('ROLLBACK');
      expect(await retry).toMatchObject({ status: 201, replay: 'true' });
    } finally { await barrier.end(); }
    expect((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n).toBe(1);
  });
});
