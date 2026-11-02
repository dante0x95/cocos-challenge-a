import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { withTx } from '../db/pool.js';
import { mapDbError } from '../db/errors.js';
import { MAX_CASH_MOVE_CENTS, MoneyError, toCents } from '../domain/money.js';

export const ordersRouter = Router();

// Decimal como string con a lo sumo 2 decimales; se rechaza, no se redondea (A §5.1).
// Se acepta number solo si es entero (JSON "100" y 100 significan lo mismo); 100.5 como number
// se rechaza porque un float no garantiza la escala.
const Decimal2 = z.union([z.string(), z.number().int()]).transform((v, ctx) => {
  const s = typeof v === 'number' ? String(v) : v.trim();
  try {
    toCents(s);
    return s;
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as MoneyError).message });
    return z.NEVER;
  }
});

const OrderBody = z.object({
  userid: z.number().int().positive(),
  side: z.enum(['BUY', 'SELL', 'CASH_IN', 'CASH_OUT']),
  type: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
  instrumentid: z.number().int().positive().optional(),
  size: z.number().int().positive().optional(),
  amount: Decimal2.optional(),   // pesos (D-003)
  price: Decimal2.optional(),    // solo LIMIT
}).strict();

export type OrderBody = z.infer<typeof OrderBody>;

/** Hash del body canonizado (claves ordenadas) para la idempotencia (A §7.2). */
export function requestHash(body: unknown): string {
  const canon = JSON.stringify(body, Object.keys(body as object).sort());
  return createHash('sha256').update(canon).digest('hex');
}

/** Validaciones que no necesitan la DB. Devuelve el mensaje de error o null. */
export function validateOrder(b: OrderBody): string | null {
  const isCash = b.side === 'CASH_IN' || b.side === 'CASH_OUT';
  if ((b.size === undefined) === (b.amount === undefined)) return 'enviar size o amount, exactamente uno';
  if (b.type === 'MARKET' && b.price !== undefined) return 'MARKET no admite price';
  if (b.type === 'LIMIT' && b.price === undefined) return 'LIMIT requiere price';
  if (isCash) {
    if (b.type !== 'MARKET') return 'un movimiento cash es MARKET';
    if (b.size !== undefined) return 'para CASH_IN/CASH_OUT enviar amount en pesos, no size';
    if (b.instrumentid !== undefined) return 'un movimiento cash no lleva instrumentid';
    if (toCents(b.amount as string) > MAX_CASH_MOVE_CENTS) {
      return 'amount supera el máximo por movimiento (21474836.47)';
    }
  } else if (b.instrumentid === undefined) {
    return 'instrumentid obligatorio para BUY/SELL';
  }
  return null;
}

// POST /orders — valida, abre transacción con presupuesto, llama app.place_order (A §6).
ordersRouter.post('/orders', async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key || key.length > 200) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'cabecera Idempotency-Key obligatoria' });
    return;
  }
  const parsed = OrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  const body = parsed.data;
  const invalid = validateOrder(body);
  if (invalid) {
    res.status(400).json({ error: 'BAD_REQUEST', message: invalid });
    return;
  }

  const isCash = body.side === 'CASH_IN' || body.side === 'CASH_OUT';
  const hash = requestHash(body);

  try {
    const result = await withTx(async (c) => {
      const arsId = isCash
        ? (await c.query<{ id: number }>("SELECT id FROM app.instruments WHERE ticker = 'ARS'")).rows[0].id
        : (body.instrumentid as number);
      const { rows } = await c.query<{ place_order: PlaceOrderResult }>(
        'SELECT app.place_order($1, $2, $3, $4, $5, $6, $7, $8, $9) AS place_order',
        [body.userid, key, hash, body.side, body.type, arsId,
          body.size ?? null, body.amount ?? null, body.price ?? null],
      );
      return rows[0].place_order;
    }, { deadlineMs: Number(process.env.REQUEST_DEADLINE_MS ?? 4000) });

    res.set('Idempotent-Replay', result.replay ? 'true' : 'false');
    res.set('Location', `/orders/${result.order_id}`);
    res.status(result.status).json(result.body);
  } catch (err) {
    const e = mapDbError(err);
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    res.status(e.status).json({ error: e.code, message: e.message });
  }
});

interface PlaceOrderResult {
  status: number;
  body: Record<string, string | null>;
  replay: boolean;
  order_id: string;
}
