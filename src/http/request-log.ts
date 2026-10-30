// Request id y una línea de log JSON por request (método, ruta, status, duración).
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const id = req.header('X-Request-Id') || randomUUID();
  res.locals.requestId = id;
  res.set('X-Request-Id', id);
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (process.env.LOG_REQUESTS === 'false') return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(JSON.stringify({ level: 'info', requestId: id, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(ms * 10) / 10 }));
  });
  next();
}
