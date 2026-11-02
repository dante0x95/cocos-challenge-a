// Paridad con el oráculo: sobre historias aleatorias (seed fija, reproducible), cada decisión
// de app.place_order / execute_limit / cancel_order y cada lectura de app.read_portfolio
// coinciden con test/oracle/fold.ts, una implementación independiente.
// Un 20 % de los usuarios arranca con una venta en corto heredada (D-01), para recorrer
// también las reglas de cobertura (D-03), que la API sola nunca generaría, y un 10 % con el
// cash negativo por una compra heredada sin fondos (issue #68).
// En régimen ninguna LIMIT queda sin respaldo: cero UNBACKED al final (issue #6). Si aparece,
// es un bug de reserva en place_order, no de historia heredada.
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
  expect(cashRow.inconsistent, `${ctx}: historia inconsistente`).toBe(O.inconsistentHistory(s));
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
    const users: number[] = [];

    for (let u = 0; u < USERS; u++) {
      const userid = await newUser('parity');
      users.push(userid);
      const s = O.newState();
      const pending: bigint[] = [];

      const legacy = rnd();
      if (legacy < 0.2) {
        // Historia heredada: CASH_IN, BUY 2n, SELL 3n → n acciones en corto.
        const q = pick(qs);
        const n = BigInt(int(1, 20));
        const cashCents = BigInt(int(100_000, 2_000_000)) + n * q.closeCents;
        await legacyShort(userid, q.instrumentid, q.closeCents, cashCents, n);
        s.cashCents = cashCents - n * q.closeCents;      // el CASH_IN; las ejecuciones lo ajustan
        O.fill(s, 'BUY', q.instrumentid, 2n * n, q.closeCents);
        O.fill(s, 'SELL', q.instrumentid, 3n * n, q.closeCents);
        await compare(userid, s, 'historia heredada');
      } else if (legacy < 0.3) {
        // Historia heredada: CASH_IN y una BUY de más → cash negativo (issue #68). La API rechaza
        // compras y retiros hasta que los depósitos lo cubran, y ahí la marca se va.
        const q = pick(qs);
        const n = BigInt(int(2, 20));
        const total = n * q.closeCents;
        const cashCents = total - 1n - BigInt(int(0, 500_000)) % (total - 1n);   // entre 1 y total − 1
        await admin.query(
          `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq) VALUES
             ($1, $3, $4, 0.01, 'MARKET', 'CASH_IN', 'FILLED', timezone('UTC', now()), 1),
             ($2, $3, $5, $6, 'MARKET', 'BUY', 'FILLED', timezone('UTC', now()), 2)`,
          [ars, q.instrumentid, userid, cashCents.toString(), n.toString(), fmt(q.closeCents)]);
        s.cashCents = cashCents;
        O.fill(s, 'BUY', q.instrumentid, n, q.closeCents);
        await compare(userid, s, 'cash heredado negativo');
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
          const size = byAmount ? O.sizeFromAmount(cents(amount!), q.closeCents) : BigInt(int(1, 60));
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
          // SELL MARKET, por size o por amount (D-11)
          const byAmount = rnd() < 0.4;
          const amount = byAmount ? fmt(BigInt(int(1, 300_000))) : null;
          const size = byAmount ? O.sizeFromAmount(cents(amount!), q.closeCents) : BigInt(int(1, 60));
          step = `SELL MARKET ${q.instrumentid} ${byAmount ? 'amount ' + amount : 'size ' + size}`;
          if (size === 0n) {
            await expect(placeOrder(pool, { userid, key, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, amount }), step)
              .rejects.toMatchObject({ code: 'APP02' });
          } else {
            const exp = O.placeOrder(s, { side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size, priceCents: q.closeCents }, 0n);
            const r = byAmount
              ? await placeOrder(pool, { userid, key, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, amount })
              : await placeOrder(pool, { userid, key, side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size });
            expect(r.body.status, step).toBe(exp);
            expect(BigInt(r.body.size!), step).toBe(size);
          }
        } else if (kind < 0.80) {
          // LIMIT alrededor del close (±10 %), para que a veces cruce y a veces no; por size o por amount
          const side = rnd() < 0.5 ? 'BUY' : 'SELL';
          const limitCents = (q.closeCents * BigInt(int(90, 110))) / 100n;
          const limit = fmt(limitCents);
          const byAmount = rnd() < 0.3;
          const amount = byAmount ? fmt(limitCents * BigInt(int(1, 40)) + BigInt(int(0, Number(limitCents) - 1))) : null;
          const size = byAmount ? O.sizeFromAmount(cents(amount!), limitCents) : BigInt(int(1, 40));
          step = `${side} LIMIT ${q.instrumentid} ${byAmount ? 'amount ' + amount : 'size ' + size} @ ${limit}`;
          // el id lo asigna la DB; el oráculo lo recibe después
          const r = byAmount
            ? await placeOrder(pool, { userid, key, side, type: 'LIMIT', instrumentid: q.instrumentid, amount, limit })
            : await placeOrder(pool, { userid, key, side, type: 'LIMIT', instrumentid: q.instrumentid, size, limit });
          expect(BigInt(r.body.size!), step).toBe(size);
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
    // Cada ejecución que el oráculo dio por válida se confirmó FILLED (ya comparado paso a paso);
    // además, ninguna LIMIT de estos usuarios se canceló por falta de respaldo.
    const unbacked = (await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.orders WHERE userid = ANY($1) AND cancel_reason = 'UNBACKED'", [users])).rows[0].n;
    expect(unbacked, 'LIMIT canceladas por UNBACKED en régimen').toBe(0);
  }, 300_000);
});

// Tope por orden (D-14, issue #2): cerca de 10¹⁵ ARS, por los cuatro caminos (LIMIT/MARKET ×
// size/amount) y con usuarios que llevan la orden a cada estado. 422 por el tope de la orden si y
// solo si size × price > 10¹⁵; si no, lo que decide el oráculo, salvo que confirmar el movimiento
// deje el cash fuera de ±10¹⁵ (el tope del estado, otro 422, que se distingue por el mensaje).
// Tamaño por env: PARITY_CAP_CASES (64).
describe(`tope por orden cerca de 10¹⁵ ARS (${Number(process.env.PARITY_CAP_CASES ?? 64)} casos, seed ${SEED})`, () => {
  const CAP = 100_000_000_000_000_000n;   // 10¹⁵ ARS en centavos
  const MAX_SIZE = 2_147_483_646;         // el sembrado compra size + 1, que tiene que entrar en integer
  const ORDER_CAP = /importe de la orden supera/;
  const STATE_CAP = /cash quedaría fuera/;
  const PATHS = [['LIMIT', 'size'], ['LIMIT', 'amount'], ['MARKET', 'size'], ['MARKET', 'amount']] as const;

  const clone = (s: O.OracleState): O.OracleState => ({
    cashCents: s.cashCents, soldShort: s.soldShort, positions: new Map(s.positions),
    pendingBuys: new Map(s.pendingBuys), pendingSells: new Map(s.pendingSells) });
  const outOfCap = (s: O.OracleState) => s.cashCents > CAP || s.cashCents < -CAP;

  /** Instrumento propio con close `closeCents` hoy: MARKET ejecuta a ese precio y una LIMIT a ese precio cruza. */
  async function instrument(tag: string, closeCents: bigint): Promise<number> {
    const id = (await admin.query<{ id: number }>(
      "INSERT INTO app.instruments (ticker, name, type) VALUES ($1, $2, 'ACCIONES') RETURNING id", [tag, `Prueba tope ${tag}`],
    )).rows[0].id;
    await admin.query(
      `INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
       VALUES ($1, $2, $2, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`, [id, fmt(closeCents)]);
    return id;
  }

  /**
   * Historia heredada (admin) que deja `cashCents` de cash y `shares` acciones de `iid`: CASH_IN
   * 1.000,00 → BUY shares + 1 @ 0,01 → SELL 1 al precio que cierra el cash. Por la API, llegar
   * cerca de 10¹⁵ pediría millones de depósitos (D-05).
   */
  async function seed(u: number, s: O.OracleState, iid: number, cashCents: bigint, shares: bigint) {
    const sellCents = cashCents - 100_000n + shares + 1n;
    const ins = (side: string, i: number, size: bigint, priceCents: bigint, seq: number) => admin.query(
      `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
       VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`,
      [i, u, size.toString(), fmt(priceCents), side, seq]);
    await ins('CASH_IN', ars, 100_000n, 1n, 1);
    await ins('BUY', iid, shares + 1n, 1n, 2);
    await ins('SELL', iid, 1n, sellCents, 3);
    s.cashCents = 100_000n;
    O.fill(s, 'BUY', iid, shares + 1n, 1n);
    O.fill(s, 'SELL', iid, 1n, sellCents);
  }

  it('422 por el tope de la orden si y solo si size × price > 10¹⁵; si no, la decisión del oráculo, en los cuatro estados', async () => {
    const CASES = Number(process.env.PARITY_CAP_CASES ?? 64);
    const rnd = mulberry32(SEED + 1);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const big = (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(rnd() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n;
    const seen = new Set<string>();

    for (let c = 0; c < CASES; c++) {
      const [type, by] = PATHS[c % 4];
      const side = (c >> 2) % 2 === 0 ? 'BUY' : 'SELL';
      // size en tres escalas; el precio en la frontera (±1 centavo) o a ±50 % de ella.
      const size = BigInt([() => int(1, 9), () => int(10, 100_000), () => int(100_001, MAX_SIZE)][int(0, 2)]());
      const edge = CAP / size;
      const priceCents = rnd() < 0.5 ? edge + BigInt(int(-1, 1)) : big(edge / 2n, edge + edge / 2n);
      // Por amount, cualquier resto: la cantidad sigue siendo `size` (D-11, división entera).
      const amountCents = size * priceCents + big(0n, priceCents - 1n);
      const iid = await instrument(`CAP${c}`, priceCents);

      // Estado del usuario: sin nada (REJECTED) o con lo necesario para operar (FILLED o NEW). Una
      // SELL arranca con cash al azar: ejecutarla puede pasar el tope del estado. Una BUY ejecutada
      // deja un costo de hasta 10²¹ micro-ARS, por encima de bigint (D-14: el costo viaja como numeric).
      const u = await newUser('parity-cap');
      const s = O.newState();
      const funded = rnd() < 0.75;
      if (funded && side === 'BUY') await seed(u, s, iid, CAP, 0n);
      if (funded && side === 'SELL') await seed(u, s, iid, big(100_000n, CAP), size);
      if (funded) await compare(u, s, 'sembrado');

      const step = `#${c} ${side} ${type} por ${by}: size ${size} × ${fmt(priceCents)}${by === 'amount' ? ` (amount ${fmt(amountCents)})` : ''}`;
      const args = { userid: u, key: 'cap', side, type, instrumentid: iid,
        ...(by === 'size' ? { size } : { amount: fmt(amountCents) }), ...(type === 'LIMIT' ? { limit: fmt(priceCents) } : {}) };
      const order = { side, type, instrumentid: iid, size, priceCents } as const;
      const trial = clone(s);
      const decision = O.placeOrder(trial, order, 0n);

      if (size * priceCents > CAP) {
        await expect(placeOrder(pool, args), step).rejects.toMatchObject({ code: 'APP05', message: expect.stringMatching(ORDER_CAP) });
        seen.add(`${type}/${by}: tope de la orden`);
      } else if (decision === 'FILLED' && outOfCap(trial)) {
        await expect(placeOrder(pool, args), step).rejects.toMatchObject({ code: 'APP05', message: expect.stringMatching(STATE_CAP) });
        seen.add('tope del estado');
      } else {
        const r = await placeOrder(pool, args);
        const id = BigInt(r.order_id);
        expect(O.placeOrder(s, order, id), step).toBe(decision);
        expect(r.body.status, step).toBe(decision);
        expect(r.body.size, step).toBe(size.toString());
        seen.add(`${type}/${by}: dentro`);
        seen.add(decision);
        if (decision === 'NEW') {
          // Se ejecuta (cruza: el close es el límite) o se cancela. Ejecutar una SELL puede pasar el tope del estado.
          if (rnd() < 0.5) {
            const after = clone(s);
            O.executeLimit(after, id, priceCents);
            const outcome = (await pool.query<{ r: string }>('SELECT app.execute_limit_outcome($1) AS r', [Number(id)])).rows[0].r;
            if (outOfCap(after)) { expect(outcome, step).toBe('LIMIT'); O.cancelOrder(s, id); seen.add('CANCELLED'); }
            else { expect(outcome, step).toBe('FILLED'); O.executeLimit(s, id, priceCents); seen.add('FILLED'); }
          } else {
            expect((await pool.query<{ r: boolean }>('SELECT app.cancel_order($1, $2) AS r', [u, Number(id)])).rows[0].r, step).toBe(true);
            O.cancelOrder(s, id);
            seen.add('CANCELLED');
          }
        }
      }
      await compare(u, s, step);
    }

    // La propiedad recorrió todo: los cuatro caminos a los dos lados del tope, los cuatro estados y el otro 422.
    expect([...seen].sort()).toEqual([
      'CANCELLED', 'FILLED', 'LIMIT/amount: dentro', 'LIMIT/amount: tope de la orden', 'LIMIT/size: dentro',
      'LIMIT/size: tope de la orden', 'MARKET/amount: dentro', 'MARKET/amount: tope de la orden', 'MARKET/size: dentro',
      'MARKET/size: tope de la orden', 'NEW', 'REJECTED', 'tope del estado',
    ].sort());
  }, 120_000);
});
