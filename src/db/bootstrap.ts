// Bootstrap de la base (D-24): migraciones versionadas + funciones repetibles + verificación.
// Idempotente: correrlo dos veces deja la base igual.
//
//   pnpm db:bootstrap                       (desarrollo, con tsx)
//   node dist/db/bootstrap.js               (contenedor `migrate` de docker compose)
//
// Necesita DATABASE_ADMIN_URL (un rol que pueda crear roles, esquemas y cambiar dueños).
//
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
//    (app.cancel_unbacked, bajo el lock del usuario) y se informa.
// 5. Contrato de la API (issue #39): con las funciones nuevas aplicadas, cada llamada que hace la
//    versión anterior (el contrato que registró su bootstrap en public.api_contract) y cada una
//    de esta versión (src/db/contract.ts) tiene que resolver a una sola función que api pueda
//    ejecutar. Si alguna no resuelve, aborta. Después registra el contrato de esta versión.
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

export interface BootstrapOptions {
  adminUrl: string;
  apiPassword?: string;
  dbDir?: string;
  // Las firmas de app.* que invoca la API de esta versión. Por defecto, las de src/db/contract.ts;
  // las pruebas pasan el de otra versión.
  contract?: readonly string[];
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
  // El contrato de la versión anterior que se verificó (vacío si no había ninguno registrado).
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
 * cash del fold no coincide con la suma directa de importes. Un corto heredado (D-01) o una
 * historia fuera de lo representable (D-14) solo se informan. Las LIMIT NEW sin respaldo se
 * cancelan usuario por usuario, bajo su lock (app.cancel_unbacked vuelve a decidir con el estado
 * del momento), y se informan con su id.
 */
export async function verifyLedger(db: pg.Pool | pg.PoolClient, log: (m: string) => void): Promise<{ ledger: LedgerProblem[]; unbacked: string[] }> {
  const ledger = (await db.query<LedgerProblem>('SELECT userid, problem, detail FROM app.verify_ledger()')).rows;
  for (const p of ledger) log(`  historia: usuario ${p.userid} — ${p.problem}: ${p.detail}`);
  const broken = ledger.filter((p) => p.problem !== 'short' && p.problem !== 'overflow' && p.problem !== 'reserva');
  if (broken.length) throw new Error(`verificación de la historia falló para ${broken.length} usuario(s)`);
  const unbacked: string[] = [];
  for (const userid of new Set(ledger.filter((p) => p.problem === 'reserva').map((p) => p.userid))) {
    const ids = (await db.query<{ order_id: string }>('SELECT order_id::text FROM app.cancel_unbacked($1)', [userid])).rows.map((r) => r.order_id);
    for (const id of ids) log(`  historia: usuario ${userid} — orden ${id} cancelada: LIMIT pendiente sin respaldo (cancel_reason UNBACKED)`);
    unbacked.push(...ids);
  }
  return { ledger, unbacked };
}

/** Por qué una llamada del contrato no resuelve, o null si resuelve a una sola función que api puede ejecutar. */
async function contractProblem(db: pg.PoolClient, signature: string): Promise<string | null> {
  const { name, args } = parseSignature(signature);
  // Lo que haría Postgres con una llamada con exactamente esos tipos: la misma firma, o una con
  // argumentos de más que tienen DEFAULT (así entró p_legacy_hash, issue #4). Dos candidatas son
  // una llamada ambigua (42725), que también rompe a la versión anterior.
  const found = (await db.query<{ fn: string; exec: boolean }>(
    `SELECT p.oid::regprocedure::text AS fn, has_function_privilege('api', p.oid, 'EXECUTE') AS exec
       FROM pg_proc p
      WHERE p.pronamespace = 'app'::regnamespace AND p.proname = $1 AND p.prokind = 'f' AND p.provariadic = 0
        AND p.pronargs >= cardinality($2::regtype[]) AND p.pronargs - p.pronargdefaults <= cardinality($2::regtype[])
        AND (p.proargtypes::oid[])[0:cardinality($2::regtype[]) - 1] = $2::regtype[]::oid[]
      ORDER BY p.oid::regprocedure::text COLLATE "C"`, [name, args])).rows;
  if (found.length === 0) return 'no resuelve';
  if (found.length > 1) return `es ambigua (${found.map((f) => f.fn).join(', ')})`;
  if (!found[0].exec) return `api no puede ejecutar ${found[0].fn}`;
  return null;
}

/**
 * Paso 5 del bootstrap (issue #39), dentro de su transacción y con las funciones nuevas ya
 * aplicadas: verifica el contrato registrado por el bootstrap anterior (la versión que atiende
 * durante el deploy y a la que vuelve una vuelta atrás) y el de esta versión, y registra el de
 * esta versión. Aborta (excepción) si alguna llamada no resuelve.
 */
export async function verifyContract(db: pg.PoolClient, contract: readonly string[], log: (m: string) => void): Promise<string[]> {
  if (!(await db.query("SELECT to_regclass('public.api_contract') AS t")).rows[0].t) {
    await db.query('CREATE TABLE public.api_contract (signature text PRIMARY KEY, registered_at timestamptz NOT NULL DEFAULT now())');
  }
  const previous = (await db.query<{ signature: string }>('SELECT signature FROM public.api_contract ORDER BY signature COLLATE "C"')).rows.map((r) => r.signature);
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
  log(previous.length
    ? `contrato: las ${previous.length} llamadas de la versión anterior siguen resolviendo`
    : 'contrato: no había uno registrado; se registra el de esta versión');
  await db.query('DELETE FROM public.api_contract');
  await db.query('INSERT INTO public.api_contract (signature) SELECT unnest($1::text[])', [contract]);
  return previous;
}

async function run(db: pg.Pool, dbDir: string, opts: BootstrapOptions, log: (m: string) => void): Promise<BootstrapResult> {
  const result: BootstrapResult = { applied: [], baselined: [], functions: [], ledger: [], unbacked: [], previousContract: [] };
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

    // 1 a 5, en una transacción. La barrera exclusiva espera a las escrituras en curso y frena
    // las nuevas hasta el COMMIT. Una que ya entró a la función anterior y quedó esperando la
    // barrera sigue con ese cuerpo: si choca con el esquema nuevo, la migración tiene que hacerla
    // fallar con un error reintentable (005: APP04 → 503).
    await client.query('BEGIN');
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('deploy'))");

      // 1. Migraciones
      const migDir = join(dbDir, 'migrations');
      for (const f of sqlFiles(migDir)) {
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
        ({ ledger: result.ledger, unbacked: result.unbacked } = await verifyLedger(client, log));
      }

      // 5. Contrato de la API
      result.previousContract = await verifyContract(client, opts.contract ?? API_CONTRACT, log);
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error('falta DATABASE_ADMIN_URL');
    process.exit(2);
  }
  bootstrap({ adminUrl, apiPassword: process.env.API_DB_PASSWORD ?? 'api' })
    .then((r) => {
      console.log(`bootstrap OK: ${r.applied.length} migración(es) aplicadas, ${r.baselined.length} registradas como existentes`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`bootstrap FALLÓ: ${(e as Error).message}`);
      process.exit(1);
    });
}
