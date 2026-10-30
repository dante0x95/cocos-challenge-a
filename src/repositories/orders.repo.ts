import { pool } from '../db/pool.js';
import type { OrderRow } from '../domain/orders.js';

export interface PlaceOrderArgs {
  userid: number; key: string; hash: string; side: string; type: string;
  /** Transición del issue #4: hash de la versión anterior; solo reconoce claves existentes (D-19). */
  legacyHash: string | null;
  instrumentid: number | null; size: number | null; amount: string | null; price: string | null;
}

export interface PlaceOrderResult {
  status: number;
  body: Record<string, string | null>;
  replay: boolean;
  order_id: string;
}

const ORDER_COLS = 'id, userid, instrumentid, side, type, size, price, status, balance_seq, datetime, cancel_reason';

/**
 * Toda la decisión ocurre en app.place_order, bajo el lock del usuario. Una sola sentencia: su
 * statement_timeout es el presupuesto total (D-20). Para cash, `instrumentid` va NULL y la
 * función usa ARS.
 */
export async function placeOrder(a: PlaceOrderArgs): Promise<PlaceOrderResult> {
  const { rows } = await pool.query<{ r: PlaceOrderResult }>(
    'SELECT app.place_order($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r',
    [a.userid, a.key, a.hash, a.side, a.type, a.instrumentid, a.size, a.amount, a.price, a.legacyHash],
  );
  return rows[0].r;
}

/** La orden solo si es del usuario: una ajena y una inexistente dan lo mismo (D-26). */
export async function findOrder(id: number, userid: number): Promise<OrderRow | null> {
  const r = await pool.query<OrderRow>(`SELECT ${ORDER_COLS} FROM app.orders WHERE id = $1 AND userid = $2`, [id, userid]);
  return r.rows[0] ?? null;
}

export type CancelResult =
  | { ok: true; order: OrderRow }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_new'; order: OrderRow };

/** Cancela bajo el lock y recibe el motivo en la misma sentencia (D-20, D-26). */
export async function cancelOrder(userid: number, orderId: number): Promise<CancelResult> {
  const { rows } = await pool.query<OrderRow & { outcome: 'ok' | 'not_found' | 'not_new' }>(
    `SELECT outcome, ${ORDER_COLS} FROM app.cancel_order_outcome($1, $2)`, [userid, orderId]);
  const { outcome, ...order } = rows[0];
  if (outcome === 'not_found') return { ok: false, reason: 'not_found' };
  if (outcome === 'not_new') return { ok: false, reason: 'not_new', order };
  return { ok: true, order };
}
