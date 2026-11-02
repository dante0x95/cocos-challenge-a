// Bootstrap de la base (D-24): migraciones versionadas + funciones repetibles + verificación.
// Idempotente: correrlo dos veces deja la base igual.
//
//   pnpm db:bootstrap                       (desarrollo, con tsx)
//   node dist/db/bootstrap.js               (contenedor `migrate` de docker compose)
//
// Necesita DATABASE_ADMIN_URL (un rol que pueda crear roles, esquemas y cambiar dueños), o
// DATABASE_ADMIN_URL_FILE con la ruta de un archivo que la tenga (en el servidor, D-29).
//
// 0. Si public.schema_migrations tiene una migración que no está en db/migrations, la base es de
//    un release posterior (issue #58): aborta antes de tocar nada, sin reinstalar sus funciones.
// 1. db/migrations/*.sql, en orden y UNA sola vez (public.schema_migrations guarda nombre y
//    checksum; un archivo ya aplicado que cambió aborta el bootstrap). 000_seed.sql es el
//    database.sql del challenge: si la base ya tiene las tablas del challenge (datos propios),
//    se registra como aplicado sin correrlo.
// 2. db/functions/*.sql, en orden, SIEMPRE (CREATE OR REPLACE): así se despliega un cambio.
// 3. Contraseña del rol api desde API_DB_PASSWORD.
// 4. Si se aplicó alguna migración: verifica la historia (app.verify_ledger) y aborta si el
//    cash del fold no coincide con la suma directa de importes. Un corto heredado (D-01) o una
//    historia fuera de lo representable (D-14) se informan y no abortan. Una LIMIT NEW sin
//    respaldo (heredada: place_order no las crea) se cancela con cancel_reason = 'UNBACKED'
//    (app.cancel_unbacked, bajo el lock del usuario) y se informa. Antes, una NEW con importe
//    por encima de 10^15 ARS (D-14, también heredada) se cancela con cancel_reason = 'LIMIT'
//    (app.cancel_over_cap) y se informa.
// 5. Contrato de la API (issue #39): con las funciones nuevas aplicadas, cada llamada del release
//    que atiende (SERVING_RELEASE; el contrato que registró su bootstrap en public.api_contract)
//    y cada una de esta versión (src/db/contract.ts) tiene que resolver a una sola función que
//    api pueda ejecutar. Si alguna no resuelve, aborta. Después registra el contrato de esta
//    versión con su RELEASE, y conserva el del release que atiende.
// Los cinco pasos van en UNA transacción, con la barrera de despliegue en modo exclusivo
// (D-24): un escritor nunca ve el esquema nuevo con las funciones anteriores, y si algo falla,
// también las verificaciones de los pasos 4 y 5, no queda nada aplicado (el deploy lo corre antes de cambiar
// de versión, D-29: un release rechazado no puede dejar la base cambiada).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { API_CONTRACT, parseSignature } from './contract.js';
import { withFileSecrets } from '../file-secrets.js';

export interface BootstrapOptions {
  adminUrl: string;
  apiPassword?: string;
  dbDir?: string;
  // Las firmas de app.* que invoca la API de esta versión. Por defecto, las de src/db/contract.ts;
  // las pruebas pasan el de otra versión.
  contract?: readonly string[];
  // El release de esta versión (RELEASE, el SHA del commit) y el que atiende mientras corre
  // (SERVING_RELEASE: '' si ninguno, sin definir si no se sabe). Los pasa el deploy (D-29).
  release?: string;
  servingRelease?: string;
  log?: (msg: string) => void;
}

export interface LedgerProblem { userid: number; problem: string; detail: string }

export interface BootstrapResult {
  applied: string[];
  baselined: string[];
  functions: string[];
  ledger: LedgerProblem[];
  // LIMIT NEW heredadas sin respaldo, canceladas con cancel_reason = 'UNBACKED' (issue #6).
  unbacked: string[];
  // NEW heredadas con importe por encima de 10^15 ARS, canceladas con cancel_reason = 'LIMIT' (issue #41).
  overCap: string[];
  // El contrato del release que atiende que se verificó (vacío si no había ninguno registrado).
  previousContract: string[];
}

const sqlFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dbDir = resolve(opts.dbDir ?? process.env.DB_DIR ?? 'db');
  // Sin query_timeout, a propósito: verify_ledger es una sola sentencia sobre todos los usuarios y
  // puede tardar minutos en una base grande. El plazo local del driver es de la API (D-20).
  const db = new pg.Pool({ connectionString: opts.adminUrl, max: 2, application_name: 'cocos-bootstrap' });
  db.on('error', () => undefined);   // una conexión ociosa que se corta no tumba el proceso
  try {
    return await run(db, dbDir, opts, log);
  } finally {
    await db.end();
  }
}

/**
 * Paso 4 del bootstrap: verifica la historia, dentro de su transacción. Aborta (excepción) si el
 * cash del fold no coincide con la suma directa de importes. Un corto o un cash negativo
 * heredados (D-01) o una historia fuera de lo representable (D-14) solo se informan. Las NEW por
 * encima del tope de D-14 y después las LIMIT NEW sin respaldo se cancelan usuario por usuario, bajo su lock
 * (app.cancel_over_cap y app.cancel_unbacked vuelven a decidir con el estado del momento), y se
 * informan con su id. Primero el tope: lo que esas reservaban no cuenta para el respaldo de las demás.
 */
export async function verifyLedger(db: pg.Pool | pg.PoolClient, log: (m: string) => void): Promise<{ ledger: LedgerProblem[]; unbacked: string[]; overCap: string[] }> {
  const ledger = (await db.query<LedgerProblem>('SELECT userid, problem, detail FROM app.verify_ledger()')).rows;
  for (const p of ledger) log(`  historia: usuario ${p.userid} — ${p.problem}: ${p.detail}`);
  const tolerated = new Set(['short', 'cash negativo', 'overflow', 'reserva', 'tope']);
  const broken = ledger.filter((p) => !tolerated.has(p.problem));
  if (broken.length) throw new Error(`verificación de la historia falló para ${broken.length} usuario(s)`);
  const overCap: string[] = [];
  for (const userid of new Set(ledger.filter((p) => p.problem === 'tope').map((p) => p.userid))) {
    const ids = (await db.query<{ order_id: string }>('SELECT order_id::text FROM app.cancel_over_cap($1)', [userid])).rows.map((r) => r.order_id);
    for (const id of ids) log(`  historia: usuario ${userid} — orden ${id} cancelada: importe por encima de 10^15 ARS (cancel_reason LIMIT)`);
    overCap.push(...ids);
  }
  const unbacked: string[] = [];
  for (const userid of new Set(ledger.filter((p) => p.problem === 'reserva').map((p) => p.userid))) {
    const ids = (await db.query<{ order_id: string }>('SELECT order_id::text FROM app.cancel_unbacked($1)', [userid])).rows.map((r) => r.order_id);
    for (const id of ids) log(`  historia: usuario ${userid} — orden ${id} cancelada: LIMIT pendiente sin respaldo (cancel_reason UNBACKED)`);
    unbacked.push(...ids);
  }
  return { ledger, unbacked, overCap };
}

/** Por qué una llamada del contrato no resuelve, o null si resuelve a una sola función que api puede ejecutar. */
async function contractProblem(db: pg.PoolClient, signature: string): Promise<string | null> {
  const { name, args } = parseSignature(signature);
  // Candidata es toda función de app con ese nombre que acepta esa cantidad de argumentos (contando
  // los que tienen DEFAULT, como p_legacy_hash en el issue #4), sin mirar los tipos: la API manda
  // parámetros sin tipo ($1, $2, ...), y para Postgres dos candidatas que difieren solo en un tipo
  // son una llamada ambigua (42725). Una sola candidata tiene que tener los tipos del contrato.
  const found = (await db.query<{ fn: string; same: boolean; exec: boolean }>(
    `SELECT p.oid::regprocedure::text AS fn,
            p.provariadic = 0 AND (p.proargtypes::oid[])[0:cardinality($2::regtype[]) - 1] = $2::regtype[]::oid[] AS same,
            has_function_privilege('api', p.oid, 'EXECUTE') AS exec
       FROM pg_proc p
      WHERE p.pronamespace = 'app'::regnamespace AND p.proname = $1 AND p.prokind = 'f'
        AND (p.provariadic <> 0
             OR (p.pronargs >= cardinality($2::regtype[]) AND p.pronargs - p.pronargdefaults <= cardinality($2::regtype[])))
      ORDER BY p.oid::regprocedure::text COLLATE "C"`, [name, args])).rows;
  if (found.length === 0) return 'no resuelve';
  if (found.length > 1) return `es ambigua (${found.map((f) => f.fn).join(', ')})`;
  if (!found[0].same) return `resuelve a ${found[0].fn}, con otros tipos`;
  if (!found[0].exec) return `api no puede ejecutar ${found[0].fn}`;
  return null;
}

/**
 * Paso 5 del bootstrap (issue #39), dentro de su transacción y con las funciones nuevas ya
 * aplicadas. Verifica el contrato del release que atiende (`serving`: el que atiende durante el
 * deploy y al que vuelve una vuelta atrás) y el de esta versión, y registra el de esta versión
 * con su `release`. Aborta (excepción) si alguna llamada no resuelve.
 *
 * `serving`: el release que atiende (deploy.sh lo pasa en SERVING_RELEASE); '' si no atiende
 * ninguno (primer deploy); undefined si no se sabe (desarrollo): entonces se verifican todos los
 * contratos registrados. Quedan registrados el de esta versión y el del release que atiende, que
 * sigue siendo obligatorio hasta que otro bootstrap sepa que atiende otro.
 */
export async function verifyContract(db: pg.PoolClient, contract: readonly string[], release: string, serving: string | undefined,
  log: (m: string) => void): Promise<string[]> {
  if (!(await db.query("SELECT to_regclass('public.api_contract') AS t")).rows[0].t) {
    await db.query(`CREATE TABLE public.api_contract (
      release text NOT NULL, signature text NOT NULL, registered_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (release, signature))`);
  }
  const previous = serving === '' ? [] : (await db.query<{ signature: string }>(
    `SELECT DISTINCT signature COLLATE "C" AS signature FROM public.api_contract WHERE $1::text IS NULL OR release = $1
      ORDER BY 1`, [serving ?? null])).rows.map((r) => r.signature);
  const owners = new Map<string, string>();
  for (const s of previous) owners.set(s, 'la versión anterior');
  for (const s of contract) owners.set(s, owners.has(s) ? 'las dos versiones' : 'esta versión');
  const usage = (await db.query<{ ok: boolean }>("SELECT has_schema_privilege('api', 'app', 'USAGE') AS ok")).rows[0].ok;
  const broken: string[] = [];
  for (const [signature, owner] of owners) {
    const problem = usage ? await contractProblem(db, signature) : 'api no tiene USAGE sobre el esquema app';
    if (problem) broken.push(`${signature}, que llama ${owner}: ${problem}`);
  }
  if (broken.length) {
    throw new Error(`contrato de la API: ${broken.join('; ')}. Retirar o cambiar una firma que usa la versión anterior va en el release siguiente (expand/contract, D-24)`);
  }
  const who = serving === undefined ? 'los releases registrados (no se sabe cuál atiende)' : serving;
  log(previous.length ? `contrato: las ${previous.length} llamadas de ${who} siguen resolviendo`
    : serving === undefined ? `contrato: no hay ninguno registrado; se registra el de ${release}`
    : serving === '' ? `contrato: no atiende ningún release; se registra el de ${release}`
    : `contrato: el release que atiende (${serving}) no registró uno; se registra el de ${release}`);
  await db.query('DELETE FROM public.api_contract WHERE release = $1 OR release IS DISTINCT FROM $2', [release, serving || null]);
  await db.query('INSERT INTO public.api_contract (release, signature) SELECT $1, unnest($2::text[])', [release, contract]);
  return previous;
}

async function run(db: pg.Pool, dbDir: string, opts: BootstrapOptions, log: (m: string) => void): Promise<BootstrapResult> {
  const result: BootstrapResult = { applied: [], baselined: [], functions: [], ledger: [], unbacked: [], overCap: [], previousContract: [] };
  const client = await db.connect();
  client.on('notice', (n) => log(`  ${n.severity ?? 'NOTICE'}: ${n.message}`));

  try {
    // Un solo bootstrap a la vez sobre la misma base.
    await client.query("SELECT pg_advisory_lock(hashtext('cocos-bootstrap'))");
    if (!(await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t) {
      await client.query(`CREATE TABLE public.schema_migrations (
        name text PRIMARY KEY, checksum text NOT NULL, mode text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    }
    const done = new Map((await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM public.schema_migrations')).rows.map((r) => [r.name, r.checksum]));

    // Una base que migró un release posterior (issue #58): tiene migraciones que este no trae, y
    // sus funciones son las de ese release. Las de este no conocen lo que significan esos datos, y
    // el paso 2 las reinstalaría sin error. Frena antes de tomar la barrera: no toca nada.
    const migDir = join(dbDir, 'migrations');
    const migrations = sqlFiles(migDir);
    const unknown = [...done.keys()].filter((name) => !migrations.includes(name)).sort();
    if (unknown.length) {
      throw new Error(`la base tiene migraciones de un release posterior: ${unknown.join(', ')}; este release no puede reinstalar sus funciones`);
    }

    // 1 a 5, en una transacción. La barrera exclusiva espera a las escrituras en curso y frena
    // las nuevas hasta el COMMIT. Una que ya entró a la función anterior y quedó esperando la
    // barrera sigue con ese cuerpo: si choca con el esquema nuevo, la migración tiene que hacerla
    // fallar con un error reintentable (005: APP04 → 503).
    await client.query('BEGIN');
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('deploy'))");

      // 1. Migraciones
      for (const f of migrations) {
        const sql = readFileSync(join(migDir, f), 'utf8');
        const sum = sha256(sql);
        if (done.has(f)) {
          if (done.get(f) !== sum) throw new Error(`la migración ${f} ya se aplicó y su contenido cambió; crear una migración nueva en vez de editarla`);
          continue;
        }
        if (f.startsWith('000_')) {
          const existing = (await client.query<{ t: string | null }>(
            "SELECT COALESCE(to_regclass('public.users'), to_regclass('app.users'))::text AS t")).rows[0].t;
          if (existing) {
            await client.query("INSERT INTO public.schema_migrations (name, checksum, mode) VALUES ($1, $2, 'baseline')", [f, sum]);
            result.baselined.push(f);
            log(`migración ${f}: la base ya tiene datos (${existing}); se registra sin correr`);
            continue;
          }
        }
        log(`migración ${f}`);
        await client.query(`${sql}\n;INSERT INTO public.schema_migrations (name, checksum, mode) VALUES ('${f}', '${sum}', 'applied');`);
        result.applied.push(f);
      }

      // 2. Funciones (repetibles)
      const fnDir = join(dbDir, 'functions');
      for (const f of sqlFiles(fnDir)) {
        await client.query(readFileSync(join(fnDir, f), 'utf8'));
        result.functions.push(f);
      }
      log(`funciones: ${result.functions.join(', ')}`);

      // 3. Contraseña del rol api
      if (opts.apiPassword) {
        await client.query(`ALTER ROLE api WITH PASSWORD ${client.escapeLiteral(opts.apiPassword)}`);
      }

      // 4. Verificación de la historia
      if (result.applied.length > 0) {
        ({ ledger: result.ledger, unbacked: result.unbacked, overCap: result.overCap } = await verifyLedger(client, log));
      }

      // 5. Contrato de la API
      result.previousContract = await verifyContract(client, opts.contract ?? API_CONTRACT, opts.release ?? 'local', opts.servingRelease, log);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('cocos-bootstrap'))").catch(() => undefined);
    client.release();
  }
  return result;
}

// Ejecución directa (CLI).
// Los dos secretos también se aceptan como archivo: DATABASE_ADMIN_URL_FILE y API_DB_PASSWORD_FILE
// (D-29, issue #36; src/file-secrets.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let env: NodeJS.ProcessEnv;
  try {
    env = withFileSecrets(process.env, ['DATABASE_ADMIN_URL', 'API_DB_PASSWORD']);
  } catch (e) {
    console.error(`bootstrap FALLÓ: ${(e as Error).message}`);
    process.exit(2);
  }
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error('falta DATABASE_ADMIN_URL');
    process.exit(2);
  }
  bootstrap({ adminUrl, apiPassword: env.API_DB_PASSWORD ?? 'api',
    release: env.RELEASE || undefined, servingRelease: env.SERVING_RELEASE })
    .then((r) => {
      console.log(`bootstrap OK: ${r.applied.length} migración(es) aplicadas, ${r.baselined.length} registradas como existentes`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`bootstrap FALLÓ: ${(e as Error).message}`);
      process.exit(1);
    });
}
