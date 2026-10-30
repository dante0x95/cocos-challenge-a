// Executor de LIMIT con muchas pendientes (issue #9, D-28): candidatas por índice con una sola
// cotización por instrumento, reparto por usuario, cursor, cabeza de línea (un usuario con el
// lock tomado, un instrumento que se quedó sin cotización), presupuesto de tiempo, dos corridas
// concurrentes sobre el mismo lote y validación de los parámetros del endpoint.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { executeLimits } from '../../src/repositories/ops.repo.js';
import { admin, apiClient, arsId, newUser } from '../support/db.js';

let ars: number;

/** Instrumento propio con una cotización de hoy: ninguna otra prueba lo usa. */
async function instrument(ticker: string, close: string): Promise<number> {
  const id = (await admin.query<{ id: number }>(
    "INSERT INTO app.instruments (ticker, name, type) VALUES ($1, $2, 'ACCIONES') RETURNING id", [ticker, `Executor 9 ${ticker}`],
  )).rows[0].id;
  await admin.query(
    `INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
     VALUES ($1, $2, $2, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)`, [id, close]);
  return id;
}

/** Deja al instrumento sin cotización: sus NEW que sobran ya no son candidatas para nadie. */
const retire = (iid: number) => admin.query('DELETE FROM app.marketdata WHERE instrumentid = $1', [iid]);

/** Usuario con `shares` acciones de `iid` y cash 0, como historia heredada (admin). */
async function holder(iid: number, shares: number, tag = 'ex9'): Promise<number> {
  const u = await newUser(tag);
  await admin.query(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq) VALUES
       ($1, $2, $3, 0.01, 'MARKET', 'CASH_IN', 'FILLED', timezone('UTC', now()), 1),
       ($4, $2, $5, 1.00, 'MARKET', 'BUY',     'FILLED', timezone('UTC', now()), 2)`,
    [ars, u, shares * 100, iid, shares]);
  return u;
}

/** n SELL LIMIT NEW de 1 acción del usuario a `price`, en una sentencia. Ids en orden. */
async function sellLimits(u: number, iid: number, n: number, price: string): Promise<string[]> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
     SELECT $1, $2, 1, $3, 'LIMIT', 'SELL', 'NEW', timezone('UTC', now()) FROM generate_series(1, $4::int)
     RETURNING id::text`, [iid, u, price, n]);
  return r.rows.map((x) => x.id).sort((a, b) => Number(a) - Number(b));
}

const statuses = async (ids: string[]) => {
  const r = await admin.query<{ id: string; status: string }>('SELECT id::text, status FROM app.orders WHERE id = ANY($1::bigint[])', [ids]);
  return new Map(r.rows.map((x) => [x.id, x.status]));
};
const filledCount = async (u: number) =>
  (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.orders WHERE userid = $1 AND status = 'FILLED' AND type = 'LIMIT'", [u])).rows[0].n;

const userLock = "SELECT pg_advisory_xact_lock(hashtext('user-balance'), $1)";

/** Espera hasta que alguna sesión que cumpla `where` esté bloqueada en un advisory lock. */
async function waitingOnLock(where: string, arg: unknown, failed: () => unknown): Promise<void> {
  for (;;) {
    const err = failed();
    if (err) throw err;
    const w = await admin.query(
      `SELECT 1 FROM pg_stat_activity WHERE ${where} AND wait_event_type = 'Lock' AND wait_event = 'advisory'`, [arg]);
    if (w.rowCount) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Ejecuta lo que otras suites dejaron cruzando, así cada prueba de acá cuenta solo lo suyo. */
async function drain(): Promise<void> {
  for (;;) {
    const r = await executeLimits({ max: 10_000, perUser: 10_000, maxMs: 60_000 });
    if (r.executed.length + r.not_crossed.length + r.cancelled.length === 0) return;
  }
}

beforeAll(async () => {
  ars = await arsId();
  await drain();
});
afterAll(async () => { await admin.end(); await pool.end(); });

describe('limit_candidates con 50.000 NEW: por índice, una cotización por instrumento', () => {
  // 60 instrumentos con cotización, 1.000 usuarios, 50.000 NEW LIMIT que no cruzan (SELL muy por
  // encima del close, BUY muy por debajo) y 5 SELL que sí. Sembradas como admin, en una sentencia.
  const PENDING = 50_000;
  let crossing: string[];
  let mid: string;
  let instruments: number;

  beforeAll(async () => {
    await admin.query(`
      INSERT INTO app.instruments (ticker, name, type)
        SELECT 'EX9A' || lpad(g::text, 3, '0'), 'Executor 9 plan ' || g, 'ACCIONES' FROM generate_series(1, 60) g;
      INSERT INTO app.marketdata (instrumentid, close, previousclose, date)
        SELECT i.id, 100 + (i.id % 50), 100 + (i.id % 50), (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
          FROM app.instruments i WHERE i.ticker LIKE 'EX9A%';
      INSERT INTO app.users (email, accountnumber)
        SELECT 'ex9plan-' || g || '@test.local', '9' || lpad(g::text, 9, '0') FROM generate_series(1, 1000) g;
      WITH ins AS (SELECT i.id, row_number() OVER (ORDER BY i.id) - 1 AS n, m.close
                     FROM app.instruments i JOIN app.marketdata m ON m.instrumentid = i.id WHERE i.ticker LIKE 'EX9A%'),
           usr AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM app.users WHERE email LIKE 'ex9plan-%')
      INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
        SELECT ins.id, usr.id, 1, CASE WHEN g % 2 = 0 THEN ins.close * 100 ELSE round(ins.close / 100, 2) END, 'LIMIT',
               CASE WHEN g % 2 = 0 THEN 'SELL' ELSE 'BUY' END, 'NEW', timezone('UTC', now())
          FROM generate_series(1, ${PENDING}) g JOIN ins ON ins.n = g % 60 JOIN usr ON usr.n = g % 1000;
    `);
    const i = (await admin.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'EX9A001'")).rows[0].id;
    crossing = (await admin.query<{ id: string }>(
      `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
       SELECT $1, u.id, 1, 1.00, 'LIMIT', 'SELL', 'NEW', timezone('UTC', now())
         FROM (SELECT id FROM app.users WHERE email LIKE 'ex9plan-%' ORDER BY id LIMIT 5) u RETURNING id::text`, [i])).rows.map((r) => r.id);
    // Estadísticas al día: el plan se elige con ellas.
    await admin.query('ANALYZE app.orders');
    mid = (await admin.query<{ id: string }>(
      "SELECT id::text FROM app.orders WHERE status = 'NEW' AND type = 'LIMIT' ORDER BY id OFFSET $1 LIMIT 1", [PENDING / 2])).rows[0].id;
    instruments = (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM app.instruments')).rows[0].n;
  }, 120_000);
  // Las 5 que cruzan no son de nadie más: sin cotización dejan de ser candidatas.
  afterAll(() => admin.query("DELETE FROM app.marketdata WHERE instrumentid IN (SELECT id FROM app.instruments WHERE ticker LIKE 'EX9A%')"));

  interface PlanNode {
    'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Function Name'?: string;
    'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number; Plans?: PlanNode[];
  }
  const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

  /** EXPLAIN ANALYZE del cuerpo de la función, tal como está desplegado, con los parámetros dados. */
  async function plan(after: string): Promise<PlanNode[]> {
    const src = (await admin.query<{ src: string }>(
      "SELECT prosrc AS src FROM pg_proc WHERE oid = 'app.limit_candidates(int, bigint, int)'::regprocedure")).rows[0].src;
    const sql = src.replace(/\bp_max\b/g, '500').replace(/\bp_after\b/g, after).replace(/\bp_per_user\b/g, '50');
    const r = await admin.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    return flatten(r.rows[0]['QUERY PLAN'][0].Plan);
  }

  const rowsOf = (n: PlanNode) => (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'];

  for (const [label, after] of [['sin after_id', () => '0'], ['con after_id a mitad del lote', () => mid]] as const) {
    it(`${label}: Index Scan sobre orders, valid_close una vez por instrumento, sin Sort sobre todas las pendientes`, async () => {
      const nodes = await plan(after());
      const orders = nodes.filter((n) => n['Relation Name'] === 'orders');
      expect(orders.length).toBeGreaterThan(0);
      for (const n of orders) {
        // Acceso por índice: Index Scan, Index Only Scan o Bitmap Heap Scan sobre un Bitmap Index Scan.
        expect(n['Node Type'], JSON.stringify(n)).toMatch(/^(Index (Only )?Scan|Bitmap Heap Scan)$/);
        const index = n['Index Name'] ?? n.Plans?.find((c) => c['Node Type'] === 'Bitmap Index Scan')?.['Index Name'];
        expect(index, JSON.stringify(n)).toMatch(/^orders_new_limit_by_/);
      }
      // Filas leídas de orders (devueltas más filtradas), sumadas: una fracción chica de las pendientes.
      expect(orders.reduce((acc, n) => acc + rowsOf(n), 0)).toBeLessThan(PENDING / 5);
      const closes = nodes.filter((n) => n['Function Name'] === 'valid_close');
      expect(closes.length).toBeGreaterThan(0);
      expect(closes.reduce((acc, n) => acc + n['Actual Loops'], 0)).toBeLessThanOrEqual(instruments);
      for (const n of nodes.filter((n) => n['Node Type'] === 'Sort')) {
        expect(n['Actual Rows'] * n['Actual Loops'], 'Sort solo sobre las que cruzan').toBeLessThan(1_000);
      }
    }, 120_000);
  }

  it('como api (statement_timeout 5 s): devuelve las 5 que cruzan, con y sin after_id', async () => {
    const t0 = Date.now();
    const all = (await pool.query<{ order_id: string }>('SELECT order_id::text FROM app.limit_candidates(500, 0, 50)')).rows.map((r) => r.order_id);
    const rest = (await pool.query<{ order_id: string }>('SELECT order_id::text FROM app.limit_candidates(500, $1, 50)', [mid])).rows.map((r) => r.order_id);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(all).toEqual(expect.arrayContaining(crossing));
    expect(rest).toEqual(crossing.filter((id) => Number(id) > Number(mid)));
  }, 120_000);
});

describe('reparto por usuario y cabeza de línea', () => {
  let inst: number;
  let big: number;
  let bigIds: string[];

  beforeAll(async () => {
    inst = await instrument('EX9BIG', '100.00');
    big = await holder(inst, 2000, 'ex9-big');
    bigIds = await sellLimits(big, inst, 2000, '90.00');   // cruzan: close 100 ≥ 90
  });
  afterAll(() => retire(inst));

  const smallUsers = async (n: number) => {
    const ids: string[] = [];
    for (let k = 0; k < n; k++) ids.push(...(await sellLimits(await holder(inst, 1, 'ex9-small'), inst, 1, '90.00')));
    return ids;
  };

  it('un usuario con 2.000 NEW y 20 de 1, max 500 y 50 por usuario → 50 del grande y las 20 de los demás', async () => {
    const small = await smallUsers(20);
    const r = await executeLimits({ max: 500, perUser: 50 });
    expect(r).toMatchObject({ candidates: 70, errors: [], skipped_users: [], skipped_instruments: [], remaining: 0, after_id: null });
    expect([...r.executed].sort()).toEqual([...bigIds.slice(0, 50), ...small].sort());
    expect(r.not_crossed).toEqual([]);
  });

  it('el grande con el lock tomado → skipped_users una vez, errors vacío y las 20 de los demás ejecutadas', async () => {
    const small = await smallUsers(20);
    const a = await apiClient();
    let r: Awaited<ReturnType<typeof executeLimits>>;
    try {
      await a.query('BEGIN');
      await a.query(userLock, [big]);
      r = await executeLimits({ max: 500, perUser: 50 });
    } finally { await a.end(); }
    expect(r).toMatchObject({ candidates: 70, errors: [], skipped_users: [String(big)], skipped_instruments: [], remaining: 0, after_id: null });
    expect([...r.executed].sort()).toEqual([...small].sort());
    expect(await filledCount(big)).toBe(50);   // solo las de la corrida anterior
  }, 30_000);
});

describe('instrumento que se queda sin cotización entre la selección y la ejecución', () => {
  it('100 NEW de un instrumento → skipped_instruments una vez, cero errores, todas siguen NEW', async () => {
    const gone = await instrument('EX9GONE', '100.00');
    const h = await holder(gone, 100, 'ex9-gone');
    const ids = await sellLimits(h, gone, 100, '90.00');
    const a = await apiClient();
    let r: Awaited<ReturnType<typeof executeLimits>>;
    try {
      await a.query('BEGIN');
      await a.query(userLock, [h]);
      let failed: unknown = null;
      // Cuando queda esperando el lock de este usuario, el executor ya eligió sus candidatas.
      const report = executeLimits({ max: 500, perUser: 100 }).catch((e) => { failed = e; throw e; });
      await waitingOnLock('query LIKE $1', 'SELECT app.execute_limit_outcome%', () => failed);
      await retire(gone);
      await a.query('COMMIT');
      r = await report;
    } finally { await a.end(); }
    expect(r).toMatchObject({ candidates: 100, errors: [], executed: [], skipped_users: [], skipped_instruments: [String(gone)], remaining: 0, after_id: null });
    expect([...(await statuses(ids)).values()]).toEqual(Array(100).fill('NEW'));
  });
});

describe('cursor', () => {
  it('4 candidatas con max 2: corrida 1 devuelve after_id, la 2 lo agota y la 3 empieza de cero con la que pasó a cruzar', async () => {
    const other = await instrument('EX9LATE', '100.00');
    const late = (await sellLimits(await holder(other, 1, 'ex9-late'), other, 1, '150.00'))[0];   // no cruza: 100 < 150
    const inst = await instrument('EX9CUR', '100.00');
    const ids: string[] = [];
    for (let k = 0; k < 4; k++) ids.push(...(await sellLimits(await holder(inst, 1, 'ex9-cur'), inst, 1, '90.00')));
    try {
      const r1 = await executeLimits({ max: 2 });
      expect(r1).toMatchObject({ candidates: 2, executed: ids.slice(0, 2), after_id: ids[1], remaining: 0, errors: [] });
      // Pasa a cruzar con un id menor que el cursor: espera a la vuelta siguiente (D-28).
      await admin.query('UPDATE app.marketdata SET close = 200, previousclose = 200 WHERE instrumentid = $1', [other]);
      const r2 = await executeLimits({ max: 2, afterId: r1.after_id! });
      expect(r2).toMatchObject({ candidates: 2, executed: ids.slice(2, 4), after_id: null, remaining: 0, errors: [] });
      const r3 = await executeLimits({ max: 2 });
      expect(r3).toMatchObject({ candidates: 1, executed: [late], after_id: null, remaining: 0, errors: [] });
    } finally { await retire(inst); await retire(other); }
  });
});

describe('presupuesto de tiempo', () => {
  it('max_ms 50 con 200 candidatas lentas → corte limpio entre sentencias, remaining > 0, ninguna abortada', async () => {
    const inst = await instrument('EX9SLOW', '100.00');
    const h = await holder(inst, 200, 'ex9-slow');
    const ids = await sellLimits(h, inst, 200, '90.00');
    await admin.query(`CREATE FUNCTION app.test_slow_fill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.02); RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER test_slow_fill BEFORE UPDATE ON app.orders
      FOR EACH ROW WHEN (NEW.userid = ${h}) EXECUTE FUNCTION app.test_slow_fill()`);
    try {
      const t0 = Date.now();
      const r = await executeLimits({ max: 500, perUser: 200, maxMs: 50 });
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(r).toMatchObject({ candidates: 200, errors: [], not_crossed: [], skipped_users: [], skipped_instruments: [] });
      expect(r.executed.length).toBeGreaterThan(0);
      expect(r.remaining).toBeGreaterThan(0);
      expect(r.executed.length + r.remaining).toBe(200);
      expect(r.executed).toEqual(ids.slice(0, r.executed.length));
      expect(r.after_id).toBe(r.executed[r.executed.length - 1]);
      // La sentencia en curso terminó: lo ejecutado está FILLED y nada más cambió.
      const st = await statuses(ids);
      expect(ids.filter((id) => st.get(id) === 'FILLED')).toEqual(r.executed);
      expect(ids.filter((id) => st.get(id) === 'NEW')).toHaveLength(r.remaining);
    } finally {
      await admin.query('DROP TRIGGER test_slow_fill ON app.orders; DROP FUNCTION app.test_slow_fill()');
      await retire(inst);
    }
  });
});

/** Demora la selección `ms` después de que Postgres responde (simula una selección más lenta que el presupuesto). */
function slowSelection(ms: number) {
  const original = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
  return vi.spyOn(pool, 'query').mockImplementation((async (...args: unknown[]) => {
    const r = await original(...args);
    if (String(args[0]).includes('app.limit_candidates')) await new Promise((ok) => setTimeout(ok, ms));
    return r;
  }) as never);
}

describe('presupuesto agotado durante la selección', () => {
  it('la selección tarda más que max_ms → ninguna ejecución, remaining = el lote, after_id reanudable (el mismo cursor, también "0") y la corrida siguiente las ejecuta', async () => {
    await drain();
    const inst = await instrument('EX9SEL', '100.00');
    try {
      const ids: string[] = [];
      for (let k = 0; k < 3; k++) ids.push(...(await sellLimits(await holder(inst, 1, 'ex9-sel'), inst, 1, '90.00')));
      let spy = slowSelection(30);
      let r: Awaited<ReturnType<typeof executeLimits>>;
      try { r = await executeLimits({ max: 500, maxMs: 10 }); } finally { spy.mockRestore(); }
      expect(r).toMatchObject({ candidates: 3, executed: [], not_crossed: [], errors: [], remaining: 3, after_id: '0' });
      expect([...(await statuses(ids)).values()]).toEqual(['NEW', 'NEW', 'NEW']);
      // Seguir el cursor que devolvió: las ejecuta y el lote se agota.
      expect(await executeLimits({ max: 500, afterId: r.after_id! })).toMatchObject({ executed: ids, remaining: 0, after_id: null });

      // Desde un cursor distinto de 0, el mismo caso devuelve ese cursor.
      const more = await sellLimits(await holder(inst, 1, 'ex9-sel'), inst, 1, '90.00');
      spy = slowSelection(30);
      let r2: Awaited<ReturnType<typeof executeLimits>>;
      try { r2 = await executeLimits({ max: 500, maxMs: 10, afterId: ids[2] }); } finally { spy.mockRestore(); }
      expect(r2).toMatchObject({ candidates: 1, executed: [], remaining: 1, after_id: ids[2] });
      expect((await executeLimits({ max: 500, afterId: r2.after_id! })).executed).toEqual(more);
    } finally { await retire(inst); }
  });
});

describe('dos corridas concurrentes sobre el mismo lote', () => {
  it('las dos seleccionan el mismo lote (barrera con el lock del primer usuario): cada orden queda una vez en executed y una vez en not_crossed', async () => {
    await drain();
    const inst = await instrument('EX9TWO', '100.00');
    const users: number[] = [];
    const ids: string[] = [];
    for (let k = 0; k < 20; k++) {
      users.push(await holder(inst, 1, 'ex9-two'));
      ids.push(...(await sellLimits(users[k], inst, 1, '90.00')));
    }
    const lock = await apiClient();
    let a: Awaited<ReturnType<typeof executeLimits>>;
    let b: Awaited<ReturnType<typeof executeLimits>>;
    try {
      await lock.query('BEGIN');
      await lock.query(userLock, [users[0]]);
      let failed: unknown = null;
      const runs = [executeLimits({ max: 500 }), executeLimits({ max: 500 })].map((p) => p.catch((e) => { failed = e; throw e; }));
      runs.forEach((p) => p.catch(() => undefined));
      // Las dos ya eligieron sus candidatas y esperan el lock de la primera orden.
      for (;;) {
        if (failed) throw failed;
        const w = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'SELECT app.execute_limit_outcome%' AND wait_event_type = 'Lock' AND wait_event = 'advisory'");
        if (w.rows[0].n === 2) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      await lock.query('COMMIT');
      [a, b] = await Promise.all(runs);
    } finally { await lock.end(); }
    for (const r of [a, b]) expect(r).toMatchObject({ candidates: 20, errors: [], cancelled: [], skipped_users: [], remaining: 0 });
    expect([...a.executed, ...b.executed].sort()).toEqual([...ids].sort());
    expect([...a.not_crossed, ...b.not_crossed].sort()).toEqual([...ids].sort());
    expect([...(await statuses(ids)).values()]).toEqual(Array(20).fill('FILLED'));
    await retire(inst);
  });
});

describe('POST /internal/execute-limits: parámetros', () => {
  let server: Server;
  let base: string;
  beforeAll(() => {
    server = createApp({ internalToken: 'test-token' }).listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });
  const post = async (query: string) => {
    const r = await fetch(`${base}/internal/execute-limits${query}`, { method: 'POST', headers: { 'X-Internal-Token': 'test-token' } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it('max, after_id, max_ms y per_user inválidos, repetidos o desconocidos → 400 con el motivo en español', async () => {
    const cases: [string, string][] = [
      ['?max=1.5', 'max: entero sin signo'], ['?max=abc', 'max: entero sin signo'], ['?max=', 'max: entero sin signo'],
      ['?max=5&max=6', 'max: un solo valor por parámetro'], ['?max=0', 'max: mínimo 1'], ['?max=10001', 'max: máximo 10000'],
      ['?after_id=-1', 'after_id: entero sin signo'], ['?after_id=1.0', 'after_id: entero sin signo'],
      ['?max_ms=0', 'max_ms: mínimo 1'], ['?max_ms=600001', 'max_ms: máximo 600000'], ['?max_ms=abc', 'max_ms: entero sin signo'],
      ['?per_user=0', 'per_user: mínimo 1'], ['?per_user=x', 'per_user: entero sin signo'],
      ['?otro=1', 'parámetro desconocido: otro'],
      // Después del corte de 1000 parámetros del parser de Express: igual se ven.
      ['?max=5' + '&'.repeat(1000) + '&max=6', 'max: un solo valor por parámetro'],
      ['?max=5' + '&'.repeat(1000) + '&otro=1', 'parámetro desconocido: otro'],
    ];
    for (const [q, message] of cases) {
      const r = await post(q);
      expect(r.status, q.slice(0, 40)).toBe(400);
      expect(r.body, q.slice(0, 40)).toEqual({ error: 'BAD_REQUEST', message });
    }
  });

  it('con candidatas, cada parámetro se aplica: max, after_id, per_user y max_ms', async () => {
    await drain();
    const inst = await instrument('EX9HTTP', '100.00');
    try {
      // Tres usuarios con una orden cada uno: max=2 y después el cursor.
      const ids: string[] = [];
      for (let k = 0; k < 3; k++) ids.push(...(await sellLimits(await holder(inst, 1, 'ex9-http'), inst, 1, '90.00')));
      expect((await post('?max=2')).body).toMatchObject({ candidates: 2, executed: ids.slice(0, 2), after_id: ids[1] });
      expect((await post(`?max=2&after_id=${ids[1]}`)).body).toMatchObject({ candidates: 1, executed: [ids[2]], after_id: null });

      // Un usuario con tres: per_user=1 toma una sola.
      const own = await sellLimits(await holder(inst, 3, 'ex9-http'), inst, 3, '90.00');
      expect((await post('?per_user=1')).body).toMatchObject({ candidates: 1, executed: [own[0]], after_id: null });
      await post('');   // las otras dos

      // max_ms: cada ejecución tarda 50 ms (trigger); con 1 ms de presupuesto, a lo sumo una.
      const h = await holder(inst, 3, 'ex9-http-slow');
      const slow = await sellLimits(h, inst, 3, '90.00');
      await admin.query(`CREATE FUNCTION app.test_slow_http() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER test_slow_http BEFORE UPDATE ON app.orders
        FOR EACH ROW WHEN (NEW.userid = ${h}) EXECUTE FUNCTION app.test_slow_http()`);
      try {
        const r4 = (await post('?max_ms=1')).body as { candidates: number; executed: string[]; remaining: number; after_id: string | null };
        expect(r4.candidates).toBe(3);
        expect(r4.executed.length).toBeLessThanOrEqual(1);
        expect(r4.remaining).toBe(3 - r4.executed.length);
        expect(r4.after_id).toBe(r4.executed.length ? slow[0] : '0');
      } finally {
        await admin.query('DROP TRIGGER test_slow_http ON app.orders; DROP FUNCTION app.test_slow_http()');
      }
    } finally { await retire(inst); }
  });

  it('válidos → 200 con el reporte completo', async () => {
    const r = await post('?max=1&after_id=0&max_ms=1000&per_user=1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ executed: [], not_crossed: [], cancelled: [], errors: [], skipped_users: [], skipped_instruments: [], remaining: 0 });
    expect(r.body.after_id).toBeNull();
    expect((await post('')).status).toBe(200);
  });
});
