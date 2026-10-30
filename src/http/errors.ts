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

// La conexión con la base se cortó (issue #7). Antes de enviar la sentencia (connect) se sabe que
// no se ejecutó nada; después (query), el resultado es desconocido: la sentencia pudo confirmarse
// y la respuesta perderse. Para el cliente es lo mismo: 503 y reintentar con la misma clave; el
// replay devuelve la orden si existe (D-20). La fase va al log, no al cliente.
// Toda la clase SQLSTATE 08 (connection_exception) es un corte; 08001 y 08004 son de apertura.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', '57P03', '08001', '08004']);
const QUERY_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02']);
const QUERY_MESSAGES = ['Connection terminated unexpectedly', 'Client has encountered a connection error and is not queryable', 'Connection terminated'];
// Un error de socket de Node dice qué llamada falló: abrir el socket o resolver el nombre es antes
// de enviar nada, aunque el código (ETIMEDOUT, ECONNRESET) también pueda darse con la conexión abierta.
const CONNECT_SYSCALLS = new Set(['connect', 'getaddrinfo']);

/** 'connect' | 'query' si el error es un corte de conexión con la base; null si no lo es. */
export function connectionLostPhase(err: unknown): 'connect' | 'query' | null {
  const e = err as { code?: unknown; message?: string; syscall?: unknown };
  if (e.code) {
    const code = String(e.code);
    if (!CONNECT_CODES.has(code) && !QUERY_CODES.has(code) && !code.startsWith('08')) return null;
    return CONNECT_CODES.has(code) || CONNECT_SYSCALLS.has(String(e.syscall)) ? 'connect' : 'query';
  }
  if (e.message && QUERY_MESSAGES.some((m) => e.message!.startsWith(m))) return 'query';
  return null;
}

export const CONNECTION_LOST_MESSAGE = 'la conexión con la base se cortó; el resultado es desconocido: reintentar con la misma Idempotency-Key';

export function fromDbError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? 'error';
  // pg-pool no les pone código: no hubo conexión libre (o no se pudo abrir una) dentro de
  // PG_CONNECT_TIMEOUT_MS. No llegó a ejecutarse ninguna sentencia (D-20).
  if (!e.code && POOL_TIMEOUTS.has(msg)) {
    return new HttpError(503, 'TIMEOUT', 'no hubo una conexión libre con la base a tiempo; reintentar (en POST /orders, con la misma Idempotency-Key)', 1);
  }
  if (connectionLostPhase(err)) return new HttpError(503, 'CONNECTION_LOST', CONNECTION_LOST_MESSAGE, 1);
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
    // Un bug. Para el cliente, el resultado también es desconocido: la misma guía que un 503.
    default:      return new HttpError(500, 'INTERNAL', 'error interno; el resultado es desconocido: reintentar con la misma Idempotency-Key');
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
  const phase = connectionLostPhase(err);
  if (phase) {
    // Un reinicio de la base corta una conexión por request en vuelo: una línea de aviso cada una,
    // sin stack (no es un bug), con la fase para distinguir "no se pudo conectar" de "se cortó a
    // mitad de una escritura".
    console.warn(JSON.stringify({ level: 'warn', requestId: res.locals.requestId, path: req.path, code: e.code, phase, err: String((err as Error)?.message ?? err) }));
  } else if (e.status >= 500) {
    console.error(JSON.stringify({ level: 'error', requestId: res.locals.requestId, path: req.path, err: String((err as Error)?.stack ?? err) }));
  }
  if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
  res.status(e.status).json({ error: e.code, message: e.message, ...(e.details ?? {}) });
}
