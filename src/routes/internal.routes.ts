// Endpoints de operación (D-28). Protegidos por X-Internal-Token; sin INTERNAL_TOKEN no existen.
import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError, badRequest, route } from '../http/errors.js';
import { EXECUTE_DEFAULTS, cleanupIdempotency, executeLimits, health } from '../repositories/ops.repo.js';

// Parámetros de POST /internal/execute-limits (query string). Un entero sin signo, una sola vez:
// `?max=1.5`, `?max=abc` y `?max=5&max=6` (llega como lista) responden 400, nunca 500.
const uint = (max: number, min = 1) =>
  z.string().regex(/^\d{1,15}$/, 'entero sin signo').transform(Number).pipe(z.number().min(min).max(max));
const ExecuteQuery = z.object({
  max: uint(10_000).default(String(EXECUTE_DEFAULTS.max)),
  after_id: z.string().regex(/^\d{1,18}$/, 'entero sin signo').default(EXECUTE_DEFAULTS.afterId),
  max_ms: uint(600_000).default(String(EXECUTE_DEFAULTS.maxMs)),
  per_user: uint(10_000).default(String(EXECUTE_DEFAULTS.perUser)),
}).strict();

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
    const parsed = ExecuteQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '));
    const q = parsed.data;
    res.json(await executeLimits({ max: q.max, afterId: q.after_id, maxMs: q.max_ms, perUser: q.per_user }));
  }));
  r.post('/internal/cleanup-idempotency', route(async (_req, res) => { res.json(await cleanupIdempotency()); }));
  return r;
}

// GET /health — lo usan el healthcheck de docker compose y el deploy en Fly (D-29): el check de
// las máquinas nuevas (bluegreen) y el workflow, que lee `release` antes y después de desplegar.
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
