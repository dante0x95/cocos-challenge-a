// Traducción de errores de la base a HTTP (src/http/errors.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectionLostPhase, errorHandler, fromDbError } from '../../src/http/errors.js';

// El contrato con el cliente, escrito acá y no importado del código: dice que el resultado es
// desconocido y cómo resolverlo (D-20). Nunca que la orden no se grabó.
const CONNECTION_LOST_MESSAGE = 'la conexión con la base se cortó; el resultado es desconocido: reintentar con la misma Idempotency-Key';
const QUERY_TIMEOUT_MESSAGE = 'la base no respondió a tiempo; el resultado es desconocido: reintentar con la misma Idempotency-Key';
const INTERNAL_MESSAGE = 'error interno; el resultado es desconocido: reintentar con la misma Idempotency-Key';

describe('fromDbError: tiempos de conexión del pool (D-20)', () => {
  // pg-pool 3.x no les pone código: se reconocen por el mensaje.
  it.each([
    ['espera por una conexión libre', 'timeout exceeded when trying to connect'],
    ['apertura de una conexión nueva', 'Connection terminated due to connection timeout'],
  ])('%s → 503 TIMEOUT con Retry-After 1', (_name, message) => {
    const e = fromDbError(new Error(message));
    expect({ status: e.status, code: e.code, retryAfter: e.retryAfter }).toEqual({ status: 503, code: 'TIMEOUT', retryAfter: 1 });
  });

  it('"Query read timeout" (plazo local del driver, issue #11) → 503 TIMEOUT con la guía de resultado desconocido', () => {
    const e = fromDbError(new Error('Query read timeout'));
    expect({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter })
      .toEqual({ status: 503, code: 'TIMEOUT', message: QUERY_TIMEOUT_MESSAGE, retryAfter: 1 });
  });

  it('"Query read timeout" con un código de Postgres no es el plazo local', () => {
    expect(fromDbError(Object.assign(new Error('Query read timeout'), { code: 'XX000' })).code).toBe('INTERNAL');
  });

  it('el mismo mensaje con un código de Postgres no se toma como timeout del pool', () => {
    expect(fromDbError(Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'XX000' })).status).toBe(500);
  });
});

// Durante un deploy (D-24, issue #13): un escritor que siguió con el cuerpo anterior de una
// función y choca con el esquema nuevo falla con APP04, y uno que espera la barrera más que el
// lock_timeout, con 55P03. Los dos son reintentables con la misma clave: 503 con Retry-After, no 500.
describe('fromDbError: errores de un deploy en curso', () => {
  it.each([
    ['APP04', 'VERSION_MISMATCH'],
    ['55P03', 'LOCK_TIMEOUT'],
  ])('%s → 503 %s con Retry-After 1', (code, expected) => {
    const e = fromDbError(Object.assign(new Error('x'), { code }));
    expect({ status: e.status, code: e.code, retryAfter: e.retryAfter }).toEqual({ status: 503, code: expected, retryAfter: 1 });
  });
});

// Un estado de los datos que el bootstrap ya conoce ('overflow' en verify_ledger, issue #57): ni
// un bug (500) ni algo que se resuelva reintentando (503). Sin Retry-After, y el mensaje de la base
// tal cual, en todas las rutas.
describe('fromDbError: historia fuera de los tipos (APP07)', () => {
  it.each([true, false])('APP07 → 409 HISTORY_OVERFLOW sin Retry-After (usesIdempotencyKey = %s)', (usesKey) => {
    const msg = 'la historia del usuario 7 supera los tipos del cálculo (D-14): no puede operar hasta que se corrija; no reintentar';
    const e = fromDbError(Object.assign(new Error(msg), { code: 'APP07' }), usesKey);
    expect({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter })
      .toEqual({ status: 409, code: 'HISTORY_OVERFLOW', message: msg, retryAfter: undefined });
  });

  it('el middleware no lo deja como error en el log: no es un bug', () => {
    const r = handle(Object.assign(new Error('x'), { code: 'APP07' }), { method: 'GET', path: '/portfolio/7' });
    expect(r.status).toBe(409);
    expect(r.logs.error).toEqual([]);
  });
});

describe('fromDbError: cortes de conexión (issue #7)', () => {
  const lost = { status: 503, code: 'CONNECTION_LOST', retryAfter: 1 };
  // Toda la clase 08 de SQLSTATE (connection_exception) y los códigos de corte de la clase 57.
  it.each([
    ['57P01', 'terminating connection due to administrator command', 'query'],
    ['57P02', 'terminating connection because of crash of another server process', 'query'],
    ['57P03', 'the database system is starting up', 'connect'],
    ['08000', 'connection exception', 'query'],
    ['08001', 'sqlclient unable to establish sqlconnection', 'connect'],
    ['08003', 'connection does not exist', 'query'],
    ['08004', 'sqlserver rejected establishment of sqlconnection', 'connect'],
    ['08006', 'connection failure', 'query'],
    ['08007', 'transaction resolution unknown', 'query'],
    ['08P01', 'protocol violation', 'query'],
  ])('SQLSTATE %s → 503 CONNECTION_LOST con Retry-After 1 (fase %s)', (code, message, phase) => {
    const err = Object.assign(new Error(message), { code });
    const e = fromDbError(err);
    expect({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter }).toEqual({ ...lost, message: CONNECTION_LOST_MESSAGE });
    expect(connectionLostPhase(err)).toBe(phase);
  });

  // Errores de socket de Node: la fase sale de la llamada que falló (syscall), no solo del código.
  it.each([
    ['ECONNRESET', 'read', 'read ECONNRESET', 'query'],
    ['EPIPE', 'write', 'write EPIPE', 'query'],
    ['ETIMEDOUT', 'read', 'read ETIMEDOUT', 'query'],
    ['ETIMEDOUT', 'connect', 'connect ETIMEDOUT 10.0.0.1:5432', 'connect'],
    ['ECONNRESET', 'connect', 'connect ECONNRESET 127.0.0.1:5432', 'connect'],
    ['ECONNREFUSED', 'connect', 'connect ECONNREFUSED 127.0.0.1:5432', 'connect'],
    ['EHOSTUNREACH', 'connect', 'connect EHOSTUNREACH 10.0.0.1:5432', 'connect'],
    ['ENETUNREACH', 'connect', 'connect ENETUNREACH 10.0.0.1:5432', 'connect'],
    ['ENOTFOUND', 'getaddrinfo', 'getaddrinfo ENOTFOUND db', 'connect'],
    ['ETIMEDOUT', undefined, 'ETIMEDOUT', 'query'],
  ])('%s (syscall %s) → 503 CONNECTION_LOST con Retry-After 1', (code, syscall, message, phase) => {
    const err = Object.assign(new Error(message), { code, syscall });
    const e = fromDbError(err);
    expect({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter }).toEqual({ ...lost, message: CONNECTION_LOST_MESSAGE });
    expect(connectionLostPhase(err)).toBe(phase);
  });

  it('un código fuera de la clase 08 y de la lista no es un corte', () => {
    for (const code of ['09000', '57014', '57P04', 'ECANCELED']) {
      expect(connectionLostPhase(Object.assign(new Error('x'), { code })), code).toBeNull();
    }
  });

  it.each([
    'Connection terminated unexpectedly',
    'Client has encountered a connection error and is not queryable',
  ])('mensaje del driver sin código "%s" → 503 CONNECTION_LOST (fase query)', (message) => {
    const e = fromDbError(new Error(message));
    expect({ status: e.status, code: e.code, retryAfter: e.retryAfter }).toEqual(lost);
    expect(connectionLostPhase(new Error(message))).toBe('query');
  });

  it('un error cualquiera sigue siendo 500 INTERNAL, pero con la misma guía para el cliente', () => {
    const e = fromDbError(Object.assign(new Error('division by zero'), { code: '22012' }));
    expect({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter })
      .toEqual({ status: 500, code: 'INTERNAL', message: INTERNAL_MESSAGE, retryAfter: undefined });
    expect(connectionLostPhase(new Error('division by zero'))).toBeNull();
  });

  it('el middleware loguea un corte como warn con la fase y sin stack; un 500, como error con stack', () => {
    const logs: { warn: string[]; error: string[] } = { warn: [], error: [] };
    const origWarn = console.warn; const origErr = console.error;
    console.warn = (m: string) => { logs.warn.push(String(m)); };
    console.error = (m: string) => { logs.error.push(String(m)); };
    try {
      const res = () => {
        const r = { locals: { requestId: 'rid' }, headers: {} as Record<string, string>, statusCode: 0, body: undefined as unknown,
          set(k: string, v: string) { this.headers[k] = v; }, status(s: number) { this.statusCode = s; return this; }, json(b: unknown) { this.body = b; } };
        return r;
      };
      const r1 = res();
      errorHandler(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), { path: '/orders' } as never, r1 as never, () => undefined);
      expect(r1.statusCode).toBe(503);
      expect(r1.headers['Retry-After']).toBe('1');
      expect(JSON.parse(logs.warn[0])).toMatchObject({ level: 'warn', requestId: 'rid', path: '/orders', code: 'CONNECTION_LOST', phase: 'query' });
      expect(logs.warn[0]).not.toContain('    at ');
      const r3 = res();
      errorHandler(Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:5432'), { code: 'ETIMEDOUT', syscall: 'connect' }), { path: '/orders' } as never, r3 as never, () => undefined);
      expect(r3.statusCode).toBe(503);
      expect(r3.headers['Retry-After']).toBe('1');
      expect(JSON.parse(logs.warn[1])).toMatchObject({ level: 'warn', code: 'CONNECTION_LOST', phase: 'connect' });
      expect(logs.error).toEqual([]);
      const r2 = res();
      errorHandler(new Error('boom'), { method: 'POST', path: '/orders', route: { path: '/orders' } } as never, r2 as never, () => undefined);
      expect(r2.statusCode).toBe(500);
      expect(r2.body).toEqual({ error: 'INTERNAL', message: INTERNAL_MESSAGE });
      expect(JSON.parse(logs.error[0])).toMatchObject({ level: 'error', requestId: 'rid' });
      expect(logs.error[0]).toContain('    at ');
    } finally { console.warn = origWarn; console.error = origErr; }
  });
});

// Issue #40: lo que el cliente manda no produce un 500. Fixtures del middleware de errores.
function fakeRes() {
  return { locals: { requestId: 'rid' }, headers: {} as Record<string, string>, statusCode: 0, body: undefined as unknown,
    set(k: string, v: string) { this.headers[k] = v; }, status(s: number) { this.statusCode = s; return this; }, json(b: unknown) { this.body = b; } };
}
function handle(err: unknown, req: Record<string, unknown>) {
  const logs: { warn: string[]; error: string[] } = { warn: [], error: [] };
  const origWarn = console.warn; const origErr = console.error;
  console.warn = (m: string) => { logs.warn.push(String(m)); };
  console.error = (m: string) => { logs.error.push(String(m)); };
  try {
    const r = fakeRes();
    errorHandler(err, { path: '/x', ...req } as never, r as never, () => undefined);
    return { status: r.statusCode, body: r.body as Record<string, unknown>, logs };
  } finally { console.warn = origWarn; console.error = origErr; }
}

describe('fromDbError: la clase 22 al convertir un parámetro → 400 (issue #40, D-30)', () => {
  const PARAM_DATA_MESSAGE = 'el request tiene un valor que la base no admite';
  // Postgres pone ese contexto cuando falla la conversión de un parámetro, antes de ejecutar nada
  // (test/property/inputs lo verifica contra Postgres 18). Con log_parameter_max_length_on_error
  // el valor va al final ("= '...'").
  const PARAM_WHERES = [
    'unnamed portal parameter $1', "unnamed portal parameter $8 = '...'", 'portal "p1" parameter $2',
    // Un jsonb inválido: el contexto del tipo va antes, el de la conversión al final (CR-1).
    'JSON data, line 1: {"a":\nunnamed portal parameter $1 = \'...\'',
    'JSON data, line 3: "\\u0000...\nunnamed portal parameter $2',
    // Con log_parameter_max_length_on_error: el valor, con saltos de línea y comillas duplicadas.
    "unnamed portal parameter $1 = '1\n2'''",
    "JSON data, line 1: {\"a\":\"x\nunnamed portal parameter $1 = '{\"a\":\"x\nunnamed portal parameter $9'",
  ];
  // Los que puede dar la conversión de un valor de texto: U+0000 o bytes inválidos (22021), un
  // carácter sin equivalente (22P05), sintaxis del tipo (22P02), rango (22003), largo (22001),
  // fechas (22007, 22008), y la clase genérica.
  const CODES = ['22021', '22P05', '22P02', '22003', '22001', '22007', '22008', '22000'];

  it.each(CODES.flatMap((code) => PARAM_WHERES.map((where) => [code, where])))('%s en "%s" → 400 BAD_REQUEST', (code, where) => {
    const e = fromDbError(Object.assign(new Error('x'), { code, where }));
    expect({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter })
      .toEqual({ status: 400, code: 'BAD_REQUEST', message: PARAM_DATA_MESSAGE, retryAfter: undefined });
  });

  // Dentro de la sentencia, el mismo código es un bug: un overflow en una cuenta, una división por
  // cero o un cast de un dato guardado. Sigue siendo 500.
  it.each([
    ['22003', undefined],
    ['22012', undefined],
    ['22P02', 'PL/pgSQL function app.place_order(integer,text) line 12 at assignment'],
    ['22003', "SQL statement \"SELECT 1\"\nPL/pgSQL function app.c_state(integer) line 4 at SQL statement"],
    ['22021', 'JSON data, line 1: {"a":"\\u0000...'],
    // El contexto de un parámetro con otro más externo después: no es el error de la conversión.
    ['22003', 'unnamed portal parameter $1\nPL/pgSQL function app.x() line 1'],
    // Texto del cliente que imita el contexto dentro de otro, sin la cita completa del valor.
    ['22P02', "JSON data, line 1: {\"a\":\"x\nunnamed portal parameter $9 = 'y"],
    ['22P02', "JSON data, line 1: {\"a\":\"x\nunnamed portal parameter $9 = 'y' z'"],
    ['22P02', 'JSON data, line 1: {"a":"unnamed portal parameter $1'],
  ])('%s con contexto %j → 500 INTERNAL', (code, where) => {
    const e = fromDbError(Object.assign(new Error('x'), { code, where }));
    expect({ status: e.status, code: e.code }).toEqual({ status: 500, code: 'INTERNAL' });
  });

  it('otra clase con el contexto de un parámetro sigue siendo 500', () => {
    for (const code of ['42804', '23505', 'XX000']) {
      expect(fromDbError(Object.assign(new Error('x'), { code, where: 'unnamed portal parameter $1' })).status, code).toBe(500);
    }
  });

  it('el middleware responde 400 y lo deja en el log como warn con el SQLSTATE, sin stack: es una regla que falta en la frontera', () => {
    const r = handle(Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021', where: 'unnamed portal parameter $1' }),
      { method: 'GET', path: '/instruments' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'BAD_REQUEST', message: PARAM_DATA_MESSAGE });
    expect(r.logs.error).toEqual([]);
    expect(JSON.parse(r.logs.warn[0])).toMatchObject({ level: 'warn', requestId: 'rid', path: '/instruments', code: 'BAD_REQUEST', sqlstate: '22021' });
    expect(r.logs.warn[0]).not.toContain('    at ');
  });
});

describe('el 500 menciona Idempotency-Key solo en POST /orders (issue #40)', () => {
  const INTERNAL_MESSAGE_OTHER = 'error interno; reintentar';

  it('POST /orders: resultado desconocido, reintentar con la misma clave', () => {
    const r = handle(new Error('boom'), { method: 'POST', path: '/orders', route: { path: '/orders' } });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'INTERNAL', message: INTERNAL_MESSAGE });
  });

  it.each([
    ['GET', '/instruments', '/instruments'],
    ['GET', '/orders/1', '/orders/:id'],
    ['GET', '/portfolio/1', '/portfolio/:userid'],
    ['POST', '/orders/1/cancel', '/orders/:id/cancel'],
    ['POST', '/internal/execute-limits', '/internal/execute-limits'],
  ])('%s %s: un 500 no menciona Idempotency-Key', (method, path, route) => {
    const r = handle(new Error('boom'), { method, path, route: { path: route } });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'INTERNAL', message: INTERNAL_MESSAGE_OTHER });
    expect(JSON.stringify(r.body)).not.toContain('Idempotency-Key');
    expect(JSON.parse(r.logs.error[0])).toMatchObject({ level: 'error', path });
  });

  it('un 500 sin ruta (antes del router) tampoco la menciona', () => {
    expect(handle(new Error('boom'), { method: 'POST', path: '/orders' }).body).toEqual({ error: 'INTERNAL', message: INTERNAL_MESSAGE_OTHER });
  });
});

describe('errores 4xx de Express y body-parser → 4xx, no 500 (issue #40)', () => {
  it.each([
    // Express, al decodificar un parámetro de ruta: /portfolio/%FF.
    ['parámetro de ruta mal codificado', Object.assign(new URIError("Failed to decode param '%FF'"), { status: 400, statusCode: 400 }), 400, 'la ruta tiene un parámetro mal codificado'],
    ['JSON inválido', Object.assign(new Error('x'), { status: 400, type: 'entity.parse.failed' }), 400, 'JSON inválido'],
    ['body demasiado grande', Object.assign(new Error('x'), { status: 413, type: 'entity.too.large' }), 413, 'body demasiado grande'],
    ['charset no soportado', Object.assign(new Error('x'), { status: 415, type: 'charset.unsupported' }), 415, 'charset no soportado: enviar el body en utf-8'],
    ['Content-Encoding no soportado', Object.assign(new Error('x'), { status: 415, type: 'encoding.unsupported' }), 415, 'Content-Encoding no soportado'],
    ['otro 4xx de body-parser', Object.assign(new Error('x'), { status: 400, type: 'request.size.invalid' }), 400, 'request inválido'],
  ])('%s → %s', (_name, err, status, message) => {
    const r = handle(err, { method: 'POST', path: '/orders' });
    expect({ status: r.status, body: r.body }).toEqual({ status, body: { error: 'BAD_REQUEST', message } });
    expect(r.logs.error).toEqual([]);
  });

  it('un status 5xx de body-parser sigue siendo un 500', () => {
    expect(handle(Object.assign(new Error('x'), { status: 500, type: 'stream.encoding.set' }), { method: 'GET' }).status).toBe(500);
  });
});

describe('docs/api/orders.md documenta la recuperación', () => {
  it('la tabla de errores tiene 500 INTERNAL y 503 CONNECTION_LOST con "reintentar con la misma clave", y la regla general', () => {
    const md = readFileSync(resolve(import.meta.dirname, '../../docs/api/orders.md'), 'utf8');
    // La última columna (¿se grabó?) de cada fila dice resultado desconocido, no "no".
    expect(md).toMatch(/^\| `503` \| `CONNECTION_LOST` \| [^|]+ \| resultado desconocido: \*\*reintentar con la misma clave\*\* \|$/m);
    expect(md).toMatch(/^\| `500` \| `INTERNAL` \| [^|]+ \| resultado desconocido: \*\*reintentar con la misma clave\*\* \|$/m);
    expect(md).toMatch(/\*\*Regla general\.\*\* Cualquier `5xx`, y cualquier request que se quedó sin respuesta [^.]*, es \*\*resultado desconocido\*\*: la orden pudo grabarse\. Se reintenta con la \*\*misma\*\* `Idempotency-Key`, nunca con una nueva/);
  });
});
