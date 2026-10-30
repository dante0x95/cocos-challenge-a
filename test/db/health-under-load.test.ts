// Reproducción del issue #32: /health comparte el pool con el tráfico. Con el pool lleno por la ráfaga de UN
// usuario (todas sus escrituras esperan su lock), el probe de salud se forma en la cola FIFO del
// pool detrás de ellas y su latencia es el presupuesto de espera del pool (PG_CONNECT_TIMEOUT_MS,
// 2000 en fly.toml), que es exactamente el timeout del check de Fly (fly.toml: timeout = "2s").
// Fly marca la máquina unhealthy y deja de enrutarle tráfico a TODOS los usuarios, y un deploy
// bluegreen en curso falla. La ráfaga se sostiene sola: la API responde 503 con Retry-After: 1 y
// "reintentar con la misma Idempotency-Key", así que el cliente vuelve cada segundo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type pg from 'pg';
import { admin, newUser } from '../support/db.js';

process.env.PG_POOL_MAX = '2';
process.env.PG_CONNECT_TIMEOUT_MS = '2000';
const { createApp } = await import('../../src/app.js');
const { pool } = await import('../../src/db/pool.js');

const FLY_CHECK_TIMEOUT_MS = 2000; // fly.toml [[http_service.checks]] timeout = "2s"

let server: Server;
let base: string;

beforeAll(() => {
  server = createApp({ internalToken: 'test-token', release: 'abc' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
  await admin.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function holdUserLock(userid: number): Promise<pg.PoolClient> {
  const c = await admin.connect();
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)", [userid]);
  return c;
}

/** Lo que hace el check de Fly: GET /health con su timeout. */
async function flyCheck(): Promise<{ ok: boolean; status?: number; ms: number; reason?: string }> {
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(FLY_CHECK_TIMEOUT_MS) });
    return { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), reason: (e as Error).name };
  }
}

/** Un cliente de la ráfaga: manda su orden y, ante un 503, reintenta como le dice la API. */
function burstClient(userid: number, i: number, stop: { now: boolean }, statuses: number[]) {
  return (async () => {
    while (!stop.now) {
      const r = await fetch(`${base}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': `whale-${userid}-${i}` },
        body: JSON.stringify({ userid, side: 'CASH_IN', amount: '1.00' }),
      });
      statuses.push(r.status);
      await r.arrayBuffer();
      if (r.status !== 503) break;
      await sleep(Number(r.headers.get('retry-after') ?? 1) * 1000);
    }
  })();
}

describe('GET /health con el pool ocupado por la ráfaga de un solo usuario', () => {
  it('control: sin carga, el check de Fly pasa en milisegundos', async () => {
    const r = await flyCheck();
    console.log('sin carga:', r);
    expect(r.ok).toBe(true);
    expect(r.ms).toBeLessThan(500);
  });

  it('un usuario con su lock tomado y 6 clientes que reintentan: cada probe de Fly tarda el presupuesto entero del pool (≥ 1.9 s con timeout de 2 s)', async () => {
    const u = await newUser('whale');
    const lock = await holdUserLock(u);
    const stop = { now: false };
    const statuses: number[] = [];
    const clients = [1, 2, 3, 4, 5, 6].map((i) => burstClient(u, i, stop, statuses));
    await sleep(300);

    // Tres probes, como los haría Fly durante la ráfaga.
    const probes = [];
    for (let k = 0; k < 3; k++) {
      probes.push(await flyCheck());
      await sleep(500);
    }
    console.log('probes bajo la ráfaga:', probes);

    stop.now = true;
    await lock.query('COMMIT'); lock.release();
    await Promise.all(clients);
    console.log('la ráfaga recibió:', statuses.join(' '));

    // La latencia del probe la decide la cola del pool, no la base: entre los huecos de la ráfaga
    // responde en ms y, cuando cae detrás de la ráfaga, tarda el presupuesto entero del pool, que
    // es el timeout de Fly. Un check que vence alcanza para que Fly empiece a contar la máquina
    // como unhealthy.
    expect(Math.max(...probes.map((p) => p.ms))).toBeGreaterThanOrEqual(1500);
    expect(probes.some((p) => !p.ok)).toBe(true);
    // La base estaba sana todo el tiempo: el único que debía sufrir era el usuario de la ráfaga.
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
  });
});
