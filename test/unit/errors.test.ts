// Traducción de errores de la base a HTTP (src/http/errors.ts).
import { describe, expect, it } from 'vitest';
import { fromDbError } from '../../src/http/errors.js';

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
