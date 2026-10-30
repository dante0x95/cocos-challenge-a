// Contrato de la API con la versión anterior (issue #39, D-24). La base tiene registrado el contrato
// de la versión que atiende (N−1: esta rama, src/db/contract.ts). El bootstrap de N, con sus
// funciones ya aplicadas y antes del COMMIT, verifica que cada llamada de N−1 siga resolviendo y
// que api pueda ejecutarla: si N retira una firma que N−1 usa, aborta y no deja nada aplicado.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
/** El contrato de N: el de N−1 con place_order de 11 argumentos. */
const CONTRACT_N = API_CONTRACT.map((s) => (s === OLD ? NEW : s));

/**
 * La versión N: place_order con un argumento nuevo, p_channel. La firma de 10 deja de existir (se
 * renombra a place_order_v1, que la nueva llama). Con `compatible`, p_channel (y p_legacy_hash)
 * tienen DEFAULT y una llamada de 10 argumentos sigue resolviendo; sin él, es obligatorio. Además,
 * una migración nueva, para ver que un bootstrap que aborta no la deja aplicada.
 */
function versionN(dir: string, compatible: boolean): void {
  const def = compatible ? ' DEFAULT NULL' : '';
  writeFileSync(join(dir, 'migrations', '999_contract_probe.sql'), 'CREATE TABLE app.contract_probe (x int);\n');
  writeFileSync(join(dir, 'functions', '085_place_order_channel.sql'), `
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

async function deployN(compatible: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'cocos-db-39-'));
  try {
    cpSync(resolve('db'), dir, { recursive: true });
    versionN(dir, compatible);
    return await bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, contract: CONTRACT_N, ...quiet });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('contrato de la API con la versión anterior (issue #39)', () => {
  let adminDb: pg.Pool;
  let api: pg.Pool;
  beforeEach(async () => {
    // N−1: esta rama, con su contrato registrado.
    await recreateDatabase(DB);
    await bootstrap({ adminUrl: url, apiPassword: 'api', ...quiet });
    adminDb = new pg.Pool({ connectionString: url });
    api = new pg.Pool({ connectionString: dbUrl(DB, { name: 'api', password: 'api' }) });
  }, 60_000);
  afterEach(async () => {
    await api.end();
    await adminDb.end();
  });

  const signatures = async () => (await adminDb.query<{ sig: string }>(
    `SELECT oid::regprocedure::text AS sig FROM pg_proc WHERE proname = 'place_order' ORDER BY oid::regprocedure::text COLLATE "C"`)).rows.map((r) => r.sig);
  const registered = async () =>
    (await adminDb.query<{ signature: string }>('SELECT signature FROM public.api_contract ORDER BY signature COLLATE "C"')).rows.map((r) => r.signature);
  /** Un depósito con la llamada de N−1 (src/repositories/orders.repo.ts): 10 argumentos, como api. */
  const cashIn10 = async (key: string) => (await api.query<{ r: any }>(
    "SELECT app.place_order(1, $1, 'h', 'CASH_IN', 'MARKET', NULL, NULL, 100, NULL, NULL) AS r", [key])).rows[0].r;

  it('el bootstrap registra el contrato de esta versión, y uno que no resuelve en su propia base aborta', async () => {
    expect(await registered()).toEqual([...API_CONTRACT].sort());
    // Una firma que esta versión dice llamar y sus funciones no crean: el contrato está mal.
    await expect(bootstrap({ adminUrl: url, apiPassword: 'api', contract: [...API_CONTRACT, 'app.health(integer)'], ...quiet }))
      .rejects.toThrow('contrato de la API: app.health(integer), que llama esta versión: no resuelve');
    expect(await registered()).toEqual([...API_CONTRACT].sort());
  }, 60_000);

  it('N retira la firma de place_order que llama N−1: aborta antes del COMMIT, no aplica nada y api sigue llamando la firma vieja', async () => {
    await expect(deployN(false)).rejects.toThrow(
      `contrato de la API: ${OLD}, que llama la versión anterior: no resuelve. Retirar o cambiar una firma que usa la versión anterior va en el release siguiente`);

    // Nada aplicado: ni la migración de N, ni sus funciones, ni su contrato.
    expect((await adminDb.query("SELECT to_regclass('app.contract_probe') AS t")).rows[0].t).toBeNull();
    expect((await adminDb.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE name = '999_contract_probe.sql'")).rows[0].n).toBe(0);
    expect(await signatures()).toEqual([OLD]);
    expect(await registered()).toEqual([...API_CONTRACT].sort());
    // N−1 sigue escribiendo con su llamada de 10 argumentos.
    expect(await cashIn10('c39-viejo')).toMatchObject({ status: 201, replay: false });
  }, 60_000);

  it('N agrega un argumento con DEFAULT: el bootstrap pasa, api llama con 10 y con 11 argumentos, y queda registrado el contrato de N', async () => {
    const r = await deployN(true);
    expect(r.previousContract).toEqual([...API_CONTRACT].sort());
    expect(r.applied).toEqual(['999_contract_probe.sql']);
    expect(await signatures()).toEqual([NEW]);
    expect(await registered()).toEqual([...CONTRACT_N].sort());

    expect(await cashIn10('c39-n-1')).toMatchObject({ status: 201, replay: false });
    const n = (await api.query<{ r: any }>(
      "SELECT app.place_order(1, 'c39-n', 'h', 'CASH_IN', 'MARKET', NULL, NULL, 100, NULL, NULL, 'web') AS r")).rows[0].r;
    expect(n).toMatchObject({ status: 201, replay: false });
  }, 60_000);

  it('N agrega la firma de 11 argumentos con DEFAULT sin retirar la de 10: la llamada de N−1 sería ambigua y aborta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-39-'));
    try {
      cpSync(resolve('db'), dir, { recursive: true });
      writeFileSync(join(dir, 'functions', '085_place_order_overload.sql'), `
CREATE OR REPLACE FUNCTION app.place_order(
  p_userid int, p_key text, p_hash text,
  p_side text, p_type text, p_instrumentid int, p_size int, p_amount numeric, p_limit numeric,
  p_legacy_hash text, p_channel text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`);
      await expect(bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet }))
        .rejects.toThrow(`contrato de la API: ${OLD}, que llama las dos versiones: es ambigua (${OLD}, ${NEW})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await signatures()).toEqual([OLD]);
    expect(await cashIn10('c39-ambigua')).toMatchObject({ status: 201, replay: false });
  }, 60_000);

  it('N le quita a api el EXECUTE sobre una función que llama N−1: aborta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-db-39-'));
    try {
      cpSync(resolve('db'), dir, { recursive: true });
      const f090 = readFileSync(join(dir, 'functions', '090_privileges.sql'), 'utf8');
      writeFileSync(join(dir, 'functions', '090_privileges.sql'), `${f090}\nREVOKE EXECUTE ON FUNCTION app.health() FROM api;\n`);
      await expect(bootstrap({ adminUrl: url, apiPassword: 'api', dbDir: dir, ...quiet }))
        .rejects.toThrow('contrato de la API: app.health(), que llama las dos versiones: api no puede ejecutar app.health()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect((await api.query('SELECT users FROM app.health()')).rowCount).toBe(1);
  }, 60_000);
});
