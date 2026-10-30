// Paridad con el oráculo: sobre historias aleatorias (seed fija, reproducible), cada decisión
// de app.place_order / execute_limit / cancel_order y cada lectura de app.read_portfolio
// coinciden con test/oracle/fold.ts, una implementación independiente.
// Un 20 % de los usuarios arranca con una venta en corto heredada (D-01), para recorrer
// también las reglas de cobertura (D-03), que la API sola nunca generaría.
// Tamaño por env: PARITY_USERS (100) × PARITY_OPS (20), PARITY_SEED (42).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, arsId, cents, fmt, legacyShort, newUser, placeOrder, quotes, type Quote } from '../support/db.js';
import { pool } from '../../src/db/pool.js';
import * as O from '../oracle/fold.js';

const USERS = Number(process.env.PARITY_USERS ?? 100);
const OPS = Number(process.env.PARITY_OPS ?? 20);
const SEED = Number(process.env.PARITY_SEED ?? 42);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let ars: number;
let qs: Quote[];

beforeAll(async () => {
  ars = await arsId();
  qs = await quotes(5);
  expect(qs.length).toBeGreaterThan(0);
});
afterAll(async () => {
  await admin.end();
  await pool.end();
});

interface PortfolioRow { kind: number; instrumentid: number | null; qty: string; cost_total: string; inconsistent: boolean; reserved: string }

async function compare(userid: number, s: O.OracleState, step: string) {
  const { rows } = await pool.query<PortfolioRow>('SELECT * FROM app.read_portfolio($1)', [userid]);
  const cashRow = rows.find((r) => r.kind === 0)!;
  const ctx = `user ${userid} @ ${step}`;
  expect(BigInt(cashRow.qty), `${ctx}: cash`).toBe(s.cashCents);
  expect(BigInt(cashRow.reserved), `${ctx}: cash reservado`).toBe(O.reservedCash(s));
  const dbPos = new Map(rows.filter((r) => r.kind === 1).map((r) => [r.instrumentid as number, r]));
  for (const [i, p] of s.positions) {
    const d = dbPos.get(i);
    if (p.qty === 0n) { expect(d, `${ctx}: posición ${i} cerrada no debe listarse`).toBeUndefined(); continue; }
    expect(d, `${ctx}: posición ${i} ausente`).toBeDefined();
    expect(BigInt(d!.qty), `${ctx}: qty ${i}`).toBe(p.qty);
    expect(BigInt(d!.cost_total), `${ctx}: cost ${i}`).toBe(p.cost);
    expect(d!.inconsistent, `${ctx}: inconsistent ${i}`).toBe(p.short);
    expect(BigInt(d!.reserved), `${ctx}: reservadas ${i}`).toBe(O.reservedShares(s, i));
  }
  for (const i of dbPos.keys()) expect(s.positions.has(i), `${ctx}: la DB lista ${i} y el oráculo no`).toBe(true);
}

describe(`paridad base == oráculo (${USERS} usuarios × ${OPS} ops, seed ${SEED})`, () => {
  it('toda historia generada coincide paso a paso', async () => {
    const rnd = mulberry32(SEED);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    let totalOps = 0;

    for (let u = 0; u < USERS; u++) {
      const userid = await newUser('parity');
      const s = O.newState();
      const pending: bigint[] = [];

      if (rnd() < 0.2) {
        // Historia heredada: CASH_IN, BUY 2n, SELL 3n → n acciones en corto.
        const q = pick(qs);
        const n = BigInt(int(1, 20));
        const cashCents = BigInt(int(100_000, 2_000_000)) + n * q.closeCents;
        await legacyShort(userid, q.instrumentid, q.closeCents, cashCents, n);
        s.cashCents = cashCents - n * q.closeCents;      // el CASH_IN; las ejecuciones lo ajustan
        O.fill(s, 'BUY', q.instrumentid, 2n * n, q.closeCents);
        O.fill(s, 'SELL', q.instrumentid, 3n * n, q.closeCents);
        await compare(userid, s, 'historia heredada');
      }

      for (let k = 0; k < OPS; k++) {
        const kind = rnd();
        const q = pick(qs);
        const key = `p-${u}-${k}`;
        let step = '';

        if (kind < 0.15) {
          const amount = fmt(BigInt(int(100, 2_000_000)));
          step = `CASH_IN ${amount}`;
          const exp = O.placeOrder(s, { side: 'CASH_IN', type: 'MARKET', instrumentid: ars, size: cents(amount), priceCents: 1n }, 0n);
          const r = await placeOrder(pool, { userid, key, side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount });
          expect(r.body.status, step).toBe(exp);
        } else if (kind < 0.25) {
          const amount = fmt(BigInt(int(1, 500_000)));
          step = `CASH_OUT ${amount}`;
          const exp = O.placeOrder(s, { side: 'CASH_OUT', type: 'MARKET', instrumentid: ars, size: cents(amount), priceCents: 1n }, 0n);
          const r = await placeOrder(pool, { userid, key, side: 'CASH_OUT', type: 'MARKET', instrumentid: ars, amount });
          expect(r.body.status, step).toBe(exp);
        } else if (kind < 0.45) {
          // BUY MARKET, por size o por amount (D-11)
          const byAmount = rnd() < 0.4;
          const amount = byAmount ? fmt(BigInt(int(1, 300_000))) : null;
          const size = byAmount ? cents(amount!) / q.closeCents : BigInt(int(1, 60));
          step = `BUY MARKET ${q.instrumentid} ${byAmount ? 'amount ' + amount : 'size ' + size}`;
          if (size === 0n) {
            await expect(placeOrder(pool, { userid, key, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, amount }), step)
              .rejects.toMatchObject({ code: 'APP02' });
          } else {
            const exp = O.placeOrder(s, { side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size, priceCents: q.closeCents }, 0n);
            const r = byAmount
              ? await placeOrder(pool, { userid, key, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, amount })
              : await placeOrder(pool, { userid, key, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size });
            expect(r.body.status, step).toBe(exp);
            expect(BigInt(r.body.size!), step).toBe(size);
          }
        } else if (kind < 0.60) {
          const size = BigInt(int(1, 60));
          step = `SELL MARKET ${q.instrumentid} ${size}`;
          const exp = O.placeOrder(s, { side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size, priceCents: q.closeCents }, 0n);
          const r = await placeOrder(pool, { userid, key, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size });
          expect(r.body.status, step).toBe(exp);
        } else if (kind < 0.80) {
          // LIMIT alrededor del close (±10 %), para que a veces cruce y a veces no
          const side = rnd() < 0.5 ? 'BUY' : 'SELL';
          const size = BigInt(int(1, 40));
          const limitCents = (q.closeCents * BigInt(int(90, 110))) / 100n;
          const limit = fmt(limitCents);
          step = `${side} LIMIT ${q.instrumentid} ${size} @ ${limit}`;
          // el id lo asigna la DB; el oráculo lo recibe después
          const r = await placeOrder(pool, { userid, key, side, type: 'LIMIT', instrumentid: q.instrumentid, size, limit });
          const id = BigInt(r.order_id);
          const exp = O.placeOrder(s, { side, type: 'LIMIT', instrumentid: q.instrumentid, size, priceCents: cents(limit) }, id);
          expect(r.body.status, step).toBe(exp);
          if (exp === 'NEW') pending.push(id);
        } else if (kind < 0.92 && pending.length) {
          const id = pending.splice(Math.floor(rnd() * pending.length), 1)[0];
          const o = s.pendingBuys.get(id) ?? s.pendingSells.get(id);
          const close = qs.find((x) => x.instrumentid === o!.instrumentid)!.closeCents;
          step = `execute_limit ${id}`;
          const exp = O.executeLimit(s, id, close);
          const r = await pool.query<{ r: boolean }>('SELECT app.execute_limit($1) AS r', [Number(id)]);
          expect(r.rows[0].r, step).toBe(exp);
          if (!exp) pending.push(id);
        } else if (pending.length) {
          const id = pending.splice(Math.floor(rnd() * pending.length), 1)[0];
          step = `cancel ${id}`;
          const exp = O.cancelOrder(s, id);
          const r = await pool.query<{ r: boolean }>('SELECT app.cancel_order($1, $2) AS r', [userid, Number(id)]);
          expect(r.rows[0].r, step).toBe(exp);
        } else {
          continue;
        }
        totalOps++;
        if (k % 5 === 4) await compare(userid, s, step);
      }
      await compare(userid, s, 'final');
    }
    expect(totalOps).toBeGreaterThanOrEqual(1000);
  }, 300_000);
});
