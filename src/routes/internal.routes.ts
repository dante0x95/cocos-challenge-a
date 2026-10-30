// Endpoints de operación (D-28). Protegidos por X-Internal-Token; sin INTERNAL_TOKEN no existen.
import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { HttpError, route } from '../http/errors.js';
import { cleanupIdempotency, executeLimits, health } from '../repositories/ops.repo.js';

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
  r.post('/internal/execute-limits', route(async (_req, res) => { res.json(await executeLimits()); }));
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
