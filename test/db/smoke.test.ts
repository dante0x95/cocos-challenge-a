// El smoke funcional (deploy/smoke.mjs, D-29, issue #51) contra la API real y Postgres: el mismo
// script que corren el CI (dentro de la imagen) y el deploy (por la URL pública), acá contra la
// app en este proceso. Pasa con la API sana, se puede repetir con el mismo usuario, y cada rotura
// del plan de pruebas lo pone en rojo: POST /orders en 500, una firma de place_order que la API
// no llama y un portfolio con el cash corrido un centavo (la imagen que no arranca la ve
// deploy/lightsail/smoke-docker.sh). También el SQL del usuario del smoke de staging
// (deploy/lightsail/smoke-user.sql): lo crea, lo reutiliza en cero y lo retira si no lo está.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { admin, cents, fmt, newUser } from '../support/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const SMOKE = resolve(ROOT, 'deploy/smoke.mjs');
const SMOKE_USER_SQL = readFileSync(resolve(ROOT, 'deploy/lightsail/smoke-user.sql'), 'utf8');
const SHA = 'f'.repeat(40);

const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) s.close();
  await pool.end();
  await admin.end();
});

/** La API con `mutate` delante (una rotura), y lo que recibió: método y ruta de cada request. */
function serve(mutate?: (outer: express.Express) => void) {
  const seen: string[] = [];
  const outer = express();
  outer.use((req, _res, next) => { seen.push(`${req.method} ${req.path}`); next(); });
  mutate?.(outer);
  outer.use(createApp({ release: SHA }));
  const server = outer.listen(0);
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/** deploy/smoke.mjs en otro proceso (la API corre en este: spawnSync la bloquearía). */
async function smoke(mode: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [SMOKE, mode], { env: { PATH: process.env.PATH, SHA, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const [status] = (await once(child, 'close')) as [number];
  return { status, stdout, stderr };
}

/** El SQL de staging, como lo corre remote.sh smoke-user: devuelve el id que imprime. */
async function smokeUser(): Promise<number> {
  const results = (await admin.query(SMOKE_USER_SQL)) as unknown as { rows: { id: number }[] }[];
  const rows = results.at(-1)!.rows;
  expect(rows).toHaveLength(1);
  return rows[0].id;
}
const emailOf = async (id: number) => (await admin.query<{ email: string }>('SELECT email FROM app.users WHERE id = $1', [id])).rows[0].email;

describe('deploy/smoke.mjs contra la API sana', () => {
  it('write pasa dos veces seguidas con el mismo usuario y lo deja en cero', async () => {
    const { url, seen } = serve();
    const userid = String(await newUser('smoke'));
    for (const run of [1, 2]) {
      const r = await smoke('write', { URL: url, SMOKE_USERID: userid });
      expect(r.stderr, `corrida ${run}`).toBe('');
      expect(r.status, `corrida ${run}`).toBe(0);
      expect(r.stdout).toContain(`SMOKE OK (write) contra ${url}: atiende ${SHA}`);
    }
    // El flujo del issue: depósito y replay, MARKET por size y por amount, LIMIT, cancelación,
    // retiro, el portfolio, la búsqueda y los 400.
    expect(seen.filter((s) => s.startsWith('POST /orders')).length).toBeGreaterThanOrEqual(2 * 11);
    expect(seen).toContain('GET /instruments');
    const p = await (await fetch(`${url}/portfolio/${userid}`)).json();
    expect(p).toMatchObject({ valor_total: '0.00', cash: { neto: '0.00', reservado: '0.00', disponible: '0.00' }, positions: [] });
  });

  it('read solo hace GET: no escribe nada', async () => {
    const { url, seen } = serve();
    const r = await smoke('read', { URL: url });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => !s.startsWith('GET '))).toEqual([]);
  });

  it('/health con otro release lo pone en rojo, antes de escribir', async () => {
    const { url, seen } = serve();
    const r = await smoke('write', { URL: url, SMOKE_USERID: String(await newUser('smoke')), SHA: 'e'.repeat(40) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SMOKE FALLIDO: GET /health atiende el release');
    expect(seen.filter((s) => s.startsWith('POST'))).toEqual([]);
  });

  it('un usuario que no está en cero lo frena antes de escribir', async () => {
    const { url, seen } = serve();
    const userid = await newUser('smoke');
    await fetch(`${url}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `resto-${userid}` },
      body: JSON.stringify({ userid, side: 'CASH_IN', amount: '1.00' }) });
    seen.length = 0;
    const r = await smoke('write', { URL: url, SMOKE_USERID: String(userid) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`SMOKE FALLIDO: el usuario del smoke empieza en cero: el usuario ${userid} no está en cero`);
    expect(seen.filter((s) => s.startsWith('POST'))).toEqual([]);
  });

  it('sin URL, SHA o SMOKE_USERID, o con otro modo, no corre: sale con 2', async () => {
    const { url } = serve();
    expect((await smoke('write', { URL: url })).status).toBe(2);
    expect((await smoke('read', { URL: '' })).status).toBe(2);
    expect((await smoke('read', { URL: url, SHA: '' })).status).toBe(2);
    expect((await smoke('borrar', { URL: url })).status).toBe(2);
  });
});

// Plan de pruebas 2: cada rotura pone el smoke en rojo, con el paso y el motivo.
describe('deploy/smoke.mjs detecta cada rotura', () => {
  it('POST /orders que responde 500', async () => {
    const { url } = serve((outer) => outer.post('/orders', (_req, res) => { res.status(500).json({ error: 'INTERNAL', message: 'error interno; reintentar' }); }));
    const r = await smoke('write', { URL: url, SMOKE_USERID: String(await newUser('smoke')) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SMOKE FALLIDO: CASH_IN y su replay: POST /orders cash-in: se esperaba 201 y respondió 500');
  });

  it('un body inválido que responde 500 en vez de 400', async () => {
    const { url } = serve((outer) => outer.post('/orders', express.json(), (req, res, next) => {
      if (req.body?.side === 'HOLD') { res.status(500).json({ error: 'INTERNAL', message: 'x' }); return; }
      next();
    }));
    const r = await smoke('write', { URL: url, SMOKE_USERID: String(await newUser('smoke')) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SMOKE FALLIDO: un body inválido responde 400, no 500: POST /orders inválido (side): se esperaba 400 y respondió 500');
  });

  // El escenario de #39: la base tiene una place_order con otra firma que la que llama la API.
  it('place_order con una firma que la API no llama', async () => {
    const { url } = serve();
    const userid = String(await newUser('smoke'));
    await admin.query(`
      ALTER FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric, text) RENAME TO place_order_smoke;
      CREATE FUNCTION app.place_order(p_userid int, p_key text, p_hash text, p_side text, p_type text, p_instrumentid int,
        p_size int, p_amount numeric, p_limit numeric, p_legacy_hash text, p_nuevo int) RETURNS jsonb
        LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
      GRANT EXECUTE ON FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric, text, int) TO api;`);
    try {
      const r = await smoke('write', { URL: url, SMOKE_USERID: userid });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('SMOKE FALLIDO: CASH_IN y su replay: POST /orders cash-in: se esperaba 201 y respondió 500');
    } finally {
      await admin.query(`
        DROP FUNCTION app.place_order(int, text, text, text, text, int, int, numeric, numeric, text, int);
        ALTER FUNCTION app.place_order_smoke(int, text, text, text, text, int, int, numeric, numeric, text) RENAME TO place_order;`);
    }
    // Restaurada, el mismo usuario sigue en cero y el smoke pasa.
    expect((await smoke('write', { URL: url, SMOKE_USERID: userid })).status).toBe(0);
  });

  it('un portfolio con el cash corrido un centavo', async () => {
    const { url } = serve((outer) => outer.get('/portfolio/:userid', (_req, res, next) => {
      const json = res.json.bind(res);
      res.json = (body: { cash?: { neto: string }; positions?: unknown[] }) => {
        if (body?.cash && body.positions?.length) body.cash.neto = fmt(cents(body.cash.neto) + 1n);
        return json(body);
      };
      next();
    }));
    const r = await smoke('write', { URL: url, SMOKE_USERID: String(await newUser('smoke')) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SMOKE FALLIDO: GET /portfolio exacto, con la reserva: portfolio con la LIMIT: cash');
  });
});

// Plan de pruebas 4, la parte de la base: el usuario de staging es uno solo y siempre empieza en
// cero. remote.sh lo corre igual, con psql en una transacción; test/unit/deploy-workflow ve que
// solo staging lo pide y smoke-docker.sh, que dos corridas con Docker pasan.
describe('deploy/lightsail/smoke-user.sql', () => {
  it('lo crea la primera vez, lo reutiliza mientras el smoke lo deje en cero y lo retira si no', async () => {
    const { url } = serve();
    const first = await smokeUser();
    expect(await emailOf(first)).toBe('smoke@staging.invalid');
    expect(await smokeUser()).toBe(first);   // sin órdenes

    for (let run = 1; run <= 2; run++) {
      expect(await smokeUser()).toBe(first);
      expect((await smoke('write', { URL: url, SMOKE_USERID: String(first) })).status).toBe(0);
    }

    // Una corrida que falló a la mitad: un depósito que no volvió.
    const order = (body: object, key: string) => fetch(`${url}/orders`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    expect((await order({ userid: first, side: 'CASH_IN', amount: '10.00' }, `resto-${first}`)).status).toBe(201);
    const second = await smokeUser();
    expect(second).not.toBe(first);
    expect(await emailOf(first)).toBe(`smoke-retirado-${first}@staging.invalid`);
    expect(await emailOf(second)).toBe('smoke@staging.invalid');
    expect((await smoke('write', { URL: url, SMOKE_USERID: String(second) })).status).toBe(0);

    // Una posición abierta, con el cash en cero: compra una acción con lo justo.
    expect((await order({ userid: second, side: 'CASH_IN', amount: '1000.00' }, `c-${second}`)).status).toBe(201);
    const buy = await (await order({ userid: second, side: 'BUY', type: 'MARKET', instrumentid: 47, size: 1 }, `b-${second}`)).json();
    expect(buy.status).toBe('FILLED');
    expect((await order({ userid: second, side: 'CASH_OUT', amount: fmt(100000n - cents(buy.amount)) }, `o-${second}`)).status).toBe(201);
    expect((await (await fetch(`${url}/portfolio/${second}`)).json()).cash.neto).toBe('0.00');
    const third = await smokeUser();
    expect(third).not.toBe(second);

    // Una LIMIT NEW heredada (la API no deja una NEW con todo lo demás en cero), sin nada más.
    await admin.query(`INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
      VALUES (47, $1, 1, 1.00, 'LIMIT', 'BUY', 'NEW', timezone('UTC', now()))`, [third]);
    expect(await smokeUser()).not.toBe(third);
  });
});
