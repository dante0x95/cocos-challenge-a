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

export const healthRouter = Router();

// GET /health — lo usa el healthcheck de docker compose.
healthRouter.get('/health', route(async (_req, res) => {
  try {
    const h = await health();
    res.json({ ok: true, db: 'up', ...h });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
}));
