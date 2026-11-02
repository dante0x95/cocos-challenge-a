// La variante Z del lab (issue #72, lab/z/server.ts) contra Postgres real, en una base propia con el
// esquema de database.sql tal cual (db/migrations/000_seed.sql, sin bootstrap): Z no usa el esquema
// app. Fija lo que lab/check.ts compara en el dataset, con un usuario armado a mano:
//   - Los importes son exactos (numeric de Postgres, strings en la respuesta), también por encima de
//     2^53 centavos, donde un double ya no representa los centavos: el cash de este usuario es de
//     ~4·10^17 pesos.
//   - El costo es el promedio de todas las compras (decisión en #72): compra 10 @ 100, venta 4 @ 120,
//     recompra 5 @ 90 → 1.450 / 15 × 11 = 1.063,333333 (A daría 1.050).
//   - La búsqueda toma q como texto: %, _ y \ no son comodines; un carácter de control da 400.
//   - Todo lo que no es GET ni HEAD responde 403.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createZApp } from '../../lab/z/server.js';
import { recreateDatabase } from '../support/global-setup.js';
import { SERVER_URL, dbUrl } from '../support/urls.js';

const DB = 'cocos_lab_z_test';
let pool: pg.Pool;
let server: Server;
let base: string;
let user: number;
let inst: number;
let bigCashIn: number;

const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  await recreateDatabase(DB);
  pool = new pg.Pool({ connectionString: dbUrl(DB), max: 2 });
  await pool.query(readFileSync(resolve(import.meta.dirname, '../../db/migrations/000_seed.sql'), 'utf8'));
  user = (await pool.query<{ id: number }>("INSERT INTO users (email, accountnumber) VALUES ('z@lab.test', '1') RETURNING id")).rows[0].id;
  inst = (await pool.query<{ id: number }>("INSERT INTO instruments (ticker, name, type) VALUES ('ZQX', 'Zeta Quántica S.A.', 'ACCIONES') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO instruments (ticker, name, type) VALUES ('P_C', 'Cien % S.A.', 'ACCIONES')");
  await pool.query("INSERT INTO marketdata (instrumentid, close, previousclose, date) VALUES ($1, 100.00, 99.00, '2026-10-22'), ($1, 110.00, 108.91, '2026-10-23')", [inst]);
  const ars = (await pool.query<{ id: number }>("SELECT id FROM instruments WHERE ticker = 'ARS'")).rows[0].id;
  const order = async (iid: number, size: number, price: string, type: string, side: string, status: string) => (await pool.query<{ id: number }>(
    `INSERT INTO orders (instrumentid, userid, size, price, type, side, status, datetime) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-01 10:00:00') RETURNING id`,
    [iid, user, size, price, type, side, status])).rows[0].id;
  // Dos depósitos de 2.000.000.000 × 99.999.999,99: el máximo de size (int) por el de price (numeric(10,2)).
  bigCashIn = await order(ars, 2_000_000_000, '99999999.99', 'MARKET', 'CASH_IN', 'FILLED');
  await order(ars, 2_000_000_000, '99999999.99', 'MARKET', 'CASH_IN', 'FILLED');
  await order(inst, 10, '100.00', 'MARKET', 'BUY', 'FILLED');
  await order(inst, 4, '120.00', 'MARKET', 'SELL', 'FILLED');
  await order(inst, 5, '90.00', 'MARKET', 'BUY', 'FILLED');
  await order(inst, 2, '150.00', 'LIMIT', 'SELL', 'NEW');
  await order(inst, 1, '50.00', 'LIMIT', 'BUY', 'NEW');
  await order(inst, 3, '80.00', 'LIMIT', 'BUY', 'CANCELLED');
  server = createZApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await pool?.end();
  const c = new pg.Client({ connectionString: SERVER_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await c.end();
});

describe('Z del lab (lab/z/server.ts) sobre database.sql', () => {
  it('portfolio exacto por encima de 2^53 centavos, con el costo del promedio de compras', async () => {
    const r = await get(`/portfolio/${user}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      userid: user,
      valor_total: '399999999960000240.00',
      cash: { neto: '399999999959999030.00', reservado: '50.00', disponible: '399999999959998980.00' },
      valuation_complete: true,
      has_inconsistent_history: false,
      positions: [{
        instrumentid: inst, ticker: 'ZQX', name: 'Zeta Quántica S.A.',
        qty: '11', acciones_reservadas: '2', acciones_disponibles: '9',
        costo_total: '1063.333333', costo_unitario: '96.6667',
        price: '110.00', price_date: '2026-10-23', valor: '1210.00', resultado: '146.67',
        rendimiento_pct: '13.79', retorno_diario_pct: '1.00', inconsistent: false,
      }],
    });
    // Control: con Number, como el Z del benchmark, el cash ya no es el mismo.
    expect((2 * 2_000_000_000 * 99999999.99 - 970).toFixed(2)).not.toBe('399999999959999030.00');
  });

  it('una orden con su importe exacto; ajena o inexistente, 404; id inválido, 400', async () => {
    const r = await get(`/orders/${bigCashIn}?userid=${user}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: String(bigCashIn), size: '2000000000', price: '99999999.99', amount: '199999999980000000.00', status: 'FILLED', datetime: '2026-10-01T10:00:00Z' });
    expect((await get(`/orders/${bigCashIn}?userid=${user + 1}`)).status).toBe(404);
    expect((await get(`/orders/abc?userid=${user}`)).status).toBe(400);
    expect((await get(`/orders/${bigCashIn}?userid=${user}&userid=${user}`)).status).toBe(400);
    expect((await get('/portfolio/999999')).status).toBe(404);
    expect((await get('/portfolio/abc')).status).toBe(400);
  });

  it('la búsqueda toma q como texto y rechaza lo mismo que v2', async () => {
    const tickers = async (q: string, extra = '') => ((await get(`/instruments?q=${encodeURIComponent(q)}${extra}`)).body.results as { ticker: string }[]).map((x) => x.ticker);
    expect(await tickers('zeta')).toEqual(['ZQX']);
    expect(await tickers('quántica')).toEqual(['ZQX']);
    expect(await tickers('%')).toEqual(['P_C']);
    expect(await tickers('_')).toEqual(['P_C']);
    expect(await tickers('P%C')).toEqual([]);
    expect(await tickers('ars')).not.toContain('ARS');
    expect(await tickers('ars', '&include_cash=true')).toContain('ARS');
    for (const bad of ['', 'ab\u0000c', 'ab\u007fc', 'x'.repeat(51)]) {
      expect((await get(`/instruments?q=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
    for (const extra of ['&limit=0', '&limit=51', '&limit=x', '&include_cash=si']) {
      expect((await get(`/instruments?q=zeta${extra}`)).status).toBe(400);
    }
  });

  it('todo lo que no es GET ni HEAD responde 403 sin tocar la base', async () => {
    const before = await get(`/portfolio/${user}`);
    for (const [method, path] of [['POST', '/orders'], ['POST', `/orders/${bigCashIn}/cancel`], ['PUT', '/orders'], ['DELETE', `/orders/${bigCashIn}`], ['PATCH', '/portfolio/1']]) {
      const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect((await fetch(`${base}/portfolio/${user}`, { method: 'HEAD' })).status).toBe(200);
    expect(await get(`/portfolio/${user}`)).toEqual(before);
  });
});
