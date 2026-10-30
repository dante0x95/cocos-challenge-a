import { Router } from 'express';
import { HttpError, badRequest, notFound, route } from '../http/errors.js';
import { OrderBody, legacyRequestHash, orderView, requestHash, validateOrder } from '../domain/orders.js';
import { cancelOrder, findOrder, placeOrder } from '../repositories/orders.repo.js';
import { parseId } from './portfolio.routes.js';
import { z } from 'zod';

export const ordersRouter = Router();

const formatIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

// POST /orders — docs/api/orders.md
ordersRouter.post('/orders', route(async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key || key.length > 200) throw badRequest('la cabecera Idempotency-Key es obligatoria (máximo 200 caracteres)');
  const parsed = OrderBody.safeParse(req.body);
  if (!parsed.success) throw badRequest(formatIssues(parsed.error));
  const body = parsed.data;
  const invalid = validateOrder(body);
  if (invalid) throw badRequest(invalid);

  const result = await placeOrder({
    userid: body.userid,
    key,
    hash: requestHash(body),
    // Transición (issue #4): una clave grabada antes del despliegue guarda el hash sin canonizar.
    // place_order lo acepta solo para reconocer esa clave, en la misma transacción y bajo el mismo lock.
    legacyHash: legacyRequestHash(body, req.body),
    side: body.side,
    type: body.type,
    instrumentid: body.side === 'CASH_IN' || body.side === 'CASH_OUT' ? null : body.instrumentid!,
    size: body.size ?? null,
    amount: body.amount ?? null,
    price: body.price ?? null,
  });
  res.set('Idempotent-Replay', String(result.replay));
  res.set('Location', `/orders/${result.order_id}?userid=${body.userid}`);
  res.status(result.status).json(result.body);
}));

// GET /orders/:id?userid= — userid obligatorio; una orden ajena responde igual que una inexistente (D-26, D-27)
ordersRouter.get('/orders/:id', route(async (req, res) => {
  const id = parseId(req.params.id, 'id');
  // Se lee de la query completa: req.query corta en 1000 parámetros y ocultaría un userid repetido más adelante.
  const raw = new URL(req.originalUrl, 'http://localhost').searchParams.getAll('userid');
  if (raw.length !== 1) throw badRequest('el parámetro userid es obligatorio (entero > 0, una sola vez)');
  const userid = parseId(raw[0], 'userid');
  const o = await findOrder(id, userid);
  if (!o) throw notFound(`orden ${id} inexistente para el usuario ${userid}`);
  res.json(orderView(o));
}));

// POST /orders/:id/cancel — body { userid } (D-26)
const CancelBody = z.object({ userid: z.number().int().positive() }).strict();

ordersRouter.post('/orders/:id/cancel', route(async (req, res) => {
  const id = parseId(req.params.id, 'id');
  const parsed = CancelBody.safeParse(req.body);
  if (!parsed.success) throw badRequest(formatIssues(parsed.error));
  const r = await cancelOrder(parsed.data.userid, id);
  if (r.ok) { res.json(orderView(r.order)); return; }
  if (r.reason === 'not_found') throw notFound(`orden ${id} inexistente para el usuario ${parsed.data.userid}`);
  throw new HttpError(409, 'NOT_CANCELLABLE', `solo se cancelan órdenes NEW; la orden ${id} está ${r.order.status}`,
    undefined, { order: orderView(r.order) });
}));
