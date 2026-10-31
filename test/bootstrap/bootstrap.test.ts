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
import { API_CONTRACT } from '../../src/db/contract.js';
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
      // Búsqueda (issue #14, migración 009): extensiones, wrapper IMMUTABLE, índices GIN, EXECUTE y umbral del rol api.
      search: (await q(`SELECT
          (SELECT array_agg(extname::text ORDER BY extname) FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent')) AS extensions,
          (SELECT provolatile FROM pg_proc WHERE oid = 'app.unaccent_immutable(text)'::regprocedure) AS wrapper,
          (SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes
            WHERE schemaname = 'app' AND tablename = 'instruments' AND indexdef LIKE '%gin_trgm_ops%') AS gin,
          has_function_privilege('api', 'app.unaccent_immutable(text)', 'EXECUTE') AS api_exec,
          EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setrole = 'api'::regrole
                     AND setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
                     AND 'pg_trgm.strict_word_similarity_threshold=0.45' = ANY (setconfig)) AS threshold`))[0],
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
      '006_idempotency_ttl.sql', '007_cancel_reason_unbacked.sql', '008_limit_candidates_index.sql', '009_instruments_trgm.sql',
      '010_order_cap_verify.sql']);
    expect(r.ledger).toEqual([{ userid: 1, problem: 'short', detail: expect.stringContaining('instrumento 31 en -10') }]);
    expect(r.unbacked).toEqual([]);   // la LIMIT NEW del challenge (orden 2) tiene respaldo

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
    expect(first.search).toEqual({
      extensions: ['pg_trgm', 'unaccent'], wrapper: 'i', gin: ['instruments_name_trgm', 'instruments_ticker_trgm'], api_exec: true, threshold: true,
    });
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

  // D-29: la CLI es el bootstrap de cada deploy, antes de cambiar de versión. Si falla tiene que salir
  // con 1, para que el deploy se corte y siga atendiendo la versión anterior.
  it('la CLI (el bootstrap del deploy) sale con 0 si el bootstrap pasa y con 1 si falla, sin dejar nada aplicado', async () => {
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

  // D-29, issue #36: en el servidor, el contenedor migrate recibe los dos secretos como archivos
  // (/run/secrets) y la CLI lee DATABASE_ADMIN_URL_FILE y API_DB_PASSWORD_FILE, sin el salto final.
  // Con la variable y su _FILE juntas, o un archivo que no se lee, falla antes de conectarse.
  it('la CLI lee DATABASE_ADMIN_URL_FILE y API_DB_PASSWORD_FILE; con la variable y su _FILE juntas, o sin el archivo, no toca la base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-secrets-'));
    const admin = join(dir, 'database_admin_url');
    const apiPassword = join(dir, 'api_db_password');
    writeFileSync(admin, `${url}\n`, { mode: 0o600 });
    writeFileSync(apiPassword, 'clave-del-archivo\n', { mode: 0o600 });
    const { DATABASE_ADMIN_URL: _a, API_DB_PASSWORD: _p, ...base } = process.env;
    const cli = (env: Record<string, string>) => spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/db/bootstrap.ts')], {
      encoding: 'utf8', env: { ...base, ...env },
    });
    const canConnect = async (password: string) => {
      const c = new pg.Client({ connectionString: dbUrl(DB, { name: 'api', password }) });
      try { await c.connect(); return true; } catch { return false; } finally { await c.end().catch(() => undefined); }
    };
    try {
      const ok = cli({ DATABASE_ADMIN_URL_FILE: admin, API_DB_PASSWORD_FILE: apiPassword });
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('bootstrap OK');
      // La contraseña del rol api es la del archivo, sin el salto de línea.
      expect(await canConnect('clave-del-archivo')).toBe(true);
      expect(await canConnect('clave-del-archivo\n')).toBe(false);
      expect(await stateOf(url)).toEqual(first);

      for (const [env, message] of [
        [{ DATABASE_ADMIN_URL: url, DATABASE_ADMIN_URL_FILE: admin, API_DB_PASSWORD_FILE: apiPassword }, 'DATABASE_ADMIN_URL y DATABASE_ADMIN_URL_FILE están las dos'],
        [{ DATABASE_ADMIN_URL_FILE: admin, API_DB_PASSWORD: 'otra', API_DB_PASSWORD_FILE: apiPassword }, 'API_DB_PASSWORD y API_DB_PASSWORD_FILE están las dos'],
        [{ DATABASE_ADMIN_URL_FILE: join(dir, 'no-existe'), API_DB_PASSWORD_FILE: apiPassword }, `DATABASE_ADMIN_URL_FILE: no se pudo leer '${join(dir, 'no-existe')}' (ENOENT)`],
        [{ DATABASE_ADMIN_URL_FILE: admin, API_DB_PASSWORD_FILE: join(dir, 'no-existe') }, `API_DB_PASSWORD_FILE: no se pudo leer '${join(dir, 'no-existe')}' (ENOENT)`],
      ] as [Record<string, string>, string][]) {
        const bad = cli(env);
        expect(bad.status, message).toBe(2);
        expect(bad.stderr).toContain(`bootstrap FALLÓ: ${message}`);
        expect(bad.stdout).toBe('');
        // No llegó a conectarse: la contraseña sigue siendo la del archivo.
        expect(await canConnect('clave-del-archivo')).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // El rol api es del servidor, no de esta base: vuelve a la contraseña que usan las demás pruebas.
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query("ALTER ROLE api WITH PASSWORD 'api'");
      await c.end();
    }
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

      // Su contrato (issue #39): la API anterior llamaba place_order con 9 argumentos.
      const contract9 = API_CONTRACT.map((s) => s.replace('numeric,numeric,text)', 'numeric,numeric)'));
      await recreateDatabase(DB);
      await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, contract: contract9, ...quiet });
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
    /** La versión anterior: sin las migraciones 005 y 007 y con 030_orders.sql sin cancel_reason. */
    const pre21 = (dir: string) => {
      rmSync(join(dir, 'migrations', '005_cancel_reason.sql'));
      rmSync(join(dir, 'migrations', '007_cancel_reason_unbacked.sql'));
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
      expect((await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet })).applied).toEqual(['005_cancel_reason.sql', '007_cancel_reason_unbacked.sql']);
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
        expect((await deploying).applied).toEqual(['005_cancel_reason.sql', '007_cancel_reason_unbacked.sql']);
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

  // Issue #6: el despliegue sobre una base sin la migración 007 y con LIMIT NEW heredadas sin respaldo
  // (insertadas directo en orders). La migración 007 admite el motivo UNBACKED; la verificación
  // las señala con 'reserva' y las cancela bajo el lock, en vez de abortar.
  describe('actualización a UNBACKED', () => {
    /** Bootstrap desde una copia de db/ sin la migración 007. */
    const deployWithout007 = async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cocos-db-7-'));
      try {
        cpSync(resolve('db'), dir, { recursive: true });
        rmSync(join(dir, 'migrations', '007_cancel_reason_unbacked.sql'));
        return await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('las NEW sin respaldo quedan CANCELLED con UNBACKED, se informan en el log y en el resultado, las que lo tienen siguen NEW y el executor no las ve', async () => {
      await recreateDatabase(DB);
      await deployWithout007();
      const adminDb = new pg.Pool({ connectionString: url });
      const api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
      try {
        // Antes de 007 el CHECK no admite el motivo: lo que hoy haría el bootstrap no es posible.
        await expect(adminDb.query(
          `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, cancel_reason)
           VALUES (47, 1, 1, 1.00, 'LIMIT', 'SELL', 'CANCELLED', timezone('UTC', now()), 'UNBACKED')`))
          .rejects.toMatchObject({ code: '23514', constraint: 'orders_cancel_reason_valid' });
        // Historia heredada del usuario 1 (40 acciones del 47, 753.000 de cash con 125.500 reservados por las LIMIT 5 y 7):
        // una SELL de 100 del 47, una BUY sobre ARS y, de control, una SELL de 10 del 47 con respaldo.
        const insert = async (side: string, instrumentid: number, size: number, price: string) => (await adminDb.query<{ id: string }>(
          `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
           VALUES ($1, 1, $2, $3, 'LIMIT', $4, 'NEW', timezone('UTC', now())) RETURNING id::text`, [instrumentid, size, price, side])).rows[0].id;
        const sell = await insert('SELL', 47, 100, '900.00');
        const ok = await insert('SELL', 47, 10, '900.00');
        const ars = await insert('BUY', 66, 1, '10.00');

        const log: string[] = [];
        const r = await bootstrap({ adminUrl: url, apiPassword: 'api', log: (m) => log.push(m) });
        expect(r.applied).toEqual(['007_cancel_reason_unbacked.sql']);
        expect(r.ledger).toEqual([
          { userid: 1, problem: 'short', detail: expect.stringContaining('instrumento 31 en -10') },
          { userid: 1, problem: 'reserva', detail: 'instrumento 47: 110 acciones reservadas > tenencia 40: venta LIMIT pendiente sin respaldo' },
          { userid: 1, problem: 'reserva', detail: `orden ${ars} pendiente sobre la moneda ARS: BUY/SELL no aplica sobre una moneda` },
        ]);
        expect(r.unbacked).toEqual([sell, ars]);   // en orden de id
        expect(log).toContain(`  historia: usuario 1 — orden ${sell} cancelada: LIMIT pendiente sin respaldo (cancel_reason UNBACKED)`);
        expect(log).toContain(`  historia: usuario 1 — orden ${ars} cancelada: LIMIT pendiente sin respaldo (cancel_reason UNBACKED)`);

        const state = async (id: string) => (await adminDb.query('SELECT status, cancel_reason FROM app.orders WHERE id = $1', [id])).rows[0];
        expect(await state(sell)).toEqual({ status: 'CANCELLED', cancel_reason: 'UNBACKED' });
        expect(await state(ars)).toEqual({ status: 'CANCELLED', cancel_reason: 'UNBACKED' });
        expect(await state(ok)).toEqual({ status: 'NEW', cancel_reason: null });
        expect(await state('5')).toEqual({ status: 'NEW', cancel_reason: null });
        expect(await state('7')).toEqual({ status: 'NEW', cancel_reason: null });
        expect((await adminDb.query("SELECT order_id::text FROM app.limit_candidates(1000)")).rows.map((x) => x.order_id)).not.toContain(sell);
        // api la ve con su motivo y no la puede cancelar de nuevo.
        expect((await api.query('SELECT outcome, status, cancel_reason FROM app.cancel_order_outcome(1, $1)', [sell])).rows[0])
          .toEqual({ outcome: 'not_new', status: 'CANCELLED', cancel_reason: 'UNBACKED' });
        // El executor ejecuta la que tiene respaldo (el close del 47 es 925,85 ≥ 900).
        expect((await api.query<{ r: string }>('SELECT app.execute_limit_outcome($1) AS r', [ok])).rows[0].r).toBe('FILLED');

        // Segunda corrida: nada que aplicar, nada que verificar, la base queda igual.
        const again = await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
        expect(again).toMatchObject({ applied: [], ledger: [], unbacked: [] });
        expect(await state(sell)).toEqual({ status: 'CANCELLED', cancel_reason: 'UNBACKED' });
      } finally {
        await api.end();
        await adminDb.end();
      }
    }, 120_000);

    // D-24: la verificación va en la transacción del bootstrap. Si algo falla después de cancelar
    // una NEW, la cancelación se revierte con todo lo demás.
    it('un bootstrap que falla después de cancelar una NEW sin respaldo no deja nada: la orden vuelve a NEW y 007 no queda aplicada', async () => {
      await recreateDatabase(DB);
      await deployWithout007();
      const adminDb = new pg.Pool({ connectionString: url });
      try {
        const insert = async (userid: number, size: number) => (await adminDb.query<{ id: string }>(
          `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
           VALUES (47, $1, $2, 900.00, 'LIMIT', 'SELL', 'NEW', timezone('UTC', now())) RETURNING id::text`, [userid, size])).rows[0].id;
        const other = (await adminDb.query<{ id: number }>(
          "INSERT INTO app.users (email, accountnumber) VALUES ('unbacked-2@test.local', '9900000002') RETURNING id")).rows[0].id;
        const first = await insert(1, 100);       // usuario 1: 40 acciones del 47
        const second = await insert(other, 10);   // el otro: ninguna
        // Un archivo de funciones extra (después de 040) hace fallar la cancelación del segundo
        // usuario: la del primero ya ocurrió dentro de la transacción.
        const dir = mkdtempSync(join(tmpdir(), 'cocos-db-7-'));
        try {
          cpSync(resolve('db'), dir, { recursive: true });
          writeFileSync(join(dir, 'functions', '095_test_fail.sql'), `
            CREATE FUNCTION app.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'falla de prueba después de cancelar'; END $$;
            CREATE TRIGGER test_fail BEFORE UPDATE ON app.orders FOR EACH ROW
              WHEN (NEW.cancel_reason = 'UNBACKED' AND NEW.userid = ${other}) EXECUTE FUNCTION app.test_fail();`);
          const log: string[] = [];
          await expect(bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, log: (m) => log.push(m) }))
            .rejects.toThrow(/falla de prueba después de cancelar/);
          // La del primer usuario se canceló antes del fallo.
          expect(log).toContain(`  historia: usuario 1 — orden ${first} cancelada: LIMIT pendiente sin respaldo (cancel_reason UNBACKED)`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        const state = async (id: string) => (await adminDb.query('SELECT status, cancel_reason FROM app.orders WHERE id = $1', [id])).rows[0];
        expect(await state(first)).toEqual({ status: 'NEW', cancel_reason: null });
        expect(await state(second)).toEqual({ status: 'NEW', cancel_reason: null });
        expect((await adminDb.query<{ name: string }>('SELECT name FROM public.schema_migrations ORDER BY name')).rows.map((r) => r.name))
          .not.toContain('007_cancel_reason_unbacked.sql');
        expect((await adminDb.query("SELECT 1 FROM pg_trigger WHERE tgname = 'test_fail'")).rowCount).toBe(0);
        // Sin 007, el CHECK sigue sin admitir el motivo.
        await expect(adminDb.query("UPDATE app.orders SET status = 'CANCELLED', cancel_reason = 'UNBACKED' WHERE id = $1", [first]))
          .rejects.toMatchObject({ code: '23514', constraint: 'orders_cancel_reason_valid' });
      } finally {
        await adminDb.end();
      }
    }, 120_000);
  });

  // Issue #41: una base heredada con una NEW por encima del tope de D-14 (place_order no la graba).
  // La verificación la señala con 'tope' y el bootstrap la cancela con LIMIT, sin abortar. La
  // base anterior es la de main antes de este cambio: todas las migraciones menos la 010. El
  // despliegue de esta rama, con los archivos reales, aplica la 010 y por eso verifica la historia.
  describe('actualización a la verificación del tope por orden', () => {
    /** Bootstrap desde una copia de db/ sin la migración 010: la base desplegada antes del issue #41. */
    const deployWithout010 = async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cocos-db-41-'));
      try {
        cpSync(resolve('db'), dir, { recursive: true });
        rmSync(join(dir, 'migrations', '010_order_cap_verify.sql'));
        return await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('NEW heredada con importe por encima de 10¹⁵: verify_ledger informa tope, el bootstrap la cancela con LIMIT, la segunda corrida no hace nada y su clave sigue dando el 201 original', async () => {
      await recreateDatabase(DB);
      expect((await deployWithout010()).applied).not.toContain('010_order_cap_verify.sql');
      const adminDb = new pg.Pool({ connectionString: url });
      const api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
      try {
        // El caso del issue, como lo deja una base preexistente (admin): cash −0,03 y 2 acciones del 47,
        // una SELL LIMIT NEW de 2 a 500.000.000.000.000,01 (importe 10¹⁵ + 0,02) con su clave y su 201,
        // y una SELL LIMIT NEW de 2 a 900 dentro del tope, que tiene respaldo si no se cuenta la otra.
        const u = (await adminDb.query<{ id: number }>(
          "INSERT INTO app.users (email, accountnumber) VALUES ('tope-41@test.local', '9900000041') RETURNING id")).rows[0].id;
        const ars = (await adminDb.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'ARS'")).rows[0].id;
        await adminDb.query(
          `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq) VALUES
             ($1, $2, 1, 0.01, 'MARKET', 'CASH_IN', 'FILLED', timezone('UTC', now()), 1),
             (47, $2, 2, 0.02, 'MARKET', 'BUY',     'FILLED', timezone('UTC', now()), 2)`, [ars, u]);
        const insert = async (price: string) => (await adminDb.query<{ id: string }>(
          `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
           VALUES (47, $1, 2, $2, 'LIMIT', 'SELL', 'NEW', timezone('UTC', now())) RETURNING id::text`, [u, price])).rows[0].id;
        const over = await insert('500000000000000.01');
        const ok = await insert('900.00');
        const original = { id: over, userid: String(u), instrumentid: '47', side: 'SELL', type: 'LIMIT', size: '2',
          price: '500000000000000.01', amount: '1000000000000000.02', status: 'NEW', balance_seq: null,
          datetime: '2026-01-02T03:04:05Z', cancel_reason: null };
        await adminDb.query(
          `INSERT INTO app.idempotency_keys (userid, key, request_hash, order_id, http_status, response_body)
           VALUES ($1, 'pre41', 'h41', $2, 201, $3)`, [u, over, original]);
        const replay = async (key: string) => (await api.query<{ r: Record<string, unknown> }>(
          "SELECT app.place_order($1, $2, 'h41', 'SELL', 'LIMIT', 47, 2, NULL, 500000000000000.01) AS r", [u, key])).rows[0].r;
        const expected = { status: 201, body: original, replay: true, order_id: over };
        expect(await replay('pre41')).toEqual(expected);

        const log: string[] = [];
        const r = await bootstrap({ adminUrl: url, apiPassword: 'api', log: (m) => log.push(m) });
        expect(r.applied).toEqual(['010_order_cap_verify.sql']);
        const detail = `orden ${over} pendiente con importe 1000000000000000.02 ARS > 10^15 ARS: no se ejecuta (D-14)`;
        // Solo 'tope': la reserva de la que va a cancelar no le quita respaldo a la otra (2 acciones, 2 reservadas).
        expect(r.ledger.filter((p) => p.userid === u)).toEqual([{ userid: u, problem: 'tope', detail }]);
        expect(r.overCap).toEqual([over]);
        expect(r.unbacked).toEqual([]);
        expect(log).toContain(`  historia: usuario ${u} — tope: ${detail}`);
        expect(log).toContain(`  historia: usuario ${u} — orden ${over} cancelada: importe por encima de 10^15 ARS (cancel_reason LIMIT)`);
        const state = async (id: string) => (await adminDb.query('SELECT status, cancel_reason FROM app.orders WHERE id = $1', [id])).rows[0];
        expect(await state(over)).toEqual({ status: 'CANCELLED', cancel_reason: 'LIMIT' });
        expect(await state(ok)).toEqual({ status: 'NEW', cancel_reason: null });
        expect((await adminDb.query('SELECT 1 FROM app.verify_ledger() WHERE userid = $1', [u])).rowCount).toBe(0);

        // Segunda corrida: nada que aplicar, nada que verificar ni cancelar, la base queda igual.
        const again = await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
        expect(again).toMatchObject({ applied: [], ledger: [], unbacked: [], overCap: [] });
        expect(await state(over)).toEqual({ status: 'CANCELLED', cancel_reason: 'LIMIT' });
        expect(await state(ok)).toEqual({ status: 'NEW', cancel_reason: null });

        // D-19: la clave conserva su respuesta original (NEW); una clave nueva con el mismo request, el tope.
        expect(await replay('pre41')).toEqual(expected);
        await expect(replay('nueva41')).rejects.toMatchObject({ code: 'APP05' });
        expect((await adminDb.query('SELECT count(*)::int AS n FROM app.orders WHERE userid = $1', [u])).rows[0].n).toBe(4);
      } finally {
        await api.end();
        await adminDb.end();
      }
    }, 120_000);

    // El mismo despliegue sobre una base con cinco usuarios heredados, cada uno con un caso:
    //   overflow  historia fuera de numeric(20,0) y una NEW por encima del tope: se informan las
    //             dos, la NEW se cancela con LIMIT sin leer el fold y la historia no cambia;
    //   otro      una venta sin acciones: UNBACKED, el bootstrap sigue para él y puede operar;
    //   orden     10 acciones, una venta de 10 por encima del tope (con respaldo) y después ventas
    //             de 10 y de 5 dentro del tope: primero el tope (LIMIT), después el respaldo
    //             (la de 10 sigue NEW y solo la de 5 queda UNBACKED);
    //   borde     cash 10¹⁵, una compra de importe exacto 10¹⁵ y otra de 10¹⁵ + 0,01: solo la segunda;
    //   solo      ninguna orden FILLED, una sola venta de 2³¹ − 1 a 9.999.999.999.999.999,99
    //             (el máximo representable): tope con el importe exacto y LIMIT, no UNBACKED.
    it('cinco usuarios heredados: tope con overflow, tope antes que el respaldo, borde exacto y producto máximo sin historia', async () => {
      await recreateDatabase(DB);
      await deployWithout010();
      const adminDb = new pg.Pool({ connectionString: url });
      const api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
      try {
        const ars = (await adminDb.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'ARS'")).rows[0].id;
        const user = async (tag: string, n: number) => (await adminDb.query<{ id: number }>(
          'INSERT INTO app.users (email, accountnumber) VALUES ($1, $2) RETURNING id', [`tope41-${tag}@test.local`, `994100000${n}`])).rows[0].id;
        /** Historia FILLED, en orden de balance_seq: [instrumentid, side, size, price]. */
        const filled = async (u: number, rows: [number, string, number, string][]) => {
          for (const [i, [iid, side, size, price]] of rows.entries()) {
            await adminDb.query(
              `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime, balance_seq)
               VALUES ($1, $2, $3, $4, 'MARKET', $5, 'FILLED', timezone('UTC', now()), $6)`, [iid, u, size, price, side, i + 1]);
          }
        };
        const pending = async (u: number, side: 'BUY' | 'SELL', size: number, price: string) => (await adminDb.query<{ id: string }>(
          `INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
           VALUES (47, $1, $2, $3, 'LIMIT', $4, 'NEW', timezone('UTC', now())) RETURNING id::text`, [u, size, price, side])).rows[0].id;

        const uOverflow = await user('overflow', 1);
        await filled(uOverflow, [[ars, 'CASH_IN', 100_000, '0.01'], [47, 'BUY', 2_147_483_647, '9999999999999999.99']]);
        const overflowNew = await pending(uOverflow, 'SELL', 2, '500000000000000.01');
        const uOther = await user('otro', 2);
        const otherSell = await pending(uOther, 'SELL', 10, '900.00');
        const uOrder = await user('orden', 3);
        await filled(uOrder, [[ars, 'CASH_IN', 1, '0.01'], [47, 'BUY', 10, '0.01']]);
        const orderOver = await pending(uOrder, 'SELL', 10, '100000000000000.01');   // importe 10¹⁵ + 0,10
        const order10 = await pending(uOrder, 'SELL', 10, '900.00');
        const order5 = await pending(uOrder, 'SELL', 5, '900.00');
        const uEdge = await user('borde', 4);
        await filled(uEdge, [[ars, 'CASH_IN', 1, '0.01'], [47, 'BUY', 1, '0.01'], [47, 'SELL', 1, '1000000000000000.00']]);
        const edgeExact = await pending(uEdge, 'BUY', 1, '1000000000000000.00');
        const edgeOver = await pending(uEdge, 'BUY', 1, '1000000000000000.01');
        const uOnly = await user('solo', 5);
        const onlyNew = await pending(uOnly, 'SELL', 2_147_483_647, '9999999999999999.99');

        const filledOf = async (u: number) =>
          (await adminDb.query("SELECT id, size, price::text, balance_seq FROM app.orders WHERE userid = $1 AND status = 'FILLED' ORDER BY id", [u])).rows;
        const overflowHistory = await filledOf(uOverflow);
        const cash = async (u: number) =>
          (await adminDb.query<{ c: string }>('SELECT cash_cents::text AS c FROM app.c_state($1) WHERE kind = 0', [u])).rows[0].c;
        expect(await cash(uEdge)).toBe('100000000000000000');   // 10¹⁵ ARS

        const r = await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
        expect(r.applied).toEqual(['010_order_cap_verify.sql']);
        const tope = (id: string, amount: string) => `orden ${id} pendiente con importe ${amount} ARS > 10^15 ARS: no se ejecuta (D-14)`;
        const mine = [uOverflow, uOther, uOrder, uEdge, uOnly];
        expect(r.ledger.filter((p) => mine.includes(p.userid))).toEqual([
          { userid: uOverflow, problem: 'tope', detail: tope(overflowNew, '1000000000000000.02') },
          { userid: uOverflow, problem: 'overflow', detail: expect.any(String) },
          { userid: uOther, problem: 'reserva', detail: 'instrumento 47: 10 acciones reservadas > tenencia 0: venta LIMIT pendiente sin respaldo' },
          { userid: uOrder, problem: 'tope', detail: tope(orderOver, '1000000000000000.10') },
          { userid: uOrder, problem: 'reserva', detail: 'instrumento 47: 15 acciones reservadas > tenencia 10: venta LIMIT pendiente sin respaldo' },
          { userid: uEdge, problem: 'tope', detail: tope(edgeOver, '1000000000000000.01') },
          { userid: uOnly, problem: 'tope', detail: tope(onlyNew, '21474836469999999978525163.53') },
        ]);
        expect(r.overCap).toEqual([overflowNew, orderOver, edgeOver, onlyNew]);
        expect(r.unbacked).toEqual([otherSell, order5]);

        const state = async (id: string) => (await adminDb.query('SELECT status, cancel_reason FROM app.orders WHERE id = $1', [id])).rows[0];
        const LIMIT = { status: 'CANCELLED', cancel_reason: 'LIMIT' };
        const UNBACKED = { status: 'CANCELLED', cancel_reason: 'UNBACKED' };
        const NEW = { status: 'NEW', cancel_reason: null };
        for (const [id, want] of [[overflowNew, LIMIT], [otherSell, UNBACKED], [orderOver, LIMIT], [order10, NEW], [order5, UNBACKED],
          [edgeExact, NEW], [edgeOver, LIMIT], [onlyNew, LIMIT]] as const) {
          expect(await state(id), `orden ${id}`).toEqual(want);
        }
        expect(await filledOf(uOverflow)).toEqual(overflowHistory);
        // El otro usuario sigue operando después del despliegue.
        expect((await api.query<{ r: { status: number } }>(
          "SELECT app.place_order($1, 'dep41', 'h', 'CASH_IN', 'MARKET', $2, NULL, 1.00, NULL, NULL) AS r", [uOther, ars])).rows[0].r.status).toBe(201);

        // Queda solo la historia que no se puede corregir; la segunda corrida no hace nada.
        expect((await adminDb.query('SELECT userid, problem FROM app.verify_ledger() WHERE userid = ANY($1)', [mine])).rows)
          .toEqual([{ userid: uOverflow, problem: 'overflow' }]);
        expect(await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet })).toMatchObject({ applied: [], ledger: [], unbacked: [], overCap: [] });
        expect(await state(order10)).toEqual(NEW);
        expect(await state(edgeExact)).toEqual(NEW);
      } finally {
        await api.end();
        await adminDb.end();
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

  it('historia con un costo de 10¹³ y otra fuera de numeric(20,0) con una LIMIT NEW: el bootstrap termina, informa solo el overflow, deja la NEW y los demás operan', async () => {
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
          -- historia-1 también tiene una LIMIT NEW (sin respaldo: sin fold no se revisa, issue #57).
          IF i = 1 THEN
            INSERT INTO app.orders (instrumentid, userid, size, price, type, side, status, datetime)
            VALUES (inst, u, 1, 1.00, 'LIMIT', 'BUY', 'NEW', timezone('UTC', now()));
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
      // El de overflow (issue #57): su NEW sigue NEW, sin cancel_reason, y la API le responde APP07
      // (409 HISTORY_OVERFLOW) en el portfolio y en una orden, no 22003 (500).
      expect((await adminDb.query("SELECT status, cancel_reason FROM app.orders WHERE userid = $1 AND type = 'LIMIT'", [ids[1]])).rows)
        .toEqual([{ status: 'NEW', cancel_reason: null }]);
      await expect(api.query('SELECT * FROM app.read_portfolio($1)', [ids[1]])).rejects.toMatchObject({ code: 'APP07' });
      await expect(api.query("SELECT app.place_order($1, 'dep', 'h', 'CASH_IN', 'MARKET', $2, NULL, 1.00, NULL, NULL)", [ids[1], ars]))
        .rejects.toMatchObject({ code: 'APP07' });
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
