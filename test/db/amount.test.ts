// Orden por monto (D-11, issue #10): la cantidad es la división entera de amount por el precio, en
// centavos. `floor(amount / price)` en numeric redondeaba el cociente a 16 dígitos antes del floor y
// autorizaba una acción más que el presupuesto.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { admin, arsId, fmt, newUser, placeOrder } from '../support/db.js';
import * as O from '../oracle/fold.js';

let ars: number;
let inst: number;    // close 5.000,00
let server: Server;
let base: string;

beforeAll(async () => {
  ars = await arsId();
  inst = (await admin.query<{ id: number }>(
    "INSERT INTO app.instruments (ticker, name, type) VALUES ('D11TEST', 'Prueba D-11', 'ACCIONES') RETURNING id")).rows[0].id;
  await admin.query(
    `INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
     VALUES ($1, 5000.00, 5000.00, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`, [inst]);
  server = createApp({ internalToken: 'test-token' }).listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await admin.end(); await pool.end(); });

const buyLimit = (u: number, key: string, amount: string, price: string) =>
  placeOrder(pool, { userid: u, key, side: 'BUY', type: 'LIMIT', instrumentid: inst, amount, limit: price });
const ordersOf = async (u: number) =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n;

/** Usuario con `shares` acciones de `inst` compradas a 0,01 y sin cash. */
async function holder(shares: bigint): Promise<number> {
  const u = await newUser('d11');
  const ins = (side: string, iid: number, size: bigint, price: string, seq: number) => admin.query(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
     VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`, [iid, u, size.toString(), price, side, seq]);
  await ins('CASH_IN', ars, shares, '0.01', 1);
  await ins('BUY', inst, shares, '0.01', 2);
  return u;
}

describe('la cantidad por monto es la división entera en centavos', () => {
  const magnitudes = [['10²', '100.00'], ['10⁸', '100000000.00'], ['10¹⁴', '100000000000000.00'], ['0,01', '0.01']] as const;

  it.each(magnitudes)('BUY LIMIT, price %s: amount = 2 × price − 0,01 → size 1; amount = 2 × price → size 2', async (_m, price) => {
    const p = BigInt(price.replace('.', ''));
    const u = await newUser('d11-buy');
    const one = await buyLimit(u, 'one', fmt(2n * p - 1n), price);
    expect(one.body).toMatchObject({ size: '1', amount: price });
    const two = await buyLimit(u, 'two', fmt(2n * p), price);
    expect(two.body).toMatchObject({ size: '2', amount: fmt(2n * p) });
  });

  it.each(magnitudes)('SELL LIMIT, price %s: el espejo, no vende una acción de más', async (_m, price) => {
    const p = BigInt(price.replace('.', ''));
    const u = await holder(10n);
    const one = await placeOrder(pool, { userid: u, key: 'one', side: 'SELL', type: 'LIMIT', instrumentid: inst, amount: fmt(2n * p - 1n), limit: price });
    expect(one.body).toMatchObject({ status: 'NEW', size: '1' });
    const two = await placeOrder(pool, { userid: u, key: 'two', side: 'SELL', type: 'LIMIT', instrumentid: inst, amount: fmt(2n * p), limit: price });
    expect(two.body).toMatchObject({ status: 'NEW', size: '2' });
  });

  it('los dos lados del redondeo a 16 dígitos: 999999999999999,99 / 499999999999999,99 → 2; / 500000000000000,00 → 1', async () => {
    const u = await newUser('d11-16');
    expect((await buyLimit(u, 'a', '999999999999999.99', '499999999999999.99')).body.size).toBe('2');
    expect((await buyLimit(u, 'b', '999999999999999.99', '500000000000000.00')).body.size).toBe('1');
  });

  // El tope de D-14 es sobre el importe (size × price), no sobre el monto: un amount por encima de
  // 10¹⁵ da una orden válida si el importe entra. La división es sobre numeric, así que un amount
  // enorme no desborda: la cantidad se acota antes del cast.
  it('amount > 10¹⁵: sin 22003; 400 si la cantidad supera 2³¹ − 1, la orden si el importe entra', async () => {
    const u = await newUser('d11-cap');
    await expect(buyLimit(u, 'c', '1000000000000000.01', '0.01')).rejects.toMatchObject({ code: 'APP02' });
    await expect(buyLimit(u, 'd', '99999999999999999999999999.00', '1.00')).rejects.toMatchObject({ code: 'APP02' });
    expect(await ordersOf(u)).toBe(0);
    const ok = await buyLimit(u, 'e', '1999999999999999.99', '1000000000000000.00');
    expect(ok.body).toMatchObject({ size: '1', amount: '1000000000000000.00' });
  });

  it('amount que da más de 2³¹ − 1 acciones (10¹⁵ a 0,01) → 400 APP02 como siempre, no 22003', async () => {
    const u = await newUser('d11-size');
    await expect(buyLimit(u, 's', '1000000000000000.00', '0.01')).rejects.toMatchObject({ code: 'APP02' });
    expect(await ordersOf(u)).toBe(0);
  });

  it('la respuesta y GET /orders/:id llevan size × price, no el monto pedido', async () => {
    const u = await newUser('d11-http');
    const r = await fetch(`${base}/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'h' },
      body: JSON.stringify({ userid: u, side: 'BUY', type: 'LIMIT', instrumentid: inst, amount: '9999.99', price: '5000.00' }) });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; size: string; amount: string };
    expect(body).toMatchObject({ size: '1', amount: '5000.00' });
    const g = await fetch(`${base}/orders/${body.id}?userid=${u}`);
    expect(await g.json()).toMatchObject({ size: '1', amount: '5000.00' });
  });

  it('coincide con el oráculo en una grilla de montos alrededor de múltiplos del precio', async () => {
    const u = await newUser('d11-grid');
    const p = 500_000n;   // 5.000,00
    let i = 0;
    for (const k of [1n, 7n, 123n]) {
      for (const delta of [-1n, 0n, 1n, p - 1n]) {
        const amount = k * p + delta;
        const expected = O.sizeFromAmount(amount, p);
        const r = buyLimit(u, `g${i++}`, fmt(amount), '5000.00');
        if (expected === 0n) await expect(r, `amount ${fmt(amount)}`).rejects.toMatchObject({ code: 'APP02' });
        else expect(BigInt((await r).body.size!), `amount ${fmt(amount)}`).toBe(expected);
      }
    }
  });
});

// D-13: toda división que decide una cantidad o un importe es entera. Las dos funciones que deciden
// una escritura con cantidades e importes no tienen ninguna división `/`, salvo la de presentación
// del amount de la respuesta (centavos enteros → pesos con 2 decimales, exacta).
const DECIDERS = {
  'app.place_order(int, text, text, text, text, int, int, numeric, numeric, text)': ['imp / 100'],
  'app.execute_limit_outcome(bigint)': [],
} as const;

/** El código PL/pgSQL sin comentarios ni literales de texto ('BUY/SELL' no es una división). */
function codeOnly(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "'") {
      for (i++; i < src.length && !(src[i] === "'" && src[i + 1] !== "'"); i++) if (src[i] === "'") i++;
      out += "''";
    } else if (src[i] === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else out += src[i];
  }
  return out;
}

/** Cada división del código, como `operando / operando`. */
const divisions = (src: string) =>
  [...codeOnly(src).matchAll(/([\w.:]+|\))\s*\/\s*([\w.:]+|\()/g)].map((m) => `${m[1]} / ${m[2]}`);

describe('que no vuelva', () => {
  const source = async (sig: string) =>
    (await admin.query<{ src: string }>('SELECT prosrc AS src FROM pg_proc WHERE oid = to_regprocedure($1)', [sig])).rows[0].src;

  it.each(Object.entries(DECIDERS))('%s: sin divisiones numeric que decidan, salvo las de presentación', async (sig, allowed) => {
    expect(divisions(await source(sig))).toEqual(allowed);
  });

  it('place_order calcula la cantidad por monto con div, sin floor', async () => {
    const code = codeOnly(await source(Object.keys(DECIDERS)[0]));
    expect(code).not.toMatch(/floor\s*\(/);
    expect(code).toMatch(/div\(p_amount \* 100, price \* 100\)/);
  });

  it('el control detecta una división nueva en cada función, aunque siga la llamada a div', async () => {
    const [po, ex] = await Promise.all(Object.keys(DECIDERS).map(source));
    const planted = [
      po.replace('v_qty := div(p_amount * 100, price * 100);', 'v_qty := div(p_amount * 100, price * 100) + 0 * (p_amount / price);'),
      ex.replace('o.size::numeric * o.price * 100 > 1e17', 'o.size::numeric * o.price / 0.01 > 1e17'),
    ];
    expect(planted[0]).not.toBe(po);
    expect(planted[1]).not.toBe(ex);
    expect(divisions(planted[0])).toEqual(['p_amount / price', 'imp / 100']);
    expect(divisions(planted[1])).toEqual(['o.price / 0.01']);
    // Un literal o un comentario con "/" no cuentan.
    expect(divisions("RAISE EXCEPTION 'BUY/SELL no aplica'; -- a / b\nx := 1;")).toEqual([]);
  });
});
