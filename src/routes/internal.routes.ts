// Endpoints de operación (D-28). Protegidos por X-Internal-Token; sin INTERNAL_TOKEN no existen.
import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError, badRequest, route } from '../http/errors.js';
import { EXECUTE_DEFAULTS, cleanupIdempotency, executeLimits, health } from '../repositories/ops.repo.js';

// Parámetros de POST /internal/execute-limits (query string). Un entero sin signo, una sola vez:
// `?max=1.5`, `?max=abc`, `?max=5&max=6` y un parámetro desconocido responden 400, nunca 500.
const once = { invalid_type_error: 'un solo valor por parámetro' };
const uint = (max: number, min = 1) =>
  z.string(once).regex(/^\d{1,15}$/, 'entero sin signo').transform(Number)
    .pipe(z.number().min(min, `mínimo ${min}`).max(max, `máximo ${max}`));
const ExecuteQuery = z.object({
  max: uint(10_000).default(String(EXECUTE_DEFAULTS.max)),
  after_id: z.string(once).regex(/^\d{1,18}$/, 'entero sin signo').default(EXECUTE_DEFAULTS.afterId),
  max_ms: uint(600_000).default(String(EXECUTE_DEFAULTS.maxMs)),
  per_user: uint(10_000).default(String(EXECUTE_DEFAULTS.perUser)),
}).strict();

/**
 * La query completa, con cada parámetro repetido como lista. Se lee de la URL y no de req.query:
 * el parser de Express corta en 1000 parámetros y escondería una repetición o un parámetro
 * desconocido que vengan después (como en GET /orders/:id).
 */
function fullQuery(originalUrl: string): Record<string, string | string[]> {
  const q: Record<string, string | string[]> = {};
  for (const [k, v] of new URL(originalUrl, 'http://localhost').searchParams) {
    const prev = q[k];
    q[k] = prev === undefined ? v : [...(Array.isArray(prev) ? prev : [prev]), v];
  }
  return q;
}

export function internalRouter(token: string | undefined): Router {
  const r = Router();
  r.use('/internal', (req: Request, _res: Response, next: NextFunction) => {
    if (!token) return next(new HttpError(404, 'NOT_FOUND', 'ruta inexistente'));
    const given = Buffer.from(req.header('X-Internal-Token') ?? '');
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return next(new HttpError(401, 'UNAUTHORIZED', 'X-Internal-Token inválido'));
    }
    next();
  });
  r.post('/internal/execute-limits', route(async (req, res) => {
    const parsed = ExecuteQuery.safeParse(fullQuery(req.originalUrl));
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => (i.code === 'unrecognized_keys'
        ? `parámetro desconocido: ${i.keys.join(', ')}`
        : `${i.path.join('.')}: ${i.message}`)).join('; '));
    }
    const q = parsed.data;
    res.json(await executeLimits({ max: q.max, afterId: q.after_id, maxMs: q.max_ms, perUser: q.per_user }));
  }));
  r.post('/internal/cleanup-idempotency', route(async (_req, res) => { res.json(await cleanupIdempotency()); }));
  return r;
}

// GET /health — lo usan el healthcheck de docker compose (también el del servidor, que da por
// buena la API nueva) y el workflow de deploy (D-29), que exige `release` igual al commit desplegado.
// `release` es el commit desplegado (RELEASE); va también en el 503, para saber qué atiende.
export function healthRouter(release: string | undefined): Router {
  const r = Router();
  r.get('/health', route(async (_req, res) => {
    try {
      const h = await health();
      res.json({ ok: true, db: 'up', release: release ?? null, ...h });
    } catch {
      res.status(503).json({ ok: false, db: 'down', release: release ?? null });
    }
  }));
  return r;
}
