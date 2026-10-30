// Contrato de la API con la versión anterior (issue #39, D-24). La base tiene registrado el contrato
// del release que atiende (A: esta rama, src/db/contract.ts). El bootstrap de N, con sus funciones
// ya aplicadas y antes del COMMIT, verifica que cada llamada de A siga resolviendo y que api pueda
// ejecutarla: si N retira una firma que A usa, aborta y no deja nada aplicado. El release que
// atiende lo dice el deploy (SERVING_RELEASE), así que después de una vuelta atrás se sigue
// exigiendo el contrato del restaurado y no el del release que falló.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { bootstrap } from '../../src/db/bootstrap.js';
import { API_CONTRACT } from '../../src/db/contract.js';
import { recreateDatabase } from '../support/global-setup.js';
import { dbUrl } from '../support/urls.js';

const DB = 'cocos_contract_test';
const url = dbUrl(DB);
const quiet = { log: () => undefined };

const ARGS10 = 'int, text, text, text, text, int, int, numeric, numeric, text';
const OLD = 'app.place_order(integer,text,text,text,text,integer,integer,numeric,numeric,text)';
const NEW = 'app.place_order(integer,text,text,text,text,integer,integer,numeric,numeric,text,text)';
/** El contrato de N: el de A con place_order de 11 argumentos. */
const CONTRACT_N = API_CONTRACT.map((s) => (s === OLD ? NEW : s));
const sorted = (xs: readonly string[]) => [...xs].sort();

// La consulta de src/repositories/orders.repo.ts, tal cual: diez parámetros sin tipo.
const PLACE_ORDER_SQL = 'SELECT app.place_order($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r';

/**
 * La versión N: place_order con un argumento nuevo, p_channel. La firma de 10 deja de existir (se
 * renombra a place_order_v1, que la nueva llama); se puede volver a correr sobre una base que ya
 * la tiene. Con `compatible`, p_channel (y p_legacy_hash) tienen DEFAULT y una llamada de 10
 * argumentos sigue resolviendo; sin él, son obligatorios. Además, una migración nueva, para ver que
 * un bootstrap que aborta no la deja aplicada.
 */
function versionN(dir: string, compatible: boolean): void {
  const def = compatible ? ' DEFAULT NULL' : '';
  writeFileSync(join(dir, 'migrations', '999_contract_probe.sql'), 'CREATE TABLE app.contract_probe (x int);\n');
  writeFileSync(join(dir, 'functions', '085_place_order_channel.sql'), `
DROP FUNCTION IF EXISTS app.place_order_v1(${ARGS10});
DROP FUNCTION IF EXISTS app.place_order(${ARGS10}, text);
ALTER FUNCTION app.place_order(${ARGS10}) RENAME TO place_order_v1;
CREATE FUNCTION app.place_order(
  p_userid int, p_key text, p_hash text,
  p_side text, p_type text, p_instrumentid int, p_size int, p_amount numeric, p_limit numeric,
  p_legacy_hash text${def}, p_channel text${def})
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT app.place_order_v1(p_userid, p_key, p_hash, p_side, p_type, p_instrumentid, p_size, p_amount, p_limit, p_legacy_hash)
$$;
`);
  const f090 = readFileSync(join(dir, 'functions', '090_privileges.sql'), 'utf8');
  const grant = `app.place_order(${ARGS10}),`;
  if (!f090.includes(grant)) throw new Error('090_privileges.sql ya no da EXECUTE sobre place_order de 10 argumentos: actualizar la prueba');
  writeFileSync(join(dir, 'functions', '090_privileges.sql'), f090.replace(grant, `app.place_order(${ARGS10}, text),`));
}

/** Bootstrap desde una copia de db/ modificada por `edit`. */
async function deployFrom(edit: (dir: string) => void, opts: { contract?: readonly string[]; release: string; servingRelease?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'cocos-db-39-'));
  try {
    cpSync(resolve('db'), dir, { recursive: true });
    edit(dir);
    return await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...opts, ...quiet });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const deployN = (compatible: boolean, release: string, servingRelease: string) =>
  deployFrom((dir) => versionN(dir, compatible), { contract: CONTRACT_N, release, servingRelease });

describe('contrato de la API con la versión anterior (issue #39)', () => {
  let adminDb: pg.Pool;
  let api: pg.Pool;
  beforeEach(async () => {
    // A: esta rama, con su contrato registrado; es el primer deploy (no atendía ninguno).
    await recreateDatabase(DB);
    await bootstrap({ adminUrl: url, apiPassword: 'api', release: 'a', servingRelease: '', ...quiet });
    adminDb = new pg.Pool({ connectionString: url });
    api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
  }, 60_000);
  afterEach(async () => {
    await api.end();
    await adminDb.end();
  });

  const signatures = async () => (await adminDb.query<{ sig: string }>(
    `SELECT oid::regprocedure::text AS sig FROM pg_proc WHERE proname = 'place_order' ORDER BY oid::regprocedure::text COLLATE "C"`)).rows.map((r) => r.sig);
  /** Los contratos registrados, por release. */
  const registered = async () => {
    const out: Record<string, string[]> = {};
    for (const r of (await adminDb.query<{ release: string; signature: string }>(
      'SELECT release, signature FROM public.api_contract ORDER BY release, signature COLLATE "C"')).rows) (out[r.release] ??= []).push(r.signature);
    return out;
  };
  /** Un depósito de A, por la consulta de orders.repo.ts: diez parámetros sin tipo, como api. */
  const cashInA = async (key: string) => (await api.query<{ r: any }>(
    PLACE_ORDER_SQL, [1, key, 'h', 'CASH_IN', 'MARKET', null, null, '100.00', null, null])).rows[0].r;

  it('la consulta de la prueba es la de orders.repo.ts', () => {
    expect(readFileSync(resolve('src/repositories/orders.repo.ts'), 'utf8')).toContain(`'${PLACE_ORDER_SQL}'`);
  });

  it('el bootstrap registra el contrato de esta versión con su release; uno propio que no resuelve o con otros tipos aborta', async () => {
    expect(await registered()).toEqual({ a: sorted(API_CONTRACT) });
    await expect(bootstrap({ adminUrl: url, apiPassword: 'api', release: 'x', servingRelease: 'a', contract: [...API_CONTRACT, 'app.health(integer)'], ...quiet }))
      .rejects.toThrow('contrato de la API: app.health(integer), que llama esta versión: no resuelve');
    await expect(bootstrap({ adminUrl: url, apiPassword: 'api', release: 'x', servingRelease: 'a',
      contract: API_CONTRACT.map((s) => s.replace('read_portfolio(integer)', 'read_portfolio(bigint)')), ...quiet }))
      .rejects.toThrow('contrato de la API: app.read_portfolio(bigint), que llama esta versión: resuelve a app.read_portfolio(integer), con otros tipos');
    expect(await registered()).toEqual({ a: sorted(API_CONTRACT) });
  }, 60_000);

  it('la CLI toma RELEASE y SERVING_RELEASE: registra el suyo y conserva el que atiende; sin SERVING_RELEASE verifica todos y conserva solo el suyo', async () => {
    const cli = (env: Record<string, string>) => spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/db/bootstrap.ts')], {
      encoding: 'utf8', env: { ...process.env, DATABASE_ADMIN_URL: url, API_DB_PASSWORD: 'api', ...env },
    });
    const withServing = cli({ RELEASE: 'b', SERVING_RELEASE: 'a' });
    expect(withServing.status, withServing.stderr).toBe(0);
    expect(withServing.stdout).toContain(`contrato: las ${API_CONTRACT.length} llamadas de a siguen resolviendo`);
    expect(await registered()).toEqual({ a: sorted(API_CONTRACT), b: sorted(API_CONTRACT) });
    const dev = cli({ RELEASE: 'c' });
    expect(dev.status, dev.stderr).toBe(0);
    expect(dev.stdout).toContain('no se sabe cuál atiende');
    expect(await registered()).toEqual({ c: sorted(API_CONTRACT) });
  }, 60_000);

  it('N retira la firma de place_order que llama A: aborta antes del COMMIT, no aplica nada y A sigue escribiendo', async () => {
    await expect(deployN(false, 'n', 'a')).rejects.toThrow(
      `contrato de la API: ${OLD}, que llama la versión anterior: no resuelve. Retirar o cambiar una firma que usa la versión anterior va en el release siguiente`);

    // Nada aplicado: ni la migración de N, ni sus funciones, ni su contrato.
    expect((await adminDb.query("SELECT to_regclass('app.contract_probe') AS t")).rows[0].t).toBeNull();
    expect((await adminDb.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE name = '999_contract_probe.sql'")).rows[0].n).toBe(0);
    expect(await signatures()).toEqual([OLD]);
    expect(await registered()).toEqual({ a: sorted(API_CONTRACT) });
    expect(await cashInA('c39-viejo')).toMatchObject({ status: 201, replay: false });
  }, 60_000);

  it('N agrega un argumento con DEFAULT: el bootstrap pasa, api llama con 10 y con 11 argumentos, y quedan los contratos de A y de N', async () => {
    const r = await deployN(true, 'n', 'a');
    expect(r.previousContract).toEqual(sorted(API_CONTRACT));
    expect(r.applied).toEqual(['999_contract_probe.sql']);
    expect(await signatures()).toEqual([NEW]);
    expect(await registered()).toEqual({ a: sorted(API_CONTRACT), n: sorted(CONTRACT_N) });

    expect(await cashInA('c39-a')).toMatchObject({ status: 201, replay: false });
    const n = (await api.query<{ r: any }>(
      'SELECT app.place_order($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS r',
      [1, 'c39-n', 'h', 'CASH_IN', 'MARKET', null, null, '100.00', null, null, 'web'])).rows[0].r;
    expect(n).toMatchObject({ status: 201, replay: false });
  }, 60_000);

  // CR-1: la compatibilidad no es transitiva. B agrega el DEFAULT (compatible con A), su cambio de
  // versión falla y se vuelve a A. C saca el DEFAULT: es compatible con B pero no con A, que es el
  // que atiende. Comparado con el último bootstrap (B) pasaría y A daría 500.
  it('bootstrap de B, vuelta atrás a A y bootstrap de C incompatible con A: aborta, conserva el contrato de A y A sigue escribiendo', async () => {
    await deployN(true, 'b', 'a');
    // La vuelta atrás no toca la base: A vuelve a atender sobre las funciones de B.
    expect(await cashInA('c39-restaurado')).toMatchObject({ status: 201, replay: false });

    await expect(deployN(false, 'c', 'a')).rejects.toThrow(
      `contrato de la API: ${OLD}, que llama la versión anterior: no resuelve`);
    expect(await registered()).toEqual({ a: sorted(API_CONTRACT), b: sorted(CONTRACT_N) });
    expect(await signatures()).toEqual([NEW]);
    expect(await cashInA('c39-restaurado-2')).toMatchObject({ status: 201, replay: false });

    // Si el cambio a B hubiera salido bien (atiende B), C es compatible: pasa y el contrato de A se retira.
    await deployN(false, 'c', 'b');
    expect(await registered()).toEqual({ b: sorted(CONTRACT_N), c: sorted(CONTRACT_N) });
  }, 60_000);

  it('N agrega la firma de 11 argumentos con DEFAULT sin retirar la de 10: la llamada de A sería ambigua y aborta', async () => {
    await expect(deployFrom((dir) => writeFileSync(join(dir, 'functions', '085_place_order_overload.sql'), `
CREATE OR REPLACE FUNCTION app.place_order(
  p_userid int, p_key text, p_hash text,
  p_side text, p_type text, p_instrumentid int, p_size int, p_amount numeric, p_limit numeric,
  p_legacy_hash text, p_channel text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`), { release: 'n', servingRelease: 'a' }))
      .rejects.toThrow(`contrato de la API: ${OLD}, que llama las dos versiones: es ambigua (${OLD}, ${NEW})`);
    expect(await signatures()).toEqual([OLD]);
    expect(await cashInA('c39-ambigua')).toMatchObject({ status: 201, replay: false });
  }, 60_000);

  // CR-2: una sobrecarga que difiere solo en un tipo. La API manda parámetros sin tipo, así que para
  // Postgres es ambigua aunque los tipos del contrato coincidan con una sola de las dos.
  it('N agrega place_order con bigint en p_userid sin retirar la de integer: la consulta real de A da 42725 y el bootstrap aborta', async () => {
    const overload = `
CREATE OR REPLACE FUNCTION app.place_order(
  p_userid bigint, p_key text, p_hash text,
  p_side text, p_type text, p_instrumentid int, p_size int, p_amount numeric, p_limit numeric,
  p_legacy_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`;
    const BIG = 'app.place_order(bigint,text,text,text,text,integer,integer,numeric,numeric,text)';
    // Lo que le pasaría a A con ese catálogo, en una transacción que se descarta.
    const c = await adminDb.connect();
    try {
      await c.query('BEGIN');
      await c.query(overload);
      await expect(c.query(PLACE_ORDER_SQL, [1, 'c39-x', 'h', 'CASH_IN', 'MARKET', null, null, '100.00', null, null]))
        .rejects.toMatchObject({ code: '42725' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }

    await expect(deployFrom((dir) => writeFileSync(join(dir, 'functions', '085_place_order_bigint.sql'), overload),
      { release: 'n', servingRelease: 'a' }))
      .rejects.toThrow(`contrato de la API: ${OLD}, que llama las dos versiones: es ambigua (${BIG}, ${OLD})`);
    expect(await signatures()).toEqual([OLD]);
    expect(await registered()).toEqual({ a: sorted(API_CONTRACT) });
    expect(await cashInA('c39-bigint')).toMatchObject({ status: 201, replay: false });
  }, 60_000);

  it('N le quita a api el EXECUTE sobre una función que llama A: aborta', async () => {
    await expect(deployFrom((dir) => {
      const f090 = readFileSync(join(dir, 'functions', '090_privileges.sql'), 'utf8');
      writeFileSync(join(dir, 'functions', '090_privileges.sql'), `${f090}\nREVOKE EXECUTE ON FUNCTION app.health() FROM api;\n`);
    }, { release: 'n', servingRelease: 'a' }))
      .rejects.toThrow('contrato de la API: app.health(), que llama las dos versiones: api no puede ejecutar app.health()');
    expect((await api.query('SELECT users FROM app.health()')).rowCount).toBe(1);
  }, 60_000);
});
