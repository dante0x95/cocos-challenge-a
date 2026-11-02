// Lo que lab/check.ts espera de cada variante, sin red ni archivos: así lo prueban test/unit/lab con
// datos chicos y controles que lo hacen fallar.
//   - expectedA: el oráculo de los tests (test/oracle/fold.ts) plegado sobre las órdenes del dataset:
//     lo que tiene que responder v2, y v3 byte a byte.
//   - expectedZ: la definición de costo de Z (lab/z/server.ts), calculada acá con enteros: Σ importes
//     de compra / Σ acciones compradas × cantidad. Z la calcula en float; se acepta la diferencia de
//     redondeo de ese cálculo, no otra.
import * as O from '../test/oracle/fold.js';

/** Una fila de orders.csv del dataset, ya parseada. price en centavos. */
export interface Row { id: string; userid: number; instrumentid: number; size: bigint; price: bigint; side: string; status: string; seq: bigint | null }

export const ORDERS_HEADER = 'id,instrumentid,userid,size,price,type,side,status,datetime,balance_seq';

export const cents = (price: string): bigint => {
  const [i, f = ''] = price.split('.');
  return BigInt(i + f.padEnd(2, '0'));
};

export function parseRow(line: string): Row {
  const f = line.split(',');
  return {
    id: f[0], instrumentid: Number(f[1]), userid: Number(f[2]), size: BigInt(f[3]), price: cents(f[4]),
    side: f[6], status: f[7], seq: f[9] ? BigInt(f[9]) : null,
  };
}

export const fmt = (v: bigint, scale: number): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
};

export interface ExpectedA {
  cash: string;
  reserved: string;
  positions: Map<number, { qty: string; cost: string; reserved: string }>;
}

/** El oráculo sobre las órdenes de un usuario: FILLED en orden de balance_seq; NEW como reservas. */
export function expectedA(rows: Row[]): ExpectedA {
  const s = O.newState();
  let reservedCash = 0n;
  const reservedShares = new Map<number, bigint>();
  const filled = rows.filter((r) => r.status === 'FILLED').sort((a, b) => (a.seq! < b.seq! ? -1 : 1));
  for (const r of filled) {
    if (r.side === 'CASH_IN') s.cashCents += r.size * r.price;
    else if (r.side === 'CASH_OUT') s.cashCents -= r.size * r.price;
    else O.fill(s, r.side as 'BUY' | 'SELL', r.instrumentid, r.size, r.price);
  }
  for (const r of rows.filter((x) => x.status === 'NEW')) {
    if (r.side === 'BUY') reservedCash += r.size * r.price;
    if (r.side === 'SELL') reservedShares.set(r.instrumentid, (reservedShares.get(r.instrumentid) ?? 0n) + r.size);
  }
  const positions = new Map<number, { qty: string; cost: string; reserved: string }>();
  for (const [i, p] of s.positions) {
    if (p.qty !== 0n) positions.set(i, { qty: p.qty.toString(), cost: fmt(p.cost, 6), reserved: (reservedShares.get(i) ?? 0n).toString() });
  }
  return { cash: fmt(s.cashCents, 2), reserved: fmt(reservedCash, 2), positions };
}

/** Costo de Z por instrumento, exacto: Σ importes de BUY FILLED (centavos) y Σ acciones compradas. */
export function expectedZ(rows: Row[]): Map<number, { boughtCents: bigint; boughtQty: bigint }> {
  const out = new Map<number, { boughtCents: bigint; boughtQty: bigint }>();
  for (const r of rows) {
    if (r.status !== 'FILLED' || r.side !== 'BUY') continue;
    const x = out.get(r.instrumentid) ?? { boughtCents: 0n, boughtQty: 0n };
    out.set(r.instrumentid, { boughtCents: x.boughtCents + r.size * r.price, boughtQty: x.boughtQty + r.size });
  }
  return out;
}

/** v2 (o v3) contra el oráculo. Devuelve las diferencias. */
export function compareA(id: number, p: any, e: ExpectedA): string[] {
  const out: string[] = [];
  if (p.cash?.neto !== e.cash) out.push(`${id}: cash.neto ${p.cash?.neto}, oráculo ${e.cash}`);
  if (p.cash?.reservado !== e.reserved) out.push(`${id}: cash.reservado ${p.cash?.reservado}, oráculo ${e.reserved}`);
  if (p.positions?.length !== e.positions.size) out.push(`${id}: ${p.positions?.length} posiciones, el oráculo ${e.positions.size}`);
  for (const pos of p.positions ?? []) {
    const x = e.positions.get(pos.instrumentid);
    if (!x) { out.push(`${id}: el instrumento ${pos.instrumentid} no está en el oráculo`); continue; }
    if (pos.qty !== x.qty || pos.costo_total !== x.cost || pos.acciones_reservadas !== x.reserved) {
      out.push(`${id}/${pos.instrumentid}: qty ${pos.qty} costo ${pos.costo_total} reservadas ${pos.acciones_reservadas}, oráculo ${x.qty} ${x.cost} ${x.reserved}`);
    }
  }
  return out;
}

const SAME_IN_Z = ['instrumentid', 'ticker', 'name', 'qty', 'acciones_reservadas', 'acciones_disponibles', 'price', 'price_date', 'valor', 'retorno_diario_pct', 'inconsistent'] as const;

/** `got` (un string decimal) a menos de `tol` de `want` (un número exacto como fracción num/den). */
function near(got: string | null, num: bigint, den: bigint, scale: number): boolean {
  if (got === null) return false;
  // got × den × 10^scale contra num × 10^scale, con un margen de 2 unidades de la última cifra:
  // el float de Z redondea en su última cifra significativa, no antes.
  const g = BigInt(got.replace('.', '').replace(/^(-?)0+(?=\d)/, '$1'));
  const pow = 10n ** BigInt(scale);
  const exact = num * pow;
  const diff = g * den - exact;
  const margin = 2n * den + (exact < 0n ? -exact : exact) / 10n ** 14n;
  return (diff < 0n ? -diff : diff) <= margin;
}

/**
 * v1 contra v2 y contra la definición de costo de Z. Todo lo que no depende del costo, igual a v2;
 * costo_total, costo_unitario, resultado y rendimiento_pct, iguales al promedio de compras.
 */
export function compareZ(id: number, z: any, a: any, ez: Map<number, { boughtCents: bigint; boughtQty: bigint }>): string[] {
  const out: string[] = [];
  for (const k of ['userid', 'valor_total', 'valuation_complete', 'has_inconsistent_history'] as const) {
    if (z[k] !== a[k]) out.push(`${id}: v1 ${k} ${z[k]}, v2 ${a[k]}`);
  }
  for (const k of ['neto', 'reservado', 'disponible'] as const) {
    if (z.cash?.[k] !== a.cash?.[k]) out.push(`${id}: v1 cash.${k} ${z.cash?.[k]}, v2 ${a.cash?.[k]}`);
  }
  if (z.positions?.length !== a.positions?.length) {
    out.push(`${id}: v1 tiene ${z.positions?.length} posiciones, v2 ${a.positions?.length}`);
    return out;
  }
  z.positions.forEach((zp: any, i: number) => {
    const ap = a.positions[i];
    for (const k of SAME_IN_Z) if (zp[k] !== ap[k]) out.push(`${id}/${ap.instrumentid}: v1 ${k} ${zp[k]}, v2 ${ap[k]}`);
    const b = ez.get(zp.instrumentid);
    if (!b || b.boughtQty === 0n) { out.push(`${id}/${zp.instrumentid}: v1 tiene una posición sin compras`); return; }
    const qty = BigInt(zp.qty);
    // costo = bought/boughtQty × qty, en ARS: (centavos × qty) / (boughtQty × 100)
    const costNum = b.boughtCents * qty;
    const costDen = b.boughtQty * 100n;
    if (!near(zp.costo_total, costNum, costDen, 6)) out.push(`${id}/${zp.instrumentid}: v1 costo_total ${zp.costo_total}, promedio de compras ${fmt((costNum * 1_000_000n) / costDen, 6)}`);
    if (qty > 0n && !near(zp.costo_unitario, b.boughtCents, b.boughtQty * 100n, 4)) out.push(`${id}/${zp.instrumentid}: v1 costo_unitario ${zp.costo_unitario}`);
    if (zp.valor !== null && costNum > 0n) {
      const valorCents = cents(zp.valor);
      // resultado = valor − costo, en ARS
      if (!near(zp.resultado, valorCents * costDen - costNum * 100n, costDen * 100n, 2)) out.push(`${id}/${zp.instrumentid}: v1 resultado ${zp.resultado}`);
      // rendimiento = (valor − costo) / costo × 100
      if (!near(zp.rendimiento_pct, (valorCents * costDen - costNum * 100n) * 100n, costNum * 100n, 2)) out.push(`${id}/${zp.instrumentid}: v1 rendimiento_pct ${zp.rendimiento_pct}`);
    }
  });
  return out;
}

/** Posiciones en que el costo de Z difiere del de A (informativo: es la diferencia de método). */
export const zCostDiffers = (z: any, a: any): number =>
  z.positions.filter((zp: any, i: number) => zp.costo_total !== a.positions[i]?.costo_total).length;

/** Cada respuesta cronometrada: 200 y el mismo cuerpo que la primera. */
export function compareTimed(label: string, responses: { status: number; text: string }[]): string[] {
  const out: string[] = [];
  responses.forEach((r, i) => {
    if (r.status !== 200) out.push(`${label}: la request ${i + 1} respondió ${r.status}`);
    else if (r.text !== responses[0].text) out.push(`${label}: la request ${i + 1} no responde lo mismo que la primera`);
  });
  return out;
}
