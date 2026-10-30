// Traducción de errores de la base a HTTP (src/http/errors.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectionLostPhase, errorHandler, fromDbError } from '../../src/http/errors.js';

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
  it.each([
    ['ECONNRESET', 'read ECONNRESET', 'query'],
    ['EPIPE', 'write EPIPE', 'query'],
    ['ETIMEDOUT', 'connect ETIMEDOUT', 'query'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432', 'connect'],
    ['57P01', 'terminating connection due to administrator command', 'query'],
    ['57P02', 'terminating connection because of crash of another server process', 'query'],
    ['57P03', 'the database system is starting up', 'connect'],
    ['08000', 'connection exception', 'query'],
    ['08003', 'connection does not exist', 'query'],
    ['08006', 'connection failure', 'query'],
    ['08001', 'sqlclient unable to establish sqlconnection', 'connect'],
  ])('código %s → 503 CONNECTION_LOST con Retry-After 1 (fase %s)', (code, message, phase) => {
    const err = Object.assign(new Error(message), { code });
    const e = fromDbError(err);
    expect({ status: e.status, code: e.code, retryAfter: e.retryAfter }).toEqual(lost);
    expect(e.message).toMatch(/misma Idempotency-Key/);
    expect(connectionLostPhase(err)).toBe(phase);
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
