// Traducción de errores de la base a HTTP (src/http/errors.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectionLostPhase, errorHandler, fromDbError } from '../../src/http/errors.js';

// El contrato con el cliente, escrito acá y no importado del código: dice que el resultado es
// desconocido y cómo resolverlo (D-20). Nunca que la orden no se grabó.
const CONNECTION_LOST_MESSAGE = 'la conexión con la base se cortó; el resultado es desconocido: reintentar con la misma Idempotency-Key';

describe('fromDbError: tiempos de conexión del pool (D-20)', () => {
  // pg-pool 3.x no les pone código: se reconocen por el mensaje.
  it.each([
    ['espera por una conexión libre', 'timeout exceeded when trying to connect'],
    ['apertura de una conexión nueva', 'Connection terminated due to connection timeout'],
  ])('%s → 503 TIMEOUT con Retry-After 1', (_name, message) => {
    const e = fromDbError(new Error(message));
    expect({ status: e.status, code: e.code, retryAfter: e.retryAfter }).toEqual({ status: 503, code: 'TIMEOUT', retryAfter: 1 });
  });

  it('el mismo mensaje con un código de Postgres no se toma como timeout del pool', () => {
    expect(fromDbError(Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'XX000' })).status).toBe(500);
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
    expect({ status: e.status, code: e.code }).toEqual({ status: 500, code: 'INTERNAL' });
    expect(e.message).toMatch(/misma Idempotency-Key/);
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
      errorHandler(new Error('boom'), { path: '/orders' } as never, r2 as never, () => undefined);
      expect(r2.statusCode).toBe(500);
      expect(JSON.parse(logs.error[0])).toMatchObject({ level: 'error', requestId: 'rid' });
      expect(logs.error[0]).toContain('    at ');
    } finally { console.warn = origWarn; console.error = origErr; }
  });
});

describe('docs/api/orders.md documenta la recuperación', () => {
  it('la tabla de errores tiene 500 INTERNAL y 503 CONNECTION_LOST con "reintentar con la misma clave", y la regla general', () => {
    const md = readFileSync(resolve(import.meta.dirname, '../../docs/api/orders.md'), 'utf8');
    expect(md).toMatch(/\| `503` \| `CONNECTION_LOST` \|.*reintentar con la misma clave/);
    expect(md).toMatch(/\| `500` \| `INTERNAL` \|.*reintentar con la misma clave/);
    expect(md).toMatch(/\*\*Regla general\.\*\* Cualquier `5xx`/);
  });
});
