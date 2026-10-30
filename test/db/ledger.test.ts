// Invariantes de `orders` impuestas por la base (CHECKs y trigger), ventana de precio (D-06),
// orden de ejecución (D-18) y cobertura de un corto heredado (D-03).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { buildPortfolio, type PortfolioRow } from '../../src/domain/portfolio.js';
import { admin, arsId, fmt, legacyShort, newUser, placeOrder, quotes, type Quote } from '../support/db.js';

let ars: number;
let q: Quote;
let u: number;

beforeAll(async () => {
  ars = await arsId();
  [q] = await quotes(1);
  u = await newUser('ledger');
  await placeOrder(admin, { userid: u, key: 'seed', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: '1000000.00' });
});
afterAll(async () => { await admin.end(); await pool.end(); });

const insert = (cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  return admin.query(
    `INSERT INTO app.orders (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => cols[k]));
};
const base = () => ({ instrumentid: q.instrumentid, userid: u, size: 1, price: '1.00', type: 'MARKET', side: 'BUY', status: 'REJECTED', datetime: '2024-01-01' });

describe('CHECKs de orders (aun para quien puede escribir la tabla)', () => {
  it.each([
    ['size = 0', { size: 0 }, '23514'],
    ['size negativo', { size: -1 }, '23514'],
    ['price = 0', { price: '0' }, '23514'],
    ["status en minúscula", { status: 'filled' }, '23514'],
    ["side en minúscula", { side: 'buy' }, '23514'],
    ["type en minúscula", { type: 'market' }, '23514'],
    ['MARKET en NEW', { type: 'MARKET', status: 'NEW' }, '23514'],
    ['CASH_IN sobre una acción', { side: 'CASH_IN', price: '0.01' }, '23514'],
    ['CASH_IN con price 1 (pesos, no centavos)', { side: 'CASH_IN', price: '1' }, '23514'],
    ['REJECTED con balance_seq', { balance_seq: 1 }, '23514'],
    ['userid NULL', { userid: null }, '23502'],
    ['price NULL', { price: null }, '23502'],
  ])('%s → rechazado', async (_name, patch, code) => {
    await expect(insert({ ...base(), ...patch })).rejects.toMatchObject({ code });
  });

  it('marketdata: close ≤ 0 y dos cotizaciones el mismo día → rechazado', async () => {
    await expect(admin.query("INSERT INTO app.marketdata (instrumentid, close, date) VALUES ($1, 0, '2099-01-01')", [q.instrumentid]))
      .rejects.toMatchObject({ code: '23514' });
    const d = (await admin.query<{ date: string }>('SELECT date::text FROM app.marketdata WHERE instrumentid = $1 LIMIT 1', [q.instrumentid])).rows[0].date;
    await expect(admin.query('INSERT INTO app.marketdata (instrumentid, close, date) VALUES ($1, 1, $2)', [q.instrumentid, d]))
      .rejects.toMatchObject({ code: '23505' });
  });
});

describe('trigger orders_guard', () => {
  it('DELETE prohibido', async () => {
    await expect(admin.query('DELETE FROM app.orders WHERE userid = $1', [u])).rejects.toMatchObject({ code: '23000' });
  });
  it('una FILLED es inmutable (size, price, status)', async () => {
    for (const set of ['size = size + 1', "price = '2.00'", "status = 'NEW'"]) {
      await expect(admin.query(`UPDATE app.orders SET ${set} WHERE userid = $1 AND status = 'FILLED'`, [u])).rejects.toMatchObject({ code: '23000' });
    }
  });
  it('FILLED con balance_seq salteada o repetida → rechazado; MAX + 1 → aceptado', async () => {
    const max = Number((await admin.query('SELECT COALESCE(max(balance_seq), 0) AS m FROM app.orders WHERE userid = $1', [u])).rows[0].m);
    const cash = { ...base(), side: 'CASH_IN', instrumentid: ars, price: '0.01', status: 'FILLED' };
    await expect(insert({ ...cash, balance_seq: max + 2 })).rejects.toMatchObject({ code: '23000' });
    await expect(insert({ ...cash, balance_seq: max })).rejects.toMatchObject({ code: '23000' });
    await expect(insert({ ...cash, balance_seq: max + 1 })).resolves.toBeDefined();
  });
  it('NEW → FILLED cambiando otro campo: rechazado. NEW → REJECTED: rechazado. NEW → CANCELLED: ok', async () => {
    const lim = await placeOrder(admin, { userid: u, key: 'lim-t', side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, limit: '1.00' });
    const id = Number(lim.order_id);
    await expect(admin.query(
      "UPDATE app.orders SET status = 'FILLED', balance_seq = (SELECT max(balance_seq) + 1 FROM app.orders WHERE userid = $2), price = '2.00' WHERE id = $1", [id, u]))
      .rejects.toMatchObject({ code: '23000' });
    await expect(admin.query("UPDATE app.orders SET status = 'REJECTED' WHERE id = $1", [id])).rejects.toMatchObject({ code: '23000' });
    await expect(admin.query("UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'USER' WHERE id = $1", [id])).resolves.toBeDefined();
  });

  // Issue #21: cancel_reason se escribe solo al pasar a CANCELLED, siempre en ese paso, y no cambia después.
  it('cancel_reason: sin motivo al cancelar, con motivo sin cancelar, o cambiado después → rechazado', async () => {
    const lim = await placeOrder(admin, { userid: u, key: 'lim-reason', side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, limit: '1.00' });
    const id = Number(lim.order_id);
    const nextSeq = '(SELECT max(balance_seq) + 1 FROM app.orders WHERE userid = $2)';
    // Cancelar sin motivo es lo que hacían las funciones anteriores: APP04 (503, reintentable) en vez de 23000 (500).
    await expect(admin.query("UPDATE app.orders SET status = 'CANCELLED' WHERE id = $1", [id])).rejects.toMatchObject({ code: 'APP04' });
    await expect(admin.query("UPDATE app.orders SET cancel_reason = 'USER' WHERE id = $1", [id])).rejects.toMatchObject({ code: '23000' });
    await expect(admin.query(`UPDATE app.orders SET status = 'FILLED', balance_seq = ${nextSeq}, cancel_reason = 'LIMIT' WHERE id = $1`, [id, u]))
      .rejects.toMatchObject({ code: '23000' });
    await expect(insert({ ...base(), cancel_reason: 'USER' })).rejects.toMatchObject({ code: '23000' });   // REJECTED con motivo
    await expect(insert({ ...base(), type: 'LIMIT', status: 'CANCELLED' })).rejects.toMatchObject({ code: 'APP04' });   // sin motivo
    await expect(admin.query("UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'OTRO' WHERE id = $1", [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'orders_cancel_reason_valid' });
    expect((await admin.query('SELECT status, cancel_reason FROM app.orders WHERE id = $1', [id])).rows[0]).toEqual({ status: 'NEW', cancel_reason: null });

    await admin.query("UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'LIMIT' WHERE id = $1", [id]);
    await expect(admin.query("UPDATE app.orders SET cancel_reason = 'USER' WHERE id = $1", [id])).rejects.toMatchObject({ code: '23000' });
    await expect(admin.query('UPDATE app.orders SET cancel_reason = NULL WHERE id = $1', [id])).rejects.toMatchObject({ code: '23000' });
  });

  it('cancel_reason: el CHECK lo impone aunque el trigger no corra', async () => {
    // session_replication_role = replica apaga los triggers de la sesión, no los CHECKs; todo se revierte.
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const tryInsert = async (patch: Record<string, unknown>) => {
        const cols: Record<string, unknown> = { ...base(), ...patch };
        const keys = Object.keys(cols);
        await c.query('SAVEPOINT s');
        try {
          await c.query(`INSERT INTO app.orders (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => cols[k]));
          return null;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT s');
          return { code: (e as { code?: string }).code, constraint: (e as { constraint?: string }).constraint };
        }
      };
      const iff = { code: '23514', constraint: 'orders_cancel_reason_iff_cancelled' };
      expect(await tryInsert({ cancel_reason: 'USER' })).toEqual(iff);                        // REJECTED con motivo
      expect(await tryInsert({ type: 'LIMIT', status: 'CANCELLED' })).toEqual(iff);           // CANCELLED sin motivo
      expect(await tryInsert({ type: 'LIMIT', status: 'CANCELLED', cancel_reason: 'LIMIT' })).toBeNull();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('ventana de precio (D-06)', () => {
  afterAll(async () => { await admin.query('UPDATE app.settings SET price_max_age_days = NULL'); });

  it('con 7 días y cotizaciones de 2023: MARKET → NO_PRICE sin orden ni clave; LIMIT entra; el executor tampoco ejecuta', async () => {
    await admin.query('UPDATE app.settings SET price_max_age_days = 7');
    const before = Number((await admin.query('SELECT count(*) FROM app.orders WHERE userid = $1', [u])).rows[0].count);
    await expect(placeOrder(pool, { userid: u, key: 'np', side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 1 }))
      .rejects.toMatchObject({ code: 'APP01' });
    expect(Number((await admin.query('SELECT count(*) FROM app.orders WHERE userid = $1', [u])).rows[0].count)).toBe(before);
    expect((await admin.query('SELECT 1 FROM app.idempotency_keys WHERE userid = $1 AND key = $2', [u, 'np'])).rowCount).toBe(0);
    const lim = await placeOrder(pool, { userid: u, key: 'np-lim', side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 1, limit: '1.00' });
    expect(lim.body.status).toBe('NEW');
    await expect(pool.query('SELECT app.execute_limit($1)', [Number(lim.order_id)])).rejects.toMatchObject({ code: 'APP01' });
  });

  it('una cotización con fecha futura se ignora', async () => {
    const before = (await admin.query('SELECT close::text, price_date::text FROM app.valid_close($1)', [q.instrumentid])).rows[0];
    const ins = await admin.query<{ id: number }>("INSERT INTO app.marketdata (instrumentid, close, date) VALUES ($1, 999999, '2099-01-01') RETURNING id", [q.instrumentid]);
    try {
      expect((await admin.query('SELECT close::text, price_date::text FROM app.valid_close($1)', [q.instrumentid])).rows[0]).toEqual(before);
    } finally {
      await admin.query('DELETE FROM app.marketdata WHERE id = $1', [ins.rows[0].id]);
    }
  });
});

describe('orden de ejecución (D-18): el costo sigue balance_seq, no id', () => {
  it('BUY 10 al close; LIMIT BUY 10 a un precio alto queda NEW; SELL 10; se ejecuta la LIMIT → costo = precio límite', async () => {
    const w = await newUser('seq');
    const limitCents = q.closeCents * 2n;
    await placeOrder(pool, { userid: w, key: 'c0', side: 'CASH_IN', type: 'MARKET', instrumentid: ars, amount: fmt(10n * q.closeCents + 10n * limitCents) });
    const b1 = await placeOrder(pool, { userid: w, key: 'c1', side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size: 10 });
    const lim = await placeOrder(pool, { userid: w, key: 'c2', side: 'BUY', type: 'LIMIT', instrumentid: q.instrumentid, size: 10, limit: fmt(limitCents) });
    const s1 = await placeOrder(pool, { userid: w, key: 'c3', side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size: 10 });
    expect([b1.body.status, lim.body.status, s1.body.status]).toEqual(['FILLED', 'NEW', 'FILLED']);
    expect((await pool.query<{ r: boolean }>('SELECT app.execute_limit($1) AS r', [Number(lim.order_id)])).rows[0].r).toBe(true);

    const seqs = (await admin.query<{ id: number }>('SELECT id FROM app.orders WHERE userid = $1 AND status = $2 ORDER BY balance_seq', [w, 'FILLED'])).rows;
    expect(seqs.at(-1)!.id).toBe(Number(lim.order_id));   // id menor que la SELL, secuencia mayor
    const pos = (await admin.query<{ qty: string; cost_total: string }>('SELECT qty, cost_total FROM app.read_portfolio($1) WHERE kind = 1', [w])).rows[0];
    expect(BigInt(pos.qty)).toBe(10n);
    expect(BigInt(pos.cost_total)).toBe(10n * limitCents * 10_000n);   // ordenando por id daría un promedio
  });
});

describe('cubrir un corto heredado (D-01, D-02, D-03)', () => {
  const pos = async (w: number) =>
    (await admin.query('SELECT qty::text, cost_total::text, inconsistent FROM app.read_portfolio($1) WHERE kind = 1 AND instrumentid = $2', [w, q.instrumentid])).rows[0] ?? null;
  const flag = async (w: number) => (await admin.query('SELECT inconsistent FROM app.read_portfolio($1) WHERE kind = 0', [w])).rows[0].inconsistent;
  const shortUser = async () => {
    const w = await newUser('short');
    await legacyShort(w, q.instrumentid, q.closeCents, 100_000_00n + 10n * q.closeCents);
    return w;
  };
  const buy = (w: number, key: string, size: number) =>
    placeOrder(pool, { userid: w, key, side: 'BUY', type: 'MARKET', instrumentid: q.instrumentid, size });

  it('estado heredado: qty −10, costo 0, marcada', async () => {
    const w = await shortUser();
    expect(await pos(w)).toEqual({ qty: '-10', cost_total: '0', inconsistent: true });
    expect(await flag(w)).toBe(true);
  });

  it('vender con la posición en corto → REJECTED', async () => {
    const w = await shortUser();
    expect((await placeOrder(pool, { userid: w, key: 's', side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size: 1 })).body.status).toBe('REJECTED');
  });

  it('compra 15 → qty 5 al costo de 5 (no de 15); la posición vuelve a ser normal; la marca histórica queda', async () => {
    const w = await shortUser();
    expect((await buy(w, 'c15', 15)).body.status).toBe('FILLED');
    expect(await pos(w)).toEqual({ qty: '5', cost_total: (5n * q.closeCents * 10_000n).toString(), inconsistent: false });
    expect(await flag(w)).toBe(true);
    const rows = (await admin.query<PortfolioRow>('SELECT * FROM app.read_portfolio($1)', [w])).rows;
    const p = buildPortfolio(w, rows).positions.find((x) => x.instrumentid === q.instrumentid)!;
    expect(p).toMatchObject({ costo_unitario: `${fmt(q.closeCents)}00`, rendimiento_pct: '0.00', inconsistent: false });
  });

  it('compra exactamente 10 → posición cerrada, sin fila; la orden se confirma', async () => {
    const w = await shortUser();
    expect((await buy(w, 'c10', 10)).body.status).toBe('FILLED');
    expect(await pos(w)).toBeNull();
    expect(await flag(w)).toBe(true);
  });

  it('compra 5 → sigue en corto (−5), costo 0, marcada', async () => {
    const w = await shortUser();
    await buy(w, 'c5', 5);
    expect(await pos(w)).toEqual({ qty: '-5', cost_total: '0', inconsistent: true });
  });

  it('cubrir, cerrar y reabrir: el costo es solo el de la reapertura', async () => {
    const w = await shortUser();
    await buy(w, 'd1', 15);
    await placeOrder(pool, { userid: w, key: 'd2', side: 'SELL', type: 'MARKET', instrumentid: q.instrumentid, size: 5 });
    expect(await pos(w)).toBeNull();
    await buy(w, 'd3', 2);
    expect(await pos(w)).toEqual({ qty: '2', cost_total: (2n * q.closeCents * 10_000n).toString(), inconsistent: false });
  });
});
