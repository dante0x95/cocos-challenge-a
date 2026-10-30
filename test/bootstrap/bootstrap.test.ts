// El bootstrap sobre una base vacía, dos veces: la primera deja los números de aceptación del
// challenge; la segunda no cambia nada (idempotente). También: una migración ya aplicada que
// cambia de contenido aborta, y una base que ya tiene las tablas del challenge no se re-siembra.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { bootstrap } from '../../src/db/bootstrap.js';
import { recreateDatabase } from '../support/global-setup.js';
import { dbUrl, SERVER_URL } from '../support/urls.js';
import { requestHash } from '../../src/domain/orders.js';

const DB = 'cocos_bootstrap_test';
const url = dbUrl(DB);
const quiet = { log: () => undefined };

async function stateOf(u: string) {
  const db = new pg.Pool({ connectionString: u });
  try {
    const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
    return {
      migrations: await q('SELECT name, mode FROM public.schema_migrations ORDER BY name'),
      cash: (await q('SELECT qty::text, reserved::text, inconsistent FROM app.read_portfolio(1) WHERE kind = 0'))[0],
      positions: await q('SELECT instrumentid, qty::text, cost_total::text, inconsistent FROM app.read_portfolio(1) WHERE kind = 1 ORDER BY instrumentid'),
      seqs: await q("SELECT id, balance_seq::int FROM app.orders WHERE status = 'FILLED' ORDER BY id"),
      cashOrders: await q("SELECT id, size, price::text FROM app.orders WHERE side LIKE 'CASH%' ORDER BY id"),
      cancelled: await q("SELECT id, cancel_reason FROM app.orders WHERE status = 'CANCELLED' ORDER BY id"),
      settings: (await q('SELECT price_max_age_days, idempotency_ttl::text FROM app.settings'))[0],
      apiCanWrite: (await q("SELECT has_table_privilege('api', 'app.orders', 'INSERT') AS ins, has_table_privilege('api', 'app.orders', 'UPDATE') AS upd"))[0],
    };
  } finally {
    await db.end();
  }
}

afterAll(async () => {
  const c = new pg.Client({ connectionString: SERVER_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await c.end();
});

describe('bootstrap', () => {
  let first: Awaited<ReturnType<typeof stateOf>>;

  it('base vacía → seed + migraciones + funciones, con los números de aceptación', async () => {
    await recreateDatabase(DB);
    const r = await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
    expect(r.applied).toEqual(['000_seed.sql', '001_app_schema.sql', '002_audit.sql', '003_orders_ledger.sql', '005_cancel_reason.sql',
      '006_idempotency_ttl.sql']);
    expect(r.ledger).toEqual([{ userid: 1, problem: 'short', detail: expect.stringContaining('instrumento 31 en -10') }]);

    first = await stateOf(url);
    expect(first.cash).toEqual({ qty: '75300000', reserved: '12550000', inconsistent: true });   // 753.000 / 125.500
    expect(first.positions).toEqual([
      { instrumentid: 31, qty: '-10', cost_total: '0', inconsistent: true },
      { instrumentid: 47, qty: '40', cost_total: '37200000000', inconsistent: false },
      { instrumentid: 54, qty: '500', cost_total: '125000000000', inconsistent: false },
    ]);
    // Secuencias por (datetime, id) sobre las 7 FILLED; cash en centavos a 0.01.
    expect(first.seqs.map((s) => s.balance_seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(first.cashOrders.every((o) => o.price === '0.01')).toBe(true);
    expect(first.cashOrders.map((o) => o.size)).toEqual([100_000_000, 10_000_000]);
    // La única cancelada del challenge (orden 3, una LIMIT del instrumento 47) la canceló el usuario: el executor no existía.
    expect(first.cancelled).toEqual([{ id: 3, cancel_reason: 'USER' }]);
    expect(first.settings).toEqual({ price_max_age_days: null, idempotency_ttl: '24:00:00' });
    expect(first.apiCanWrite).toEqual({ ins: false, upd: false });
  }, 60_000);

  it('segunda corrida: no aplica nada y la base queda idéntica', async () => {
    const r = await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
    expect(r.applied).toEqual([]);
    expect(await stateOf(url)).toEqual(first);
  }, 60_000);

  it('una migración ya aplicada que cambió de contenido → aborta sin tocar nada', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-'));
    try {
      cpSync(resolve('db'), dir, { recursive: true });
      appendFileSync(join(dir, 'migrations', '003_orders_ledger.sql'), '\n-- editado\n');
      await expect(bootstrap({ adminUrl: url, dbDir: dir, ...quiet })).rejects.toThrow(/003_orders_ledger.sql.*cambió/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // D-29: la CLI es el release_command del deploy en Fly. Si el bootstrap falla tiene que salir
  // con 1, para que el deploy se corte y siga atendiendo la versión anterior.
  it('la CLI (release_command) sale con 0 si el bootstrap pasa y con 1 si falla, sin dejar nada aplicado', async () => {
    const cli = (dbDir: string) => spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/db/bootstrap.ts')], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_ADMIN_URL: url, API_DB_PASSWORD: 'api', DB_DIR: dbDir },
    });
    const ok = cli(resolve('db'));
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('bootstrap OK');

    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-cli-'));
    try {
      cpSync(resolve('db'), dir, { recursive: true });
      writeFileSync(join(dir, 'migrations', '999_cli_falla.sql'), "DO $$ BEGIN RAISE EXCEPTION 'migración de prueba'; END $$;");
      const bad = cli(dir);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('bootstrap FALLÓ: migración de prueba');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const after = await stateOf(url);
    expect(after).toEqual(first);
    expect(after.migrations.map((m) => m.name)).not.toContain('999_cli_falla.sql');
  }, 60_000);

  // D-24, D-29: la verificación de la historia corre después de migrar. Si rechaza el bootstrap,
  // la migración, sus efectos, las funciones nuevas y la contraseña nueva del rol api tampoco
  // quedan: un release rechazado no deja la base cambiada debajo de la versión anterior.
  it('un bootstrap que falla en la verificación posterior a migrar no deja nada aplicado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-verify-'));
    try {
      cpSync(resolve('db'), dir, { recursive: true });
      writeFileSync(join(dir, 'migrations', '999_verification.sql'),
        'CREATE TABLE app.test_verification (x int); UPDATE app.settings SET price_max_age_days = 7;');
      writeFileSync(join(dir, 'functions', '095_test_verification.sql'), `CREATE OR REPLACE FUNCTION app.verify_ledger()
        RETURNS TABLE (userid int, problem text, detail text) LANGUAGE sql AS $$ SELECT 1, 'cash', 'verificación de prueba' $$;`);
      await expect(bootstrap({ adminUrl: url, apiPassword: 'otra-clave', dbDir: dir, ...quiet }))
        .rejects.toThrow(/verificación de la historia falló/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const after = await stateOf(url);
    expect(after).toEqual(first);
    expect(after.migrations.map((m) => m.name)).not.toContain('999_verification.sql');
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      expect((await c.query("SELECT to_regclass('app.test_verification') AS t")).rows[0].t).toBeNull();
      expect((await c.query("SELECT pg_get_functiondef('app.verify_ledger()'::regprocedure) AS d")).rows[0].d)
        .not.toContain('verificación de prueba');
    } finally {
      await c.end();
    }
    // El rol api sigue con su contraseña anterior.
    const api = new pg.Client({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
    await api.connect();
    await api.end();
  }, 60_000);

  it('base que ya tiene las tablas del challenge: el seed se registra sin correr (baseline)', async () => {
    await recreateDatabase(DB);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { readFileSync } = await import('node:fs');
    await c.query(readFileSync(resolve('db/migrations/000_seed.sql'), 'utf8'));
    await c.end();
    const r = await bootstrap({ adminUrl: url, ...quiet });
    expect(r.baselined).toEqual(['000_seed.sql']);
    expect(r.applied).not.toContain('000_seed.sql');
    expect((await stateOf(url)).cash).toEqual(first.cash);
  }, 60_000);

  // Issue #4 (CR-8): el despliegue sobre una base con la firma anterior de place_order (9 argumentos).
  it('actualización desde la firma anterior de place_order: queda solo la nueva, api la llama con 9 y 10 argumentos y la clave vieja da replay', async () => {
    // La versión anterior de las funciones: las de esta rama sin el cambio del issue #4. Cada reemplazo
    // tiene que aplicar; si el archivo cambia de forma, la prueba lo dice en vez de pasar en falso.
    const revert = (s: string, from: string | RegExp, to: string) => {
      const out = s.replace(from, to);
      if (out === s) throw new Error(`no se pudo reconstruir la versión anterior: ${from}`);
      return out;
    };
    const { readFileSync, writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-old-'));
    try {
      cpSync(resolve('db'), dir, { recursive: true });
      let f030 = readFileSync(resolve('db/functions/030_orders.sql'), 'utf8');
      f030 = revert(f030, /--   p_legacy_hash:[^\n]*\n(--[^\n]*\n)*(DROP FUNCTION IF EXISTS app\.place_order\([^)]*\);\n)?/, '');
      f030 = revert(f030, ' p_limit numeric,\n  p_legacy_hash text DEFAULT NULL)', ' p_limit numeric)');
      f030 = revert(f030, ' AND prev.request_hash IS DISTINCT FROM p_legacy_hash THEN', ' THEN');
      writeFileSync(join(dir, 'functions', '030_orders.sql'), f030);
      const f090 = revert(readFileSync(resolve('db/functions/090_privileges.sql'), 'utf8'),
        'app.place_order(int, text, text, text, text, int, int, numeric, numeric, text)',
        'app.place_order(int, text, text, text, text, int, int, numeric, numeric)');
      writeFileSync(join(dir, 'functions', '090_privileges.sql'), f090);

      await recreateDatabase(DB);
      await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const adminDb = new pg.Pool({ connectionString: url });
    const api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
    try {
      const signatures = async () =>
        (await adminDb.query<{ sig: string }>("SELECT oid::regprocedure::text AS sig FROM pg_proc WHERE proname = 'place_order'")).rows.map((r) => r.sig);
      const old9 = 'app.place_order(integer,text,text,text,text,integer,integer,numeric,numeric)';
      const new10 = 'app.place_order(integer,text,text,text,text,integer,integer,numeric,numeric,text)';
      expect(await signatures()).toEqual([old9]);

      // Antes del despliegue, la versión anterior graba una clave con el hash de amount "100" sin canonizar.
      const ars = (await adminDb.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'ARS'")).rows[0].id;
      const legacyHash = requestHash({ userid: 1, side: 'CASH_IN', type: 'MARKET', amount: '100' });
      const canonicalHash = requestHash({ userid: 1, side: 'CASH_IN', type: 'MARKET', amount: '100.00' });
      const call9 = (k: string, hash: string) =>
        api.query<{ r: any }>("SELECT app.place_order(1, $1, $2, 'CASH_IN', 'MARKET', $3, NULL, 100, NULL) AS r", [k, hash, ars]);
      const original = (await call9('cr8-old', legacyHash)).rows[0].r;
      expect(original).toMatchObject({ status: 201, replay: false });

      // Despliegue de esta rama, dos veces (las funciones son repetibles).
      await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
      await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
      expect(await signatures()).toEqual([new10]);
      expect((await adminDb.query("SELECT has_function_privilege('api', $1::regprocedure, 'EXECUTE') AS ok", [new10])).rows[0].ok).toBe(true);

      // api la llama con 10 argumentos: la clave vieja da replay con el hash canonizado + el anterior.
      const replay = (await api.query<{ r: any }>(
        "SELECT app.place_order(1, 'cr8-old', $1, 'CASH_IN', 'MARKET', $2, NULL, 100.00, NULL, $3) AS r", [canonicalHash, ars, legacyHash])).rows[0].r;
      expect(replay).toEqual({ ...original, replay: true });
      // Y con 9 (un llamador viejo): la misma clave con su hash original sigue dando replay; una clave nueva crea la orden.
      expect((await call9('cr8-old', legacyHash)).rows[0].r).toEqual({ ...original, replay: true });
      expect((await call9('cr8-new', canonicalHash)).rows[0].r).toMatchObject({ status: 201, replay: false });
      expect((await adminDb.query("SELECT count(*)::int AS n FROM app.idempotency_keys WHERE userid = 1 AND key LIKE 'cr8-%'")).rows[0].n).toBe(2);
    } finally {
      await api.end();
      await adminDb.end();
    }
  }, 120_000);

  // Issue #18: el rol api ya no tiene SELECT sobre app.users. Una base desplegada antes lo tiene
  // (el GRANT de la versión anterior de 090_privileges.sql) y lo pierde al volver a desplegar.
  it('base con el SELECT anterior de api sobre app.users: después de dos bootstraps queda revocado y el portfolio sigue igual', async () => {
    await recreateDatabase(DB);
    await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });

    const adminDb = new pg.Pool({ connectionString: url });
    const api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
    const privileges = async () => (await adminDb.query(
      "SELECT has_table_privilege('api', 'app.users', 'SELECT') AS table_select, has_any_column_privilege('api', 'app.users', 'SELECT') AS column_select")).rows[0];
    try {
      // El estado que dejó la versión anterior: api lee app.users.
      await adminDb.query('GRANT SELECT ON app.users TO api');
      expect(await privileges()).toEqual({ table_select: true, column_select: true });
      expect((await api.query('SELECT 1 FROM app.users')).rowCount).toBeGreaterThan(0);

      // Despliegue de esta rama, dos veces (las funciones son repetibles).
      await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
      await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
      expect(await privileges()).toEqual({ table_select: false, column_select: false });
      await expect(api.query('SELECT 1 FROM app.users')).rejects.toMatchObject({ code: '42501' });

      // read_portfolio (SECURITY DEFINER) sigue resolviendo el usuario para el rol api.
      const cash = (await api.query('SELECT qty::text FROM app.read_portfolio(1) WHERE kind = 0')).rows[0];
      expect(cash).toEqual({ qty: '75300000' });   // 753.000
      await expect(api.query('SELECT * FROM app.read_portfolio($1)', [2_000_000_000]))
        .rejects.toMatchObject({ code: 'APP06', message: 'usuario 2000000000 inexistente' });
    } finally {
      await api.end();
      await adminDb.end();
    }
  }, 120_000);

  // Issue #21: el despliegue sobre una base sin cancel_reason, con órdenes ya canceladas y la
  // versión anterior de las funciones (cancel_order_outcome sin la columna en su RETURNS TABLE).
  describe('actualización a cancel_reason', () => {
    const revert = (s: string, from: string | RegExp, to: string) => {
      const out = s.replace(from, to);
      if (out === s) throw new Error(`no se pudo reconstruir la versión anterior: ${from}`);
      return out;
    };
    /** La versión anterior: sin la migración 005 y con 030_orders.sql sin cancel_reason. */
    const pre21 = (dir: string) => {
      rmSync(join(dir, 'migrations', '005_cancel_reason.sql'));
      let f030 = readFileSync(resolve('db/functions/030_orders.sql'), 'utf8');
      f030 = revert(f030, /,\n    'cancel_reason', NULL\);[^\n]*/, ');');
      f030 = revert(f030, ", cancel_reason = 'LIMIT'", '');
      f030 = revert(f030, ", cancel_reason = 'USER'", '');
      f030 = revert(f030, /DO \$\$\n[\s\S]*?END \$\$;\n(?=CREATE OR REPLACE FUNCTION app\.cancel_order_outcome)/, '');
      f030 = revert(f030, ',\n               cancel_reason text)', ')');
      f030 = revert(f030, '\n  cancel_reason := o.cancel_reason;', '');
      writeFileSync(join(dir, 'functions', '030_orders.sql'), f030);
    };
    /** Esta rama más un archivo de funciones que corre después de las migraciones y antes de 030. */
    const withExtraFunction = (name: string, sql: string) => (dir: string) => writeFileSync(join(dir, 'functions', name), sql);
    /** Bootstrap desde una copia de db/ modificada por `edit`. */
    const deployFrom = async (edit: (dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), 'cocos-db-21-'));
      try {
        cpSync(resolve('db'), dir, { recursive: true });
        edit(dir);
        return await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    let adminDb: pg.Pool;
    let api: pg.Pool;
    beforeEach(async () => {
      await recreateDatabase(DB);
      await deployFrom(pre21);
      adminDb = new pg.Pool({ connectionString: url });
      api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
    }, 60_000);
    afterEach(async () => {
      await api.end();
      await adminDb.end();
    });

    const hasColumn = async () => (await adminDb.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'orders' AND column_name = 'cancel_reason'")).rowCount;
    const migrations = async () =>
      (await adminDb.query<{ name: string }>('SELECT name FROM public.schema_migrations ORDER BY name')).rows.map((r) => r.name);
    const placeLimit = async (k: string) => (await api.query<{ r: any }>(
      "SELECT app.place_order(1, $1, 'h', 'BUY', 'LIMIT', 47, 1, NULL, 1.00, NULL) AS r", [k])).rows[0].r;
    const orderState = async (id: string) =>
      (await adminDb.query('SELECT status, cancel_reason FROM app.orders WHERE id = $1', [id])).rows[0];
    /** Espera hasta que alguna sesión que cumpla `where` esté bloqueada esperando un lock; devuelve cuál. */
    const waitingOnLock = async (where: string, arg: unknown): Promise<string> => {
      for (;;) {
        const w = await adminDb.query<{ e: string }>(
          `SELECT wait_event AS e FROM pg_stat_activity WHERE ${where} AND wait_event_type = 'Lock'`, [arg]);
        if (w.rowCount) return w.rows[0].e;
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    it('las ya canceladas quedan USER, cancel_order_outcome se reemplaza una sola vez, api la sigue llamando y el replay de una clave anterior es idéntico', async () => {
      expect(await hasColumn()).toBe(0);
      // Antes del despliegue: una LIMIT del usuario 1 cancelada con la versión anterior, y su respuesta completa.
      const original = await placeLimit('pre21');
      expect(original.body).not.toHaveProperty('cancel_reason');
      const before = original.order_id as string;
      expect((await api.query('SELECT outcome, status FROM app.cancel_order_outcome(1, $1)', [before])).rows[0])
        .toEqual({ outcome: 'ok', status: 'CANCELLED' });

      // Despliegue de esta rama, dos veces: la migración corre una vez y la función se reemplaza en el lugar.
      const sig = 'app.cancel_order_outcome(integer,bigint)';
      const oid = async () => (await adminDb.query<{ oid: number }>('SELECT $1::regprocedure::oid AS oid', [sig])).rows[0].oid;
      const oldOid = await oid();
      expect((await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet })).applied).toEqual(['005_cancel_reason.sql']);
      const newOid = await oid();
      expect(newOid).not.toBe(oldOid);
      expect((await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet })).applied).toEqual([]);
      expect(await oid()).toBe(newOid);
      expect((await adminDb.query("SELECT has_function_privilege('api', $1::regprocedure, 'EXECUTE') AS ok", [sig])).rows[0].ok).toBe(true);

      // Las ya canceladas (la del challenge y la de antes del despliegue) quedan USER; ninguna otra tiene motivo.
      expect((await adminDb.query("SELECT id::text, cancel_reason FROM app.orders WHERE status = 'CANCELLED' ORDER BY orders.id")).rows)
        .toEqual([{ id: '3', cancel_reason: 'USER' }, { id: before, cancel_reason: 'USER' }]);
      expect((await adminDb.query("SELECT count(*)::int AS n FROM app.orders WHERE status <> 'CANCELLED' AND cancel_reason IS NOT NULL")).rows[0].n).toBe(0);

      // R-3: la clave grabada antes devuelve exactamente su respuesta original (sin cancel_reason), sin otra orden.
      const orders = async () => (await adminDb.query<{ n: number }>('SELECT count(*)::int AS n FROM app.orders')).rows[0].n;
      const count = await orders();
      expect(await placeLimit('pre21')).toEqual({ ...original, replay: true });
      expect(await orders()).toBe(count);

      // api llama la versión nueva y recibe el motivo.
      const after = (await placeLimit('post21')).order_id;
      expect((await api.query('SELECT outcome, status, cancel_reason FROM app.cancel_order_outcome(1, $1)', [after])).rows[0])
        .toEqual({ outcome: 'ok', status: 'CANCELLED', cancel_reason: 'USER' });
    }, 120_000);

    it('el pool del bootstrap no tiene plazo local: una función que tarda más que el PG_QUERY_TIMEOUT_MS por defecto (7 s) se aplica igual (issue #11)', async () => {
      // config se carga una sola vez al importar: acá vale el default. Una sentencia de 8 s lo
      // supera, así que heredar query_timeout de la API (o fijar cualquier plazo menor) falla.
      const r = await deployFrom(withExtraFunction('015_test_lento.sql', 'SELECT pg_sleep(8);'));
      expect(r.functions).toContain('015_test_lento.sql');
    }, 60_000);

    it('un bootstrap que falla después de la migración no deja nada aplicado: ni la columna ni las funciones nuevas, y las anteriores siguen cancelando', async () => {
      const lim = (await placeLimit('interrumpido')).order_id as string;
      await expect(deployFrom(withExtraFunction('015_test_interrupcion.sql',
        "DO $$ BEGIN RAISE EXCEPTION 'interrupción de prueba'; END $$;"))).rejects.toThrow(/interrupción de prueba/);
      expect(await hasColumn()).toBe(0);
      expect(await migrations()).not.toContain('005_cancel_reason.sql');
      // La función instalada es la anterior y cancela con el esquema anterior.
      const [row] = (await api.query('SELECT * FROM app.cancel_order_outcome(1, $1)', [lim])).rows;
      expect(row).toMatchObject({ outcome: 'ok', status: 'CANCELLED' });
      expect(row).not.toHaveProperty('cancel_reason');
    }, 120_000);

    it('con conexiones reales: a mitad del bootstrap nadie ve el esquema nuevo, y los escritores de la versión anterior que lo esperaban fallan con APP04 sin efectos', async () => {
      const limHot = (await placeLimit('en-vuelo-1')).order_id as string;
      const limCold = (await placeLimit('en-vuelo-2')).order_id as string;
      const apiClient = async () => {
        const c = new pg.Client({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
        await c.connect();
        const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return { c, pid };
      };
      // `hot` ya ejecutó la función anterior en su sesión (cuerpo compilado): espera en la barrera de
      // despliegue. `cold` la compila al llamarla: espera el lock de app.orders que tomó la migración.
      const hot = await apiClient();
      const cold = await apiClient();
      expect((await hot.c.query('SELECT outcome FROM app.cancel_order_outcome(1, 2000000000)')).rows[0].outcome).toBe('not_found');
      // Barrera: un archivo de funciones extra (después de 005, antes de 030) espera un lock que retiene la prueba.
      const pause = await adminDb.connect();
      try {
        await pause.query('BEGIN');
        await pause.query("SELECT pg_advisory_xact_lock(hashtext('test-pausa-bootstrap'))");
        const deploying = deployFrom(withExtraFunction('015_test_pausa.sql', "SELECT pg_advisory_xact_lock(hashtext('test-pausa-bootstrap'));"));
        deploying.catch(() => undefined);
        expect(await waitingOnLock("datname = $1 AND application_name = 'cocos-bootstrap'", DB)).toBe('advisory');

        // 005 ya corrió dentro de la transacción del bootstrap, pero no está confirmada: no se ve.
        expect(await hasColumn()).toBe(0);
        expect(await migrations()).not.toContain('005_cancel_reason.sql');

        // Los dos escritores llaman la función anterior y quedan esperando al bootstrap.
        const cancel = (w: { c: pg.Client }, id: string) => {
          const p = w.c.query('SELECT * FROM app.cancel_order_outcome(1, $1)', [id]);
          p.catch(() => undefined);
          return p;
        };
        const hotCancel = cancel(hot, limHot);
        expect(await waitingOnLock('pid = $1', hot.pid)).toBe('advisory');
        const coldCancel = cancel(cold, limCold);
        expect(await waitingOnLock('pid = $1', cold.pid)).toBe('relation');

        await pause.query('COMMIT');
        expect((await deploying).applied).toEqual(['005_cancel_reason.sql']);
        // Siguieron con el cuerpo anterior (cancelar sin motivo): APP04, reintentable (503).
        await expect(hotCancel).rejects.toMatchObject({ code: 'APP04' });
        await expect(coldCancel).rejects.toMatchObject({ code: 'APP04' });
      } finally {
        await pause.query('ROLLBACK').catch(() => undefined);
        pause.release();
        await hot.c.end();
        await cold.c.end();
      }
      for (const id of [limHot, limCold]) {
        expect(await orderState(id)).toEqual({ status: 'NEW', cancel_reason: null });
        // El reintento usa la función nueva.
        expect((await api.query('SELECT outcome, status, cancel_reason FROM app.cancel_order_outcome(1, $1)', [id])).rows[0])
          .toEqual({ outcome: 'ok', status: 'CANCELLED', cancel_reason: 'USER' });
      }
    }, 120_000);
  });
});

// Issue #3: cost_total pasa de bigint a numeric en c_state y read_portfolio.
describe('actualización a cost_total numeric', () => {
  const revert = (s: string, from: string, to: string) => {
    const out = s.split(from).join(to);
    if (out === s) throw new Error(`no se pudo reconstruir la versión anterior: ${from}`);
    return out;
  };
  /** Bootstrap desde una copia de db/ modificada por `edit`. */
  const deployFrom = async (edit: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-3-'));
    try {
      cpSync(resolve('db'), dir, { recursive: true });
      edit(dir);
      return await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const results = async (db: pg.Pool) => (await db.query<{ f: string; r: string }>(
    `SELECT p.proname AS f, pg_get_function_result(p.oid) AS r FROM pg_proc p
      WHERE p.pronamespace = 'app'::regnamespace AND p.proname IN ('c_state', 'read_portfolio') ORDER BY 1`)).rows;

  it('una base con las firmas anteriores (bigint): dos bootstraps las reemplazan, con los permisos de antes', async () => {
    // La versión anterior de 020_balance.sql: cost_total bigint y sin el borrado previo.
    await recreateDatabase(DB);
    await deployFrom((dir) => {
      let f020 = readFileSync(resolve('db/functions/020_balance.sql'), 'utf8');
      f020 = revert(f020, f020.slice(f020.indexOf('DO $$'), f020.indexOf('CREATE OR REPLACE FUNCTION app.c_state')), '');
      f020 = revert(f020, 'cost_total numeric', 'cost_total bigint');
      f020 = revert(f020, 'cost_total := c::numeric(24,0)', 'cost_total := c');
      f020 = revert(f020, 'f.cash_cents, 0::numeric, f.inconsistent', 'f.cash_cents, 0::bigint, f.inconsistent');
      writeFileSync(join(dir, 'functions', '020_balance.sql'), f020);
    });
    const adminDb = new pg.Pool({ connectionString: url });
    const api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
    try {
      expect((await results(adminDb)).map((x) => x.r.includes('cost_total bigint'))).toEqual([true, true]);

      await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
      await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
      expect((await results(adminDb)).map((x) => x.r.includes('cost_total numeric'))).toEqual([true, true]);
      const can = async (sig: string) =>
        (await adminDb.query<{ ok: boolean }>("SELECT has_function_privilege('api', $1::regprocedure, 'EXECUTE') AS ok", [sig])).rows[0].ok;
      expect(await can('app.read_portfolio(int)')).toBe(true);
      expect(await can('app.c_state(int)')).toBe(false);
      // api lee el portfolio del challenge con el costo como numeric entero.
      expect((await api.query('SELECT instrumentid, cost_total::text FROM app.read_portfolio(1) WHERE kind = 1 ORDER BY instrumentid')).rows)
        .toEqual([
          { instrumentid: 31, cost_total: '0' },
          { instrumentid: 47, cost_total: '37200000000' },
          { instrumentid: 54, cost_total: '125000000000' },
        ]);
    } finally {
      await api.end();
      await adminDb.end();
    }
  }, 120_000);

  it('historia con un costo de 10¹³ y otra fuera de numeric(20,0): el bootstrap termina, informa solo el overflow y los demás operan', async () => {
    await recreateDatabase(DB);
    // Una migración más con la historia heredada: así el bootstrap la verifica, como al desplegar sobre datos reales.
    const r = await deployFrom((dir) => writeFileSync(join(dir, 'migrations', '999_test_historia.sql'), `
      DO $$
      DECLARE ars int; inst int; u int; i int := 0;
      BEGIN
        SELECT id INTO ars FROM app.instruments WHERE ticker = 'ARS';
        SELECT id INTO inst FROM app.instruments WHERE type = 'ACCIONES' ORDER BY id LIMIT 1;
        FOREACH u IN ARRAY ARRAY[0, 1, 2, 3] LOOP
          INSERT INTO app.users (email, accountnumber) VALUES (format('historia-%s@test.local', u), format('99000000%s', u));
        END LOOP;
        FOR u IN SELECT id FROM app.users WHERE email LIKE 'historia-%' ORDER BY id LOOP
          INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
          VALUES (ars, u, 100000, 0.01, 'MARKET', 'CASH_IN', 'FILLED', timezone('UTC', now()), 1);
          -- historia-0: 10⁷ acciones a 10⁶ → costo 10¹³ ARS (10¹⁹ micro, fuera de bigint).
          -- historia-1: importe (2³¹ − 1) × (10¹⁶ − 0,01), fuera de numeric(20,0).
          IF i < 2 THEN
            INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
            VALUES (inst, u, CASE i WHEN 0 THEN 10000000 ELSE 2147483647 END,
                    CASE i WHEN 0 THEN 1000000.00 ELSE 9999999999999999.99 END, 'MARKET', 'BUY', 'FILLED', timezone('UTC', now()), 2);
          END IF;
          i := i + 1;
        END LOOP;
      END $$;`));
    const adminDb = new pg.Pool({ connectionString: url });
    const api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
    try {
      const ids = (await adminDb.query<{ id: number }>("SELECT id FROM app.users WHERE email LIKE 'historia-%' ORDER BY id")).rows.map((x) => x.id);
      expect(r.applied).toContain('999_test_historia.sql');
      expect(r.ledger.filter((p) => ids.includes(p.userid)).map((p) => ({ userid: p.userid, problem: p.problem })))
        .toEqual([{ userid: ids[1], problem: 'overflow' }]);
      // El de costo 10¹³ se lee y opera; los normales también.
      expect((await api.query('SELECT cost_total::text AS c FROM app.read_portfolio($1) WHERE kind = 1', [ids[0]])).rows)
        .toEqual([{ c: '10000000000000000000' }]);
      const ars = (await adminDb.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'ARS'")).rows[0].id;
      for (const u of [ids[0], ids[2], ids[3]]) {
        const res = (await api.query<{ r: { status: number } }>(
          "SELECT app.place_order($1, 'dep', 'h', 'CASH_IN', 'MARKET', $2, NULL, 1.00, NULL, NULL) AS r", [u, ars])).rows[0].r;
        expect(res.status, `usuario ${u}`).toBe(201);
      }
    } finally {
      await api.end();
      await adminDb.end();
    }
  }, 120_000);
});

// Issue #13, plan de pruebas 2: un deploy con una migración nueva no deja requests en 500. La
// API real (src/server.ts) atiende sobre la base mientras el bootstrap migra: una migración que
// toma app.orders en modo exclusivo y un archivo de funciones que espera un lock que retiene la
// prueba. Las requests que llegan en ese momento esperan la barrera de despliegue o el lock de
// la tabla. Si el bootstrap termina pronto, todas terminan bien; si tarda más que el lock_timeout
// de las funciones (2 s), las escrituras responden 503 LOCK_TIMEOUT con Retry-After, ninguna
// 500, y el reintento con la misma clave deja una sola orden por clave. Una lectura en curso
// tampoco choca con el bootstrap: antes, 090_privileges.sql tomaba AccessExclusiveLock sobre
// todas las tablas (ALTER OWNER sin cambios) y la lectura terminaba en deadlock (503 DEADLOCK) o
// el bootstrap, víctima del deadlock, fallaba.
describe('deploy con la API atendiendo (issue #13)', () => {
  let adminDb: pg.Pool;
  let proc: ReturnType<typeof spawn> | undefined;
  let base: string;

  beforeEach(async () => {
    await recreateDatabase(DB);
    await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
    adminDb = new pg.Pool({ connectionString: url });
    const free = createServer().listen(0);
    await once(free, 'listening');
    const port = (free.address() as { port: number }).port;
    await new Promise((r) => free.close(r));
    proc = spawn(resolve('node_modules/.bin/tsx'), [resolve('src/server.ts')], {
      env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl(DB, { name: 'api', password: 'api' }),
        JOBS_ENABLED: 'false', LOG_REQUESTS: 'false' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    await new Promise<void>((ok, fail) => {
      proc!.stdout!.on('data', (d: Buffer) => { out += d; if (out.includes('escuchando')) ok(); });
      proc!.on('exit', (code) => fail(new Error(`src/server.ts salió con ${code}: ${out}`)));
    });
    base = `http://127.0.0.1:${port}`;
  }, 60_000);
  afterEach(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await once(proc, 'exit');
    }
    await adminDb.end();
  });

  const cashIn = async (key: string) => {
    const r = await fetch(`${base}/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ userid: 1, side: 'CASH_IN', amount: '1' }),
    });
    return { status: r.status, retryAfter: r.headers.get('retry-after'), replay: r.headers.get('idempotent-replay'),
      body: (await r.json()) as Record<string, unknown> };
  };
  const portfolio = async () => {
    const r = await fetch(`${base}/portfolio/1`);
    return { status: r.status, retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, unknown> };
  };
  const cashInOrders = async () => (await adminDb.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app.orders WHERE userid = 1 AND side = 'CASH_IN'")).rows[0].n;
  /** Espera a que n conexiones de la API estén esperando un lock en esta base. */
  const apiWaiting = async (n: number) => {
    for (let i = 0; i < 200; i++) {
      const { w } = (await adminDb.query<{ w: number }>(
        "SELECT count(*)::int AS w FROM pg_stat_activity WHERE datname = $1 AND application_name = 'cocos-api' AND wait_event_type = 'Lock'",
        [DB])).rows[0];
      if (w >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no hay ${n} conexiones de la API esperando un lock`);
  };

  /** Bootstrap con una migración nueva, pausado después de migrar hasta que `release` vuelve. */
  async function deployDuring(release: (inFlight: Promise<unknown>[]) => Promise<unknown>, requests: () => Promise<unknown>[]) {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-live-'));
    cpSync(resolve('db'), dir, { recursive: true });
    writeFileSync(join(dir, 'migrations', '999_test_live.sql'), 'ALTER TABLE app.orders ADD COLUMN test_live int; CREATE TABLE app.test_live_new (x int);');
    writeFileSync(join(dir, 'functions', '015_test_pause.sql'), "SELECT pg_advisory_xact_lock(hashtext('test-live-deploy'));");
    const pause = await adminDb.connect();
    try {
      await pause.query('BEGIN');
      await pause.query("SELECT pg_advisory_xact_lock(hashtext('test-live-deploy'))");
      const deploying = bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet });
      deploying.catch(() => undefined);
      // El bootstrap ya migró (tiene app.orders y la barrera) y espera en el archivo de funciones.
      for (let i = 0; ; i++) {
        const { n } = (await adminDb.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'cocos-bootstrap' AND wait_event = 'advisory'",
          [DB])).rows[0];
        if (n > 0) break;
        if (i > 200) throw new Error('el bootstrap no llegó a la pausa');
        await new Promise((r) => setTimeout(r, 25));
      }
      const inFlight = requests();
      await apiWaiting(inFlight.length);
      await release(inFlight);
      await pause.query('COMMIT');
      expect((await deploying).applied).toEqual(['999_test_live.sql']);
      return await Promise.all(inFlight);
    } finally {
      await pause.query('ROLLBACK').catch(() => undefined);
      pause.release();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('las requests que llegan durante la migración esperan y terminan bien si el bootstrap termina pronto', async () => {
    const before = await cashInOrders();
    const keys = ['vivo-1', 'vivo-2', 'vivo-3'];
    const results = await deployDuring(async () => undefined, () => [...keys.map(cashIn), portfolio()]) as Awaited<ReturnType<typeof cashIn>>[];
    expect(results.map((r) => [r.status, r.body.error ?? null])).toEqual([[201, null], [201, null], [201, null], [200, null]]);
    expect(await cashInOrders()).toBe(before + keys.length);
    // 090 sigue pasando a app_owner lo que crea una migración, y api no puede escribirlo.
    expect((await adminDb.query("SELECT tableowner FROM pg_tables WHERE schemaname = 'app' AND tablename = 'test_live_new'")).rows)
      .toEqual([{ tableowner: 'app_owner' }]);
    expect((await adminDb.query("SELECT has_table_privilege('api', 'app.test_live_new', 'INSERT') AS ins")).rows[0].ins).toBe(false);
  }, 60_000);

  it('si el bootstrap tarda más que el lock_timeout: 503 reintentables y nunca 500, y el reintento deja una orden por clave', async () => {
    const before = await cashInOrders();
    const keys = ['lento-1', 'lento-2', 'lento-3'];
    // La barrera sigue tomada hasta que las tres escrituras respondieron: su lock_timeout (2 s)
    // vence con el bootstrap todavía en curso. Recién entonces termina el bootstrap y responde la
    // lectura, que esperaba app.orders.
    const results = await deployDuring((inFlight) => Promise.all(inFlight.slice(0, keys.length)),
      () => [...keys.map(cashIn), portfolio()]) as Awaited<ReturnType<typeof cashIn>>[];
    for (const r of results) {
      expect(r.status, JSON.stringify(r.body)).not.toBe(500);
      expect([200, 201, 503]).toContain(r.status);
      if (r.status === 503) expect(r.retryAfter).toBe('1');
    }
    const writes = results.slice(0, keys.length);
    expect(writes.map((r) => r.body.error)).toEqual(['LOCK_TIMEOUT', 'LOCK_TIMEOUT', 'LOCK_TIMEOUT']);
    // Ninguna escritura que respondió 503 dejó una orden; el reintento con la misma clave, sí, una.
    expect(await cashInOrders()).toBe(before);
    for (const key of keys) expect(await cashIn(key)).toMatchObject({ status: 201, replay: 'false' });
    for (const key of keys) expect(await cashIn(key)).toMatchObject({ status: 201, replay: 'true' });
    expect(await cashInOrders()).toBe(before + keys.length);
  }, 60_000);
});
