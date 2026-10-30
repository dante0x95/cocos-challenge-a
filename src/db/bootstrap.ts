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
//    historia fuera de lo representable (D-14) se informan y no abortan.
// Los cuatro pasos van en UNA transacción, con la barrera de despliegue en modo exclusivo
// (D-24): un escritor nunca ve el esquema nuevo con las funciones anteriores, y si algo falla,
// también la verificación del paso 4, no queda nada aplicado (es el release_command del deploy,
// D-29: un release rechazado no puede dejar la base cambiada).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export interface BootstrapOptions {
  adminUrl: string;
  apiPassword?: string;
  dbDir?: string;
  log?: (msg: string) => void;
}

export interface BootstrapResult {
  applied: string[];
  baselined: string[];
  functions: string[];
  ledger: { userid: number; problem: string; detail: string }[];
}

const sqlFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dbDir = resolve(opts.dbDir ?? process.env.DB_DIR ?? 'db');
  const db = new pg.Pool({ connectionString: opts.adminUrl, max: 2, application_name: 'cocos-bootstrap' });
  db.on('error', () => undefined);   // una conexión ociosa que se corta no tumba el proceso
  try {
    return await run(db, dbDir, opts, log);
  } finally {
    await db.end();
  }
}

async function run(db: pg.Pool, dbDir: string, opts: BootstrapOptions, log: (m: string) => void): Promise<BootstrapResult> {
  const result: BootstrapResult = { applied: [], baselined: [], functions: [], ledger: [] };
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

    // 1 a 4, en una transacción. La barrera exclusiva espera a las escrituras en curso y frena
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
        result.ledger = (await client.query('SELECT userid, problem, detail FROM app.verify_ledger()')).rows;
        for (const p of result.ledger) log(`  historia: usuario ${p.userid} — ${p.problem}: ${p.detail}`);
        // 'short' (D-01) y 'overflow' (historia fuera de los tipos, D-14) se toleran y se informan.
        const broken = result.ledger.filter((p) => p.problem !== 'short' && p.problem !== 'overflow');
        if (broken.length) throw new Error(`verificación de la historia falló para ${broken.length} usuario(s)`);
      }
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
