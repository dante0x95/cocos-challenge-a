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

// SQLSTATE clase 22 (data_exception) al convertir un parámetro de la sentencia (issue #40, D-30):
// el valor que mandó la API no se puede representar en el tipo del parámetro (U+0000 en text →
// 22021, 'abc' en integer → 22P02, 3000000000 en integer → 22003). Postgres lo distingue en el
// contexto del error: "unnamed portal parameter $N" (o "portal "x" parameter $N"), y en ese momento
// todavía no ejecutó nada. El mismo código dentro de la sentencia (un overflow en una cuenta, una
// división por cero) no trae ese contexto y sigue siendo un 500: es un bug, no una entrada.
// `where` lista los contextos del más interno al más externo, uno por línea, y el de la conversión
// es el más externo: va al final, después de los del tipo (un jsonb inválido agrega antes
// "JSON data, line 1: …"). Si log_parameter_max_length_on_error > 0, lleva el valor entre comillas
// simples, con las del valor duplicadas, y el valor puede traer saltos de línea. Por eso se exige
// la línea al final del texto, con el valor completo y bien citado: un texto del cliente que imite
// el contexto en medio de otro no alcanza.
const PARAM_CONTEXT = /(?:^|\n)(?:unnamed portal|portal "[^"\n]*") parameter \$\d+(?: = '(?:[^']|'')*')?$/;

/** true si el error es un dato inválido en un parámetro de la sentencia, antes de ejecutarla. */
export function isParamDataException(err: unknown): boolean {
  const e = err as { code?: unknown; where?: unknown };
  return typeof e.code === 'string' && e.code.startsWith('22') && typeof e.where === 'string' && PARAM_CONTEXT.test(e.where);
}

export const PARAM_DATA_MESSAGE = 'el request tiene un valor que la base no admite';

// El 500 es un bug. Solo POST /orders tiene Idempotency-Key: ahí el resultado es desconocido y se
// reintenta con la misma clave (D-20). En las demás rutas mencionar la clave confunde (issue #40):
// una lectura no tiene efecto, y cancelar o correr el executor se pueden repetir sin clave.
export const INTERNAL_MESSAGE_ORDERS = 'error interno; el resultado es desconocido: reintentar con la misma Idempotency-Key';
export const INTERNAL_MESSAGE = 'error interno; reintentar';

/**
 * Traduce un error de la base (o del driver) a HTTP. `usesIdempotencyKey`: la ruta es POST /orders,
 * la única con Idempotency-Key; solo cambia el mensaje del 500.
 */
export function fromDbError(err: unknown, usesIdempotencyKey = true): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? 'error';
  // pg-pool no les pone código: no hubo conexión libre (o no se pudo abrir una) dentro de
  // PG_CONNECT_TIMEOUT_MS. No llegó a ejecutarse ninguna sentencia (D-20).
  if (!e.code && POOL_TIMEOUTS.has(msg)) {
    return new HttpError(503, 'TIMEOUT', 'no hubo una conexión libre con la base a tiempo; reintentar (en POST /orders, con la misma Idempotency-Key)', 1);
  }
  // query_timeout del driver (issue #11): la respuesta no llegó en el plazo local. La base pudo
  // haber ejecutado la sentencia: resultado desconocido (D-20). La conexión se descarta.
  if (!e.code && msg === 'Query read timeout') {
    return new HttpError(503, 'TIMEOUT', 'la base no respondió a tiempo; el resultado es desconocido: reintentar con la misma Idempotency-Key', 1);
  }
  if (connectionLostPhase(err)) return new HttpError(503, 'CONNECTION_LOST', CONNECTION_LOST_MESSAGE, 1);
  if (isParamDataException(err)) return badRequest(PARAM_DATA_MESSAGE);
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
    // Un bug. En POST /orders el resultado también es desconocido: la misma guía que un 503. En las
    // demás rutas, reintentar sin nombrar una clave que no usan (D-30).
    default:      return new HttpError(500, 'INTERNAL', usesIdempotencyKey ? INTERNAL_MESSAGE_ORDERS : INTERNAL_MESSAGE);
  }
}

/** Envuelve un handler async: cualquier excepción va al middleware de errores. */
export const route =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

// Errores 4xx de Express y de body-parser (traen `status`): la entrada del cliente es inválida, no
// es un bug. Un parámetro de ruta mal codificado (`/portfolio/%FF`) o un charset no soportado
// respondían 500 (issue #40).
const REQUEST_ERROR_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'JSON inválido',
  'entity.too.large': 'body demasiado grande',
  'charset.unsupported': 'charset no soportado: enviar el body en utf-8',
  'encoding.unsupported': 'Content-Encoding no soportado',
};

function requestError(err: unknown): HttpError | null {
  if (err instanceof HttpError) return null;
  const e = err as { status?: unknown; type?: unknown };
  if (typeof e.status !== 'number' || e.status < 400 || e.status > 499) return null;
  const message = err instanceof URIError
    ? 'la ruta tiene un parámetro mal codificado'
    : REQUEST_ERROR_MESSAGES[String(e.type)] ?? 'request inválido';
  return new HttpError(e.status, 'BAD_REQUEST', message);
}

/** Middleware final: un solo lugar decide status, body y Retry-After. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // req.route es la ruta que atendió el request (no la URL, que admite mayúsculas y barra final).
  const usesIdempotencyKey = req.method === 'POST' && req.route?.path === '/orders';
  const e = requestError(err) ?? fromDbError(err, usesIdempotencyKey);
  const phase = connectionLostPhase(err);
  if (phase) {
    // Un reinicio de la base corta una conexión por request en vuelo: una línea de aviso cada una,
    // sin stack (no es un bug), con la fase para distinguir "no se pudo conectar" de "se cortó a
    // mitad de una escritura".
    console.warn(JSON.stringify({ level: 'warn', requestId: res.locals.requestId, path: req.path, code: e.code, phase, err: String((err as Error)?.message ?? err) }));
  } else if (isParamDataException(err)) {
    // Una entrada que la validación de la API dejó pasar: 400 para el cliente, pero a la vista en
    // el log con el SQLSTATE, para agregar la regla en la frontera (D-30).
    const sqlstate = (err as { code: string }).code;
    console.warn(JSON.stringify({ level: 'warn', requestId: res.locals.requestId, path: req.path, code: e.code, sqlstate, err: String((err as Error)?.message ?? err) }));
  } else if (e.status >= 500) {
    console.error(JSON.stringify({ level: 'error', requestId: res.locals.requestId, path: req.path, err: String((err as Error)?.stack ?? err) }));
  }
  if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
  res.status(e.status).json({ error: e.code, message: e.message, ...(e.details ?? {}) });
}
