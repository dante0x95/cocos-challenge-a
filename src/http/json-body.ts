// Body JSON de la API. Un número del body se valida por su literal, no por el number que deja
// JSON.parse (D-13, issue #42): 999999999999999.99 llega como 1000000000000000 y pasaría por un
// entero exacto, con la orden grabada por otra cantidad. Solo se acepta un entero decimal, sin punto
// ni exponente; un monto con decimales va como string. Vale para cualquier número del body.
import express, { type ErrorRequestHandler } from 'express';
import { badRequest } from './errors.js';

const INTEGER_LITERAL = /^-?\d+$/;

export const NUMBER_LITERAL_MESSAGE =
  'número JSON con punto decimal o exponente; un entero va sin punto ni exponente (100) y un monto con decimales, como string ("100.50")';

/** Lo lanza el reviver; body-parser lo pasa a next() como el mismo objeto, con status 400. */
export class NumberLiteralError extends Error {}

/**
 * Reviver de JSON.parse. Node ≥ 22 le pasa en `context.source` el texto original de cada primitivo.
 * Sin ese texto (un Node anterior) rechaza todo número: nunca acepta uno que no pudo ver.
 */
export function integerLiteralsOnly(key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === 'number' && !INTEGER_LITERAL.test(context?.source ?? '')) {
    throw new NumberLiteralError(`${key || 'body'}: ${NUMBER_LITERAL_MESSAGE}`);
  }
  return value;
}

// Al arrancar, no en el primer request: sin context.source todo número del body daría 400.
if (JSON.parse('0', (_k, _v, c?: { source?: string }) => c?.source === '0') !== true) {
  throw new Error('JSON.parse no entrega context.source (requiere Node ≥ 22): no se puede validar el literal de los números del body (D-13)');
}

// Lo que no es un literal rechazado sigue al errorHandler como siempre (JSON inválido, body grande).
const numberLiteralErrors: ErrorRequestHandler = (err, _req, _res, next) =>
  next(err instanceof NumberLiteralError ? badRequest(err.message) : err);

/** express.json con el reviver, y la traducción de su rechazo a 400 BAD_REQUEST. */
export const jsonBody = (opts: { limit: string }) => [
  express.json({ limit: opts.limit, reviver: integerLiteralsOnly }),
  numberLiteralErrors,
];
