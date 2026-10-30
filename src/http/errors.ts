// Errores HTTP de la API y traducción de errores de Postgres.
// Los códigos APPxx los levantan las funciones de db/functions (lista en 010_core.sql).
import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, 'BAD_REQUEST', message);
export const notFound = (message: string) => new HttpError(404, 'NOT_FOUND', message);

const POOL_TIMEOUTS = new Set(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']);

export function fromDbError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? 'error';
  // pg-pool no les pone código: no hubo conexión libre (o no se pudo abrir una) dentro de
  // PG_CONNECT_TIMEOUT_MS. No llegó a ejecutarse ninguna sentencia (D-20).
  if (!e.code && POOL_TIMEOUTS.has(msg)) {
    return new HttpError(503, 'TIMEOUT', 'no hubo una conexión libre con la base a tiempo; reintentar (en POST /orders, con la misma Idempotency-Key)', 1);
  }
  switch (e.code) {
    case 'APP01': return new HttpError(422, 'NO_PRICE', msg);
    case 'APP02': return new HttpError(400, 'BAD_REQUEST', msg);
    case 'APP03': return new HttpError(422, 'IDEMPOTENCY_MISMATCH', msg);
    case 'APP04': return new HttpError(503, 'VERSION_MISMATCH', msg, 1);
    case 'APP05': return new HttpError(422, 'LIMIT', msg);
    case 'APP06': return notFound(msg);
    case '55P03': return new HttpError(503, 'LOCK_TIMEOUT', 'el usuario tiene otra operación en curso; reintentar con la misma Idempotency-Key', 1);
    case '57014': return new HttpError(503, 'TIMEOUT', 'la operación superó el tiempo máximo; reintentar con la misma Idempotency-Key', 1);
    case '40P01': return new HttpError(503, 'DEADLOCK', 'deadlock (no debería ocurrir: reportar)', 1);
    default:      return new HttpError(500, 'INTERNAL', 'error interno');
  }
}

/** Envuelve un handler async: cualquier excepción va al middleware de errores. */
export const route =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** Middleware final: un solo lugar decide status, body y Retry-After. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // JSON inválido (body-parser) o body demasiado grande.
  const parse = err as { type?: string; status?: number };
  const e = parse.type === 'entity.parse.failed' || parse.type === 'entity.too.large'
    ? new HttpError(parse.status ?? 400, 'BAD_REQUEST', parse.type === 'entity.too.large' ? 'body demasiado grande' : 'JSON inválido')
    : fromDbError(err);
  if (e.status >= 500) {
    console.error(JSON.stringify({ level: 'error', requestId: res.locals.requestId, path: req.path, err: String((err as Error)?.stack ?? err) }));
  }
  if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
  res.status(e.status).json({ error: e.code, message: e.message, ...(e.details ?? {}) });
}
