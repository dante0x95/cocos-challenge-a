// Issue #7, por HTTP: la base confirma la escritura y la respuesta se pierde en el camino. La API
// habla con Postgres a través de un proxy TCP que, cuando se lo pide el test, deja pasar la
// sentencia y corta el socket en vez de reenviar la respuesta. En archivo propio: el pool de la
// API se crea al importar src/db/pool.ts con DATABASE_URL apuntando al proxy.
import { afterAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { Server } from 'node:http';
import { admin, newUser } from '../support/db.js';
import { TEST_API_URL } from '../support/urls.js';

/**
 * Proxy TCP hacia Postgres. Con `dropNext` en true, la próxima conexión que envía una sentencia
 * (mensaje 'Q' o 'P') la deja pasar, espera la respuesta del servidor y en vez de reenviarla corta
 * el socket del cliente: la base confirmó, el cliente no se enteró.
 */
function lossyProxy(target: { host: string; port: number }): Promise<{ port: number; dropNext: () => void; close: () => void }> {
  let drop = false;
  return new Promise((resolve) => {
    const srv = net.createServer((client) => {
      const upstream = net.connect(target.port, target.host);
      let armed = false;
      client.on('data', (chunk: Buffer) => {
        if (drop && !armed && (chunk[0] === 0x51 || chunk[0] === 0x50)) { armed = true; drop = false; }   // 'Q' simple / 'P' parse
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
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as { port: number }).port,
      dropNext: () => { drop = true; },
      close: () => srv.close(),
    }));
  });
}

const target = new URL(TEST_API_URL);
const proxy = await lossyProxy({ host: target.hostname, port: Number(target.port || 5432) });
const viaProxy = new URL(TEST_API_URL); viaProxy.hostname = '127.0.0.1'; viaProxy.port = String(proxy.port);
process.env.DATABASE_URL = viaProxy.toString();
const { createApp } = await import('../../src/app.js');
const { pool } = await import('../../src/db/pool.js');
const { CONNECTION_LOST_MESSAGE } = await import('../../src/http/errors.js');

const server: Server = createApp({ internalToken: 'test-token' }).listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
afterAll(async () => { server.close(); await pool.end(); await admin.end(); proxy.close(); });

const post = async (u: number, key: string) => {
  const r = await fetch(`${base}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ userid: u, side: 'CASH_IN', amount: '100.00' }) });
  return { status: r.status, replay: r.headers.get('idempotent-replay'), retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, string> };
};
const ordersOf = async (u: number) =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n;

describe('corte después del commit: la respuesta se pierde', () => {
  it('POST /orders: la escritura se confirma y la API pierde la respuesta → 503 CONNECTION_LOST; el mismo POST con la misma clave → replay, una orden', async () => {
    const u = await newUser('lost-after');
    proxy.dropNext();
    const w = console.warn; console.warn = () => undefined;
    let lost;
    try { lost = await post(u, 'k'); } finally { console.warn = w; }
    expect(lost).toEqual({ status: 503, replay: null, retryAfter: '1', body: { error: 'CONNECTION_LOST', message: CONNECTION_LOST_MESSAGE } });
    // La base sí confirmó.
    expect(await ordersOf(u)).toBe(1);
    const retry = await post(u, 'k');
    expect(retry).toMatchObject({ status: 201, replay: 'true', retryAfter: null, body: { userid: String(u), side: 'CASH_IN' } });
    expect(await ordersOf(u)).toBe(1);
  });
});
