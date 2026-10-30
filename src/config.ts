// Configuración tipada desde el entorno. Falla al arrancar si algo es inválido, no en el
// primer request.
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().url().default('postgresql://api:api@localhost:5432/cocos'),
  PORT: z.coerce.number().int().positive().default(3000),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Espera máxima por una conexión libre del pool; al vencer, 503 TIMEOUT (D-20).
  PG_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  // Plazo local de cada consulta en el driver, por encima del statement_timeout de 5 s de la base:
  // solo actúa cuando la respuesta no puede llegar (D-20, issue #11).
  PG_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(7000),
  INTERNAL_TOKEN: z.string().min(1).optional(),
  // Commit desplegado: lo fija el deploy (D-29) y GET /health lo devuelve como `release`.
  RELEASE: z.string().min(1).optional(),
  JOBS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CLEANUP_EVERY_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`configuración inválida: ${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
