// Oráculo: segunda implementación, independiente, del fold de costo (D-09, D-03) y de las
// reglas de autorización (D-08). No importa nada de src/ ni de db/: si la base y la API
// tuvieran el mismo bug, este archivo es el que lo delata. Deliberadamente simple y separado.
// Lo usan las pruebas de propiedad (test/property) y algunas unitarias.

export interface OraclePosition { qty: bigint; cost: bigint /* micro-ARS */; short: boolean /* en corto AHORA (qty < 0) */ }
export interface OracleOrder {
  id: bigint; side: 'BUY' | 'SELL'; type: 'LIMIT'; instrumentid: number; size: bigint; priceCents: bigint;
}
export interface OracleState {
  cashCents: bigint;
  positions: Map<number, OraclePosition>;
  pendingBuys: Map<bigint, OracleOrder>;   // NEW BUY  → reserva cash
  pendingSells: Map<bigint, OracleOrder>;  // NEW SELL → reserva acciones
}

export function newState(): OracleState {
  return { cashCents: 0n, positions: new Map(), pendingBuys: new Map(), pendingSells: new Map() };
}

function roundHalfEvenDiv(a: bigint, b: bigint): bigint {
  const q = a / b, r = a % b;
  if (r * 2n < b) return q;
  if (r * 2n > b) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}

/** D-11: acciones que compra o vende `amount` a `price`, ambos en centavos: división entera, sin redondeo. */
export function sizeFromAmount(amountCents: bigint, priceCents: bigint): bigint {
  return amountCents / priceCents;
}

export function reservedCash(s: OracleState): bigint {
  let t = 0n;
  for (const o of s.pendingBuys.values()) t += o.size * o.priceCents;
  return t;
}
export function reservedShares(s: OracleState, instrumentid: number): bigint {
  let t = 0n;
  for (const o of s.pendingSells.values()) if (o.instrumentid === instrumentid) t += o.size;
  return t;
}
export function available(s: OracleState): bigint { return s.cashCents - reservedCash(s); }
export function position(s: OracleState, i: number): OraclePosition {
  return s.positions.get(i) ?? { qty: 0n, cost: 0n, short: false };
}

/** Aplica una ejecución (FILLED) al estado. Exportada para sembrar historia heredada. */
export function fill(s: OracleState, side: 'BUY' | 'SELL', instrumentid: number, size: bigint, priceCents: bigint) {
  const imp = size * priceCents;
  const p = { ...position(s, instrumentid) };
  if (side === 'BUY') {
    s.cashCents -= imp;
    // D-03: cubrir un corto heredado no lleva costo; solo el excedente abre posición.
    if (p.qty < 0n) { const opens = size + p.qty > 0n ? size + p.qty : 0n; p.cost = opens * priceCents * 10_000n; }
    else p.cost += imp * 10_000n;
    p.qty += size;
    if (p.qty <= 0n) p.cost = 0n;
    p.short = p.qty < 0n;
  } else {
    s.cashCents += imp;
    if (size > p.qty) { p.qty -= size; p.cost = 0n; p.short = p.qty < 0n; }
    else {
      p.cost = roundHalfEvenDiv(p.cost * (p.qty - size), p.qty);
      p.qty -= size;
      if (p.qty === 0n) p.cost = 0n;
    }
  }
  s.positions.set(instrumentid, p);
}

export type Decision = 'FILLED' | 'NEW' | 'REJECTED';

/** Decide y aplica como lo haría place_order. Devuelve el status esperado. */
export function placeOrder(
  s: OracleState,
  o: { side: 'BUY' | 'SELL' | 'CASH_IN' | 'CASH_OUT'; type: 'MARKET' | 'LIMIT'; instrumentid: number; size: bigint; priceCents: bigint },
  newOrderId: bigint,
): Decision {
  const imp = o.size * o.priceCents;
  switch (o.side) {
    case 'CASH_IN':
      s.cashCents += imp; return 'FILLED';
    case 'CASH_OUT':
      if (available(s) >= imp) { s.cashCents -= imp; return 'FILLED'; }
      return 'REJECTED';
    case 'BUY':
      if (available(s) < imp) return 'REJECTED';
      if (o.type === 'MARKET') { fill(s, 'BUY', o.instrumentid, o.size, o.priceCents); return 'FILLED'; }
      s.pendingBuys.set(newOrderId, { id: newOrderId, side: 'BUY', type: 'LIMIT', instrumentid: o.instrumentid, size: o.size, priceCents: o.priceCents });
      return 'NEW';
    case 'SELL':
      if (position(s, o.instrumentid).qty - reservedShares(s, o.instrumentid) < o.size) return 'REJECTED';
      if (o.type === 'MARKET') { fill(s, 'SELL', o.instrumentid, o.size, o.priceCents); return 'FILLED'; }
      s.pendingSells.set(newOrderId, { id: newOrderId, side: 'SELL', type: 'LIMIT', instrumentid: o.instrumentid, size: o.size, priceCents: o.priceCents });
      return 'NEW';
  }
}

/** execute_limit: cruza si BUY close ≤ límite, SELL close ≥ límite. Devuelve lo que la DB debe devolver. */
export function executeLimit(s: OracleState, id: bigint, closeCents: bigint): boolean {
  const b = s.pendingBuys.get(id);
  if (b) {
    if (closeCents > b.priceCents) return false;
    s.pendingBuys.delete(id);
    fill(s, 'BUY', b.instrumentid, b.size, b.priceCents);   // al precio límite
    return true;
  }
  const sl = s.pendingSells.get(id);
  if (sl) {
    if (closeCents < sl.priceCents) return false;
    s.pendingSells.delete(id);
    fill(s, 'SELL', sl.instrumentid, sl.size, sl.priceCents);
    return true;
  }
  return false;
}

export function cancelOrder(s: OracleState, id: bigint): boolean {
  return s.pendingBuys.delete(id) || s.pendingSells.delete(id);
}
