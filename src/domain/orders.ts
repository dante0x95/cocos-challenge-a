// Validación del body de POST /orders y vista de una orden.
// Lo que se valida acá es FORMA (tipos, combinaciones de campos). Lo que depende del estado
// (saldo, tenencia, precio vigente) se decide en app.place_order, bajo el lock (D-17).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_CASH_MOVE_CENTS, MoneyError, fromCents, toCents } from './money.js';

// Decimal con a lo sumo 2 decimales, como string. Se rechaza, no se redondea (D-13).
// Un number solo se acepta si es entero: 100.5 como number no garantiza la escala. Y solo dentro de
// ±2⁵³ − 1: un entero mayor ya llega redondeado desde JSON.parse (9007199254740993 → …992), así que
// se rechaza y se pide como string (issue #8). El tope de magnitud lo pone place_order (D-14).
// Sale canonizado a 2 decimales (100, "100.0" → "100.00"): el mismo monto da el mismo hash de idempotencia (D-19).
const Decimal2 = z.union([
  z.string(),
  z.number().int().safe('entero fuera del rango exacto de JSON (±2^53); enviarlo como string'),
]).transform((v, ctx) => {
  const s = typeof v === 'number' ? String(v) : v.trim();
  try {
    const cents = toCents(s);
    if (cents <= 0n) throw new MoneyError('debe ser > 0');
    return fromCents(cents);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as MoneyError).message });
    return z.NEVER;
  }
});

// Los ids y size son integer en Postgres: el tope es el de parseId (2³¹ − 1); sin él, un id mayor
// llegaba a app.place_order y respondía 500 (22003) en vez de 400 (issue #8). Los mensajes, en español
// como el resto de la API: los de Zod por defecto están en inglés.
export const Int4Id = z.number()
  .int('debe ser un entero')
  .positive('debe ser > 0')
  .max(2_147_483_647, 'debe ser ≤ 2147483647');

export const OrderBody = z.object({
  userid: Int4Id,
  side: z.enum(['BUY', 'SELL', 'CASH_IN', 'CASH_OUT']),
  type: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
  instrumentid: Int4Id.optional(),
  size: Int4Id.optional(),
  amount: Decimal2.optional(),   // pesos (D-11)
  price: Decimal2.optional(),    // solo LIMIT
}).strict();

export type OrderBody = z.infer<typeof OrderBody>;

/** Validaciones de combinación que no necesitan la base. Devuelve el mensaje o null. */
export function validateOrder(b: OrderBody): string | null {
  const isCash = b.side === 'CASH_IN' || b.side === 'CASH_OUT';
  if ((b.size === undefined) === (b.amount === undefined)) return 'enviar size o amount, exactamente uno';
  if (b.type === 'MARKET' && b.price !== undefined) return 'una orden MARKET no lleva price';
  if (b.type === 'LIMIT' && b.price === undefined) return 'una orden LIMIT requiere price';
  if (isCash) {
    if (b.type !== 'MARKET') return 'un movimiento de cash es MARKET';
    if (b.size !== undefined) return 'para CASH_IN/CASH_OUT enviar amount en pesos, no size';
    if (b.instrumentid !== undefined) return 'un movimiento de cash no lleva instrumentid';
    if (toCents(b.amount as string) > MAX_CASH_MOVE_CENTS) {
      return `amount supera el máximo por movimiento (${fromCents(MAX_CASH_MOVE_CENTS)})`;
    }
  } else if (b.instrumentid === undefined) {
    return 'instrumentid es obligatorio para BUY/SELL';
  }
  return null;
}

/** SHA-256 del body canonizado (claves ordenadas): dos JSON equivalentes dan el mismo hash (D-19). */
export function requestHash(body: Record<string, unknown>): string {
  const canon = JSON.stringify(body, Object.keys(body).sort());
  return createHash('sha256').update(canon).digest('hex');
}

/**
 * Transición del issue #4: el hash que calculaba la versión anterior, con amount y price tal como
 * llegaron (sin canonizar). null si coincide con el actual. Una clave grabada antes del despliegue
 * guarda ese hash; app.place_order lo acepta solo para reconocer esa clave, así que el mismo request
 * sigue dando replay. Las claves duran 24 h (D-19): pasado ese plazo desde el despliegue, esta
 * función, su uso y p_legacy_hash se pueden borrar.
 */
export function legacyRequestHash(body: OrderBody, raw: { amount?: unknown; price?: unknown }): string | null {
  const asSent = (v: unknown) => (typeof v === 'number' ? String(v) : String(v).trim());
  const old: Record<string, unknown> = { ...body };
  if (body.amount !== undefined) old.amount = asSent(raw.amount);
  if (body.price !== undefined) old.price = asSent(raw.price);
  const legacy = requestHash(old);
  return legacy === requestHash(body) ? null : legacy;
}

/** Fila de app.orders tal como llega de node-postgres. */
export interface OrderRow {
  id: number;
  userid: number;
  instrumentid: number;
  side: string;
  type: string;
  size: number;
  price: string;
  status: string;
  balance_seq: string | null;
  datetime: string;             // timestamp sin zona, en UTC: 'YYYY-MM-DD HH:MM:SS[.ffffff]'
  cancel_reason: 'USER' | 'LIMIT' | null;   // solo en CANCELLED (issue #21)
}

/** Misma forma que el body que devuelve POST /orders. */
export function orderView(o: OrderRow): Record<string, string | null> {
  return {
    id: String(o.id),
    userid: String(o.userid),
    instrumentid: String(o.instrumentid),
    side: o.side,
    type: o.type,
    size: String(o.size),
    price: o.price,
    amount: fromCents(BigInt(o.size) * toCents(o.price)),
    status: o.status,
    balance_seq: o.balance_seq,
    datetime: `${o.datetime.slice(0, 10)}T${o.datetime.slice(11, 19)}Z`,
    cancel_reason: o.cancel_reason,
  };
}
