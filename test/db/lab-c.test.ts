// La variante C del lab (issue #72, lab/c/snapshot.sql) contra Postgres real, en una base propia: el
// archivo renombra app.c_state y no puede correr sobre la base compartida de las otras suites.
// C tiene que dar siempre lo mismo que el fold completo de A (app.c_state_full) y que la lectura de
// A sin caché: sin snapshot (frío), con un snapshot y un delta de compras y ventas posteriores, y
// después de republicar. La republicación sigue la regla del benchmark: con snapshot, recién cuando
// el delta llega a K = 500 (499 no publica); sin snapshot, apenas hay historia. Y sobrevive a un
// bootstrap, que reinstala las funciones de A: volver a correr el archivo deja C otra vez.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/db/bootstrap.js';
import { recreateDatabase } from '../support/global-setup.js';
import { SERVER_URL, dbUrl } from '../support/urls.js';

const DB = 'cocos_lab_c_test';
const SNAPSHOT_SQL = readFileSync(resolve(import.meta.dirname, '../../lab/c/snapshot.sql'), 'utf8');
const quiet = { log: () => undefined };
let db: pg.Pool;
let ars: number;
let inst: number[];

const STATE_COLS = 'kind, instrumentid, qty, cost_total, inconsistent, cash_cents, last_seq, filled_count';

// PRNG determinista: la historia es la misma en cada corrida.
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

/**
 * `n` FILLED más para el usuario, como historia heredada (como administrador, con balance_seq
 * consecutivo): compras y ventas parciales y totales sobre dos instrumentos, a precios distintos.
 */
async function addHistory(u: number, n: number, seed: number) {
  const rnd = mulberry32(seed);
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows: [{ seq }] } = await c.query<{ seq: string }>(
      'SELECT COALESCE(max(balance_seq), 0)::text AS seq FROM app.orders WHERE userid = $1', [u]);
    const qty = new Map<number, number>();
    for (const r of (await c.query<{ instrumentid: number; qty: string }>(
      `SELECT instrumentid, qty::text FROM app.c_state_full($1) WHERE kind = 1`, [u])).rows) qty.set(r.instrumentid, Number(r.qty));
    let s = Number(seq);
    const ins = (iid: number, side: string, size: number, price: string) => c.query(
      `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
       VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`, [iid, u, size, price, side, ++s]);
    if (s === 0) await ins(ars, 'CASH_IN', 2_000_000_000, '0.01');
    for (let k = 0; k < n; k++) {
      const iid = inst[Math.floor(rnd() * inst.length)];
      const held = qty.get(iid) ?? 0;
      const price = (1 + rnd() * 9).toFixed(2);
      if (held > 0 && rnd() < 0.4) {
        const size = rnd() < 0.2 ? held : Math.max(1, Math.floor(held * rnd()));   // a veces cierra la posición
        await ins(iid, 'SELL', size, price);
        qty.set(iid, held - size);
      } else {
        const size = 1 + Math.floor(rnd() * 20);
        await ins(iid, 'BUY', size, price);
        qty.set(iid, held + size);
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function newUser(): Promise<number> {
  return (await db.query<{ id: number }>(
    "INSERT INTO app.users (email, accountnumber) VALUES ('lab-c@test.local', '1') RETURNING id")).rows[0].id;
}

/** Lo que devuelve C y lo que devuelve el fold completo de A, para comparar. */
async function states(u: number) {
  const q = async (fn: string) => (await db.query(`SELECT ${STATE_COLS} FROM app.${fn}($1) ORDER BY kind, instrumentid`, [u])).rows;
  return { c: await q('c_state'), full: await q('c_state_full') };
}
const snapshotOf = async (u: number) => (await db.query<{ last_seq: string }>(
  'SELECT last_seq::text FROM app.balance_snapshots WHERE userid = $1', [u])).rows[0]?.last_seq ?? null;
const publish = async (u: number, force = false) => (await db.query<{ ok: boolean }>(
  'SELECT app.c_publish($1, $2) AS ok', [u, force])).rows[0].ok;
const portfolio = async (u: number) => (await db.query('SELECT * FROM app.read_portfolio($1)', [u])).rows;
const isC = async () => (await db.query<{ c: boolean }>(
  "SELECT position('balance_snapshots' IN prosrc) > 0 AS c FROM pg_proc WHERE oid = 'app.c_state(int)'::regprocedure")).rows[0].c;

beforeAll(async () => {
  await recreateDatabase(DB);
  await bootstrap({ adminUrl: dbUrl(DB), apiPassword: 'api', ...quiet });
  db = new pg.Pool({ connectionString: dbUrl(DB), max: 2 });
  await db.query(SNAPSHOT_SQL);
  ars = (await db.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'ARS'")).rows[0].id;
  inst = (await db.query<{ id: number }>("SELECT id FROM app.instruments WHERE type <> 'MONEDA' ORDER BY id LIMIT 2")).rows.map((r) => r.id);
});

afterAll(async () => {
  await db?.end();
  const c = new pg.Client({ connectionString: SERVER_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await c.end();
});

describe('C del lab: snapshot + delta (lab/c/snapshot.sql)', () => {
  it('instala C sobre el fold de A: c_state lee el snapshot, c_state_full es el de A', async () => {
    expect(await isC()).toBe(true);
    const full = (await db.query<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE oid = 'app.c_state_full(int)'::regprocedure")).rows[0].src;
    expect(full).not.toContain('balance_snapshots');
  });

  it('sin snapshot (frío) da lo mismo que el fold completo', async () => {
    const u = await newUser();
    await addHistory(u, 300, 1);
    expect(await snapshotOf(u)).toBeNull();
    const { c, full } = await states(u);
    expect(c.length).toBeGreaterThan(1);
    expect(c).toEqual(full);
  });

  it('snapshot + un delta de compras, ventas y cierres da lo mismo que el fold completo y que leer sin caché', async () => {
    const u = await newUser();
    await addHistory(u, 400, 2);
    expect(await publish(u, true)).toBe(true);
    const at = await snapshotOf(u);
    await addHistory(u, 300, 3);
    expect(await snapshotOf(u)).toBe(at);                     // el delta no se publicó: c_state lo aplica
    const { c, full } = await states(u);
    expect(c).toEqual(full);
    const cached = await portfolio(u);
    await db.query('DELETE FROM app.balance_snapshots WHERE userid = $1', [u]);
    expect(await portfolio(u)).toEqual(cached);
  });

  it('republica con K = 500: sin snapshot apenas hay historia; con snapshot, a los 500 de delta y no a los 499', async () => {
    expect((await db.query<{ k: number }>('SELECT snapshot_k AS k FROM app.settings')).rows[0].k).toBe(500);
    const u = await newUser();
    expect(await publish(u)).toBe(false);                     // sin historia, nada que publicar
    await addHistory(u, 10, 4);
    expect(await publish(u)).toBe(true);                      // sin snapshot: reconstruye
    const first = await snapshotOf(u);
    await addHistory(u, 499, 5);
    expect(await publish(u)).toBe(false);
    expect(await snapshotOf(u)).toBe(first);
    await addHistory(u, 1, 6);
    expect(await publish(u)).toBe(true);
    expect(Number(await snapshotOf(u))).toBe(Number(first) + 500);
    const { c, full } = await states(u);
    expect(c).toEqual(full);
    expect(await publish(u, true)).toBe(false);               // al día: ni el calentamiento republica
  });

  it('api no ve las tablas ni las funciones de C, y lee el portfolio por read_portfolio', async () => {
    const api = new pg.Client({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
    await api.connect();
    try {
      await expect(api.query('SELECT * FROM app.balance_snapshots')).rejects.toThrow(/permission denied/);
      await expect(api.query('SELECT * FROM app.c_state(1)')).rejects.toThrow(/permission denied/);
      expect((await api.query('SELECT * FROM app.read_portfolio(1)')).rows.length).toBeGreaterThan(0);
    } finally {
      await api.end();
    }
  });

  it('después de un bootstrap (que reinstala el c_state de A), volver a correrlo deja C y los mismos números', async () => {
    const u = await newUser();
    await addHistory(u, 200, 7);
    expect(await publish(u, true)).toBe(true);
    await addHistory(u, 50, 8);
    const before = await states(u);
    await bootstrap({ adminUrl: dbUrl(DB), apiPassword: 'api', ...quiet });
    expect(await isC()).toBe(false);
    await db.query(SNAPSHOT_SQL);
    await db.query(SNAPSHOT_SQL);                             // dos veces seguidas: c_state_full sigue siendo el de A
    expect(await isC()).toBe(true);
    const full = (await db.query<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE oid = 'app.c_state_full(int)'::regprocedure")).rows[0].src;
    expect(full).not.toContain('balance_snapshots');
    expect(await states(u)).toEqual(before);
    expect(before.c).toEqual(before.full);
  });
});
